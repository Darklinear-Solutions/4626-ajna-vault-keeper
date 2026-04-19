import { type ResolvedArkSettings } from '../utils/config';
import { log } from '../utils/logger';
import { toWad } from '../utils/decimalConversion';
import { poolBalanceCap } from '../ajna/utils/poolBalanceCap';
import { getGasWithBuffer, handleTransaction, type TransactionData } from '../utils/transaction';
import { getPrice } from '../oracle/price';
import { poolHasBadDebt } from '../subgraph/poolHealth';
import { createVault } from '../ark/vault';
import { type Address } from 'viem';

const haltedArks = new Set<Address>();
let vault: ReturnType<typeof createVault>;
let _settings: ResolvedArkSettings;

// ============= Types =============

type KeeperRunData = {
  buckets: readonly bigint[];
  bufferTotal: bigint;
  bufferTarget: bigint;
  lup: BucketPrice;
  htp: BucketPrice;
  price: bigint;
  optimalBucket: bigint;
  minAmount: bigint;
};

type BucketPrice = {
  price: bigint;
  index: bigint;
};

type MoveOperation = {
  from: bigint | 'Buffer';
  to: bigint | 'Buffer';
  amount: bigint;
  bucketIndex?: number;
};

// ============= Main Run Function =============

export async function arkRun(
  address: Address,
  vaultAuthAddress: Address,
  settings: ResolvedArkSettings,
) {
  vault = createVault(address, vaultAuthAddress);
  _settings = settings;

  if (isCurrentArkHalted()) return logRunExit('keeper halted');
  if (await vault.isPaused()) return logRunExit('vault is currently paused');
  if (await poolHasBadDebt(vault, _settings.maxAuctionAge)) return logRunExit('pool has bad debt');

  const gas = await getGasWithBuffer('pool', 'updateInterest', [], await vault.getPoolAddress());
  await handleTransaction(vault.updateInterest(gas), {
    action: 'updateInterest',
    ark: vault.getAddress(),
  });
  const data = await _getKeeperData();
  await handleTransaction(vault.drain(data.optimalBucket), {
    action: 'drain',
    bucket: data.optimalBucket,
    ark: vault.getAddress(),
  });

  if (!(await isOptimalBucketInRange(data)))
    return logRunExit('optimal bucket is not in interest-earning range');
  if (await isOptimalBucketDusty(data)) return logRunExit('optimal bucket is dusty');
  if (await isOptimalBucketRecentlyBankrupt(data))
    return logRunExit('optimal bucket was recently bankrupt');
  if (await vault.isBucketDebtLocked(data.optimalBucket))
    return logRunExit('optimal bucket debt is locked due to pending auction');
  if (await optimalBucketHasCollateral(data)) return logRunExit('optimal bucket has collateral');

  await rebalanceBuckets(data);
  await rebalanceBuffer(data);
  await logFinalState(data);
}

// ============= Core Rebalancing Functions =============

async function rebalanceBuckets(data: KeeperRunData): Promise<void> {
  let bufferNeeded = await _calculateBufferDeficit(data);

  for (let i = 0; i < data.buckets.length; i++) {
    if (isCurrentArkHalted()) return;

    const bucket = data.buckets[i]!;
    await handleTransaction(vault.drain(bucket), {
      action: 'drain',
      bucket,
      ark: vault.getAddress(),
    });

    const bucketValue = await vault.lpToValue(bucket);
    const amountToMove = await poolBalanceCap(bucketValue, vault);
    if (await shouldSkipBucket(bucket, amountToMove, data)) continue;

    const operations = planBucketOperations(bucket, amountToMove, bufferNeeded, data, i);
    let results = [];

    for (const op of operations) {
      const txData = await executeMoveOperation(op);
      results.push(txData);

      if (op.to === 'Buffer' && txData?.status) {
        bufferNeeded = await _calculateBufferDeficit(data);
      }
    }
  }
}

async function rebalanceBuffer(data: KeeperRunData): Promise<void> {
  if (isCurrentArkHalted()) return;

  await _refreshBufferValues(data);

  const difference = data.bufferTotal - data.bufferTarget;
  const abs = difference >= 0n ? difference : -difference;

  if (abs <= _settings.bufferPadding + data.minAmount) return;

  if (difference > 0n) {
    const amount = difference - _settings.bufferPadding;
    await moveExcessFromBuffer(amount, data.optimalBucket);
  } else {
    const amount = await poolBalanceCap(-difference - _settings.bufferPadding, vault);
    await fillBufferDeficit(amount, data);
  }
}

// ============= Operation Planning =============

function planBucketOperations(
  bucket: bigint,
  amountToMove: bigint,
  bufferNeeded: bigint,
  data: KeeperRunData,
  bucketIndex: number,
): MoveOperation[] {
  const operations: MoveOperation[] = [];

  if (bufferNeeded <= data.minAmount) {
    operations.push({
      from: bucket,
      to: data.optimalBucket,
      amount: amountToMove,
      bucketIndex,
    });
  } else if (bufferNeeded >= amountToMove) {
    operations.push({
      from: bucket,
      to: 'Buffer',
      amount: amountToMove,
      bucketIndex,
    });
  } else {
    operations.push({
      from: bucket,
      to: 'Buffer',
      amount: bufferNeeded,
      bucketIndex,
    });
    operations.push({
      from: bucket,
      to: data.optimalBucket,
      amount: amountToMove - bufferNeeded,
      bucketIndex,
    });
  }

  return operations;
}

// ============= Move Execution =============

async function executeMoveOperation(op: MoveOperation): Promise<TransactionData | undefined> {
  if (isCurrentArkHalted()) return;
  if (op.from === 'Buffer') {
    const gas = await getGasWithBuffer(
      'vault',
      'moveFromBuffer',
      [op.to, op.amount],
      vault.getAddress(),
    );
    return await handleTransaction(vault.moveFromBuffer(op.to as bigint, op.amount, gas), {
      action: 'moveFromBuffer',
      to: op.to,
      amount: op.amount,
      ark: vault.getAddress(),
    });
  } else if (op.to === 'Buffer') {
    const gas = await getGasWithBuffer(
      'vault',
      'moveToBuffer',
      [op.from, op.amount],
      vault.getAddress(),
    );
    return await handleTransaction(vault.moveToBuffer(op.from, op.amount, gas), {
      action: 'moveToBuffer',
      from: op.from,
      amount: op.amount,
      ark: vault.getAddress(),
    });
  } else {
    const gas = await getGasWithBuffer(
      'vault',
      'move',
      [op.from, op.to, op.amount],
      vault.getAddress(),
    );
    return await handleTransaction(vault.move(op.from, op.to, op.amount, gas), {
      action: 'move',
      from: op.from,
      to: op.to,
      amount: op.amount,
      ark: vault.getAddress(),
    });
  }
}

async function moveExcessFromBuffer(amount: bigint, targetBucket: bigint): Promise<void> {
  if (isCurrentArkHalted()) return;
  await handleTransaction(vault.drain(targetBucket), {
    action: 'drain',
    bucket: targetBucket,
    ark: vault.getAddress(),
  });
  const gas = await getGasWithBuffer(
    'vault',
    'moveFromBuffer',
    [targetBucket, amount],
    vault.getAddress(),
  );
  await handleTransaction(vault.moveFromBuffer(targetBucket, amount, gas), {
    action: 'moveFromBuffer',
    to: targetBucket,
    amount: amount,
    ark: vault.getAddress(),
  });
}

async function fillBufferDeficit(needed: bigint, data: KeeperRunData): Promise<void> {
  if (isCurrentArkHalted()) return;
  let remaining = needed;

  for (let i = 0; i < data.buckets.length && remaining > data.minAmount; i++) {
    if (isCurrentArkHalted()) return;

    const bucket = data.buckets[i]!;
    await handleTransaction(vault.drain(bucket), {
      action: 'drain',
      bucket,
      ark: vault.getAddress(),
    });
    const bucketValue = await vault.lpToValue(bucket);

    if (bucketValue < data.minAmount) continue;

    const amountToMove = await poolBalanceCap(
      bucketValue >= remaining ? remaining : bucketValue,
      vault,
    );

    const gas = await getGasWithBuffer(
      'vault',
      'moveToBuffer',
      [bucket, amountToMove],
      vault.getAddress(),
    );
    const txData = await handleTransaction(vault.moveToBuffer(bucket, amountToMove, gas), {
      action: 'moveToBuffer',
      from: bucket,
      amount: amountToMove,
      ark: vault.getAddress(),
    });

    if (txData?.status) remaining -= txData?.assets;
  }
}

// ============= Validation =============

async function shouldSkipBucket(
  bucket: bigint,
  amountToMove: bigint,
  data: KeeperRunData,
): Promise<boolean> {
  if (amountToMove <= 0n) return true;
  if (bucket === data.optimalBucket) return true;
  if (amountToMove < _settings.minMoveAmount) return true;

  const bucketPrice = await vault.getIndexToPrice(bucket);
  return await isBucketInRange(bucketPrice, data);
}

export async function isBucketInRange(bucketPrice: bigint, data: KeeperRunData): Promise<boolean> {
  const minBucketIndex = await vault.getMinBucketIndex();
  let minBucketPrice: bigint;
  if (minBucketIndex !== 0n) {
    minBucketPrice = await vault.getIndexToPrice(minBucketIndex);
  }

  const minThresholdToEarn = data.htp.price <= data.lup.price ? data.htp.price : data.lup.price;
  const maxThresholdToEarn =
    minBucketIndex === 0n
      ? data.price
      : data.price <= minBucketPrice!
        ? data.price
        : minBucketPrice!;

  return bucketPrice >= minThresholdToEarn && bucketPrice <= maxThresholdToEarn;
}

export async function isOptimalBucketInRange(data: KeeperRunData): Promise<boolean> {
  const optimalBucketPrice = await vault.getIndexToPrice(data.optimalBucket);
  return await isBucketInRange(optimalBucketPrice, data);
}

async function isOptimalBucketDusty(data: KeeperRunData): Promise<boolean> {
  const bucketLps = await vault.getBucketLps(data.optimalBucket);
  const dustThreshold = await vault.getDustThreshold();
  return bucketLps !== 0n && bucketLps < dustThreshold;
}

async function isOptimalBucketRecentlyBankrupt(data: KeeperRunData): Promise<boolean> {
  const bankruptcyTimestamp = await vault.getBankruptcyTime(data.optimalBucket);

  if (_settings.minTimeSinceBankruptcy === 0n) return bankruptcyTimestamp > 0n;

  return (
    bankruptcyTimestamp > 0n &&
    BigInt(Math.floor(Date.now() / 1000)) - bankruptcyTimestamp < _settings.minTimeSinceBankruptcy
  );
}

async function optimalBucketHasCollateral(data: KeeperRunData): Promise<boolean> {
  const bucketInfo = await vault.getBucketInfo(data.optimalBucket);
  const collateral = bucketInfo[2];

  return collateral > 0n;
}

// ============= Data Fetching =============

export async function _getKeeperData(): Promise<KeeperRunData> {
  const [initialBuckets, bufferTotal, lup, htp, price] = await Promise.all([
    vault.getBuckets(),
    vault.getBufferTotal(),
    vault.getLup(),
    vault.getHtp(),
    getPrice(),
  ]);

  for (let i = 0; i < initialBuckets.length; i++) {
    await handleTransaction(vault.drain(initialBuckets[i]), {
      action: 'drain',
      bucket: initialBuckets[i],
      ark: vault.getAddress(),
    });
  }

  const [lupIndex, htpIndex, optimalBucket, buckets, bufferTarget] = await Promise.all([
    vault.getPriceToIndex(lup),
    vault.getPriceToIndex(htp),
    _calculateOptimalBucket(price),
    vault.getBuckets(),
    _calculateBufferTarget(),
  ]);

  buckets.sort((a: bigint, b: bigint) => (a > b ? 1 : -1));

  return {
    buckets,
    bufferTotal,
    bufferTarget,
    lup: { price: lup, index: lupIndex },
    htp: { price: htp, index: htpIndex },
    price: BigInt(price),
    optimalBucket,
    minAmount: _settings.minMoveAmount,
  };
}

export async function _calculateOptimalBucket(price: bigint): Promise<bigint> {
  const currentPriceIndex = await vault.getPriceToIndex(price);
  return currentPriceIndex + _settings.optimalBucketDiff;
}

export async function _calculateBufferTarget(): Promise<bigint> {
  const [bufferRatio, totalAssets, assetDecimals] = await Promise.all([
    vault.getBufferRatio(),
    vault.getTotalAssets(),
    vault.getAssetDecimals(),
  ]);

  return (toWad(totalAssets, assetDecimals) * bufferRatio) / 10000n;
}

async function _calculateBufferDeficit(data: KeeperRunData): Promise<bigint> {
  await _refreshBufferValues(data);
  const deficit = data.bufferTarget - data.bufferTotal;
  if (data.bufferTotal >= data.bufferTarget) return 0n;

  return deficit > _settings.bufferPadding ? deficit - _settings.bufferPadding : 0n;
}

async function _refreshBufferValues(data: KeeperRunData) {
  [data.bufferTotal, data.bufferTarget] = await Promise.all([
    vault.getBufferTotal(),
    _calculateBufferTarget(),
  ]);
}

// ============= Helpers =============

export function initArkKeeper(
  address: Address,
  vaultAuthAddress: Address,
  settings: ResolvedArkSettings,
) {
  vault = createVault(address, vaultAuthAddress);
  _settings = settings;
}

export function isArkHalted(address: Address): boolean {
  return haltedArks.has(address);
}

export function haltKeeper(address?: Address) {
  const ark = address ?? vault?.getAddress?.();
  if (!ark || haltedArks.has(ark)) return;

  haltedArks.add(ark);
  log.warn(
    { event: 'ark_run_halted', ark },
    `ark run halting due to LUPBelowHTP error for ark ${ark}`,
  );
}

function isCurrentArkHalted(): boolean {
  return isArkHalted(vault.getAddress());
}

// ============= Logging =============

function logRunExit(reason: string) {
  log.error(
    { event: 'ark_run_aborted', ark: vault.getAddress(), reason },
    `ark run aborted for ark ${vault.getAddress()}`,
  );
}

async function logFinalState(data: KeeperRunData): Promise<void> {
  const finalBufferTotal = await vault.getBufferTotal();

  log.info(
    {
      event: 'ark_run_complete',
      ark: vault.getAddress(),
      bufferTotal: finalBufferTotal,
      bufferTarget: data.bufferTarget,
      quoteTokenPrice: data.price,
      optimalBucket: data.optimalBucket,
    },
    `ark run complete for ark ${vault.getAddress()}`,
  );
}
