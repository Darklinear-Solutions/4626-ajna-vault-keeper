import { env } from './utils/env';
import { log } from './utils/logger';
import { toWad } from './utils/decimalConversion';
import { getGasWithBuffer, handleTransaction, type TransactionData } from './utils/transaction';
import { getPrice } from './oracle/price';
import { poolHasBadDebt } from './subgraph/poolHealth';
import { getBufferTotal } from './vault/buffer';
import { getHtp, getIndexToPrice, getLup, getPriceToIndex } from './ajna/poolInfoUtils';
import { getBufferRatio, getMinBucketIndex } from './vault/vaultAuth';
import {
  getAssetDecimals,
  getBuckets,
  getTotalAssets,
  isPaused,
  move,
  moveFromBuffer,
  moveToBuffer,
  drain,
  getDustThreshold,
  lpToValue,
} from './vault/vault';
import {
  getBankruptcyTime,
  getBucketLps,
  updateInterest,
  isBucketDebtLocked,
  getPoolBalance,
} from './ajna/pool';

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

let halted = false;
export function haltKeeper() {
  halted = true;
  log.warn({ event: 'keeper_halted' }, 'keeper halting due to LUPBelowHTP error');
}

export async function run() {
  if (halted) return logRunExit('keeper halted');
  if (await isPaused()) return logRunExit('vault is currently paused');
  if (await poolHasBadDebt()) return logRunExit('pool has bad debt');

  await updateInterest();
  const data = await _getKeeperData();
  await drain(data.optimalBucket);

  if (!(await isOptimalBucketInRange(data)))
    return logRunExit('optimal bucket is not in interest-earning range');
  if (await isOptimalBucketDusty(data)) return logRunExit('optimal bucket is dusty');
  if (await isOptimalBucketRecentlyBankrupt(data))
    return logRunExit('optimal bucket was recently bankrupt');
  if (await isBucketDebtLocked(data.optimalBucket))
    return logRunExit('optimal bucket debt is locked due to pending auction');

  await rebalanceBuckets(data);
  await rebalanceBuffer(data);
  await logFinalState(data);
}

// ============= Core Rebalancing Functions =============

async function rebalanceBuckets(data: KeeperRunData): Promise<void> {
  let bufferNeeded = await _calculateBufferDeficit(data);

  for (let i = 0; i < data.buckets.length; i++) {
    const bucket = data.buckets[i]!;
    await drain(bucket);

    if (await shouldSkipBucket(bucket, data)) continue;

    const bucketValue = await lpToValue(bucket);
    const operations = planBucketOperations(bucket, bucketValue, bufferNeeded, data, i);
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
  await _refreshBufferValues(data);

  const difference = data.bufferTotal - data.bufferTarget;
  const abs = difference >= 0n ? difference : -difference;

  if (abs <= env.BUFFER_PADDING + data.minAmount) return;

  if (difference > 0n) {
    const amount = difference - env.BUFFER_PADDING;
    await moveExcessFromBuffer(amount, data.optimalBucket);
  } else {
    const bufferNeeded = -difference - env.BUFFER_PADDING;
    const poolBalance = await getPoolBalance();
    const amount = bufferNeeded > poolBalance ? poolBalance : bufferNeeded;

    await fillBufferDeficit(amount, data);
  }
}

// ============= Operation Planning =============

function planBucketOperations(
  bucket: bigint,
  bucketValue: bigint,
  bufferNeeded: bigint,
  data: KeeperRunData,
  bucketIndex: number,
): MoveOperation[] {
  const operations: MoveOperation[] = [];

  if (bufferNeeded < data.minAmount) {
    operations.push({
      from: bucket,
      to: data.optimalBucket,
      amount: bucketValue,
      bucketIndex,
    });
  } else if (bufferNeeded >= bucketValue) {
    operations.push({
      from: bucket,
      to: 'Buffer',
      amount: bucketValue,
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
      amount: bucketValue - bufferNeeded,
      bucketIndex,
    });
  }

  return operations;
}

// ============= Move Execution =============

async function executeMoveOperation(op: MoveOperation): Promise<TransactionData | undefined> {
  if (halted) return;
  if (op.from === 'Buffer') {
    const gas = await getGasWithBuffer('moveFromBuffer', [op.to, op.amount]);
    return await handleTransaction(moveFromBuffer(op.to as bigint, op.amount, gas), {
      action: 'moveFromBuffer',
      to: op.to,
      amount: op.amount,
    });
  } else if (op.to === 'Buffer') {
    const gas = await getGasWithBuffer('moveToBuffer', [op.from, op.amount]);
    return await handleTransaction(moveToBuffer(op.from, op.amount, gas), {
      action: 'moveToBuffer',
      from: op.from,
      amount: op.amount,
    });
  } else {
    const gas = await getGasWithBuffer('move', [op.from, op.to, op.amount]);
    return await handleTransaction(move(op.from, op.to, op.amount, gas), {
      action: 'move',
      from: op.from,
      to: op.to,
      amount: op.amount,
    });
  }
}

async function moveExcessFromBuffer(amount: bigint, targetBucket: bigint): Promise<void> {
  if (halted) return;
  await drain(targetBucket);
  const gas = await getGasWithBuffer('moveFromBuffer', [targetBucket, amount]);
  await handleTransaction(moveFromBuffer(targetBucket, amount, gas), {
    action: 'MoveFromBuffer',
    to: targetBucket,
    amount: amount,
  });
}

async function fillBufferDeficit(needed: bigint, data: KeeperRunData): Promise<void> {
  if (halted) return;
  let remaining = needed;

  for (let i = 0; i < data.buckets.length && remaining > data.minAmount; i++) {
    const bucket = data.buckets[i]!;
    await drain(bucket);
    const bucketValue = await lpToValue(bucket);

    if (bucketValue < data.minAmount) continue;

    const amountToMove = bucketValue >= remaining ? remaining : bucketValue;

    const gas = await getGasWithBuffer('moveToBuffer', [bucket, amountToMove]);
    const txData = await handleTransaction(moveToBuffer(bucket, amountToMove, gas), {
      action: 'MoveToBuffer',
      from: bucket,
      amount: amountToMove,
    });

    if (txData.status) remaining -= txData.assets;
  }
}

// ============= Validation Functions =============

async function shouldSkipBucket(bucket: bigint, data: KeeperRunData): Promise<boolean> {
  if (bucket === data.optimalBucket) return true;

  const bucketValue = await lpToValue(bucket);
  if (bucketValue < env.MIN_MOVE_AMOUNT) return true;

  const bucketPrice = await getIndexToPrice(bucket);
  return await isBucketInRange(bucketPrice, data);
}

export async function isBucketInRange(bucketPrice: bigint, data: KeeperRunData): Promise<boolean> {
  const minBucketIndex = await getMinBucketIndex();
  let minBucketPrice: bigint;
  if (minBucketIndex !== 0n) {
    minBucketPrice = await getIndexToPrice(minBucketIndex);
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
  const optimalBucketPrice = await getIndexToPrice(data.optimalBucket);
  return await isBucketInRange(optimalBucketPrice, data);
}

async function isOptimalBucketDusty(data: KeeperRunData): Promise<boolean> {
  const bucketLps = await getBucketLps(data.optimalBucket);
  const dustThreshold = await getDustThreshold();
  return bucketLps !== 0n && bucketLps < dustThreshold;
}

async function isOptimalBucketRecentlyBankrupt(data: KeeperRunData): Promise<boolean> {
  const bankruptcyTimestamp = await getBankruptcyTime(data.optimalBucket);

  if (env.MIN_TIME_SINCE_BANKRUPTCY === 0n) return bankruptcyTimestamp > 0n;

  return (
    bankruptcyTimestamp > 0n &&
    BigInt(Math.floor(Date.now() / 1000)) - bankruptcyTimestamp < env.MIN_TIME_SINCE_BANKRUPTCY
  );
}

// ============= Data Fetching =============

export async function _getKeeperData(): Promise<KeeperRunData> {
  const [initialBuckets, bufferTotal, lup, htp, price] = await Promise.all([
    getBuckets(),
    getBufferTotal(),
    getLup(),
    getHtp(),
    getPrice(),
  ]);

  for (let i = 0; i < initialBuckets.length; i++) {
    await drain(initialBuckets[i]);
  }

  const [lupIndex, htpIndex, optimalBucket, buckets, bufferTarget] = await Promise.all([
    getPriceToIndex(lup),
    getPriceToIndex(htp),
    _calculateOptimalBucket(price),
    getBuckets(),
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
    minAmount: env.MIN_MOVE_AMOUNT,
  };
}

export async function _calculateOptimalBucket(price: bigint): Promise<bigint> {
  const currentPriceIndex = await getPriceToIndex(price);
  return currentPriceIndex + env.OPTIMAL_BUCKET_DIFF;
}

export async function _calculateBufferTarget(): Promise<bigint> {
  const [bufferRatio, totalAssets, assetDecimals] = await Promise.all([
    getBufferRatio(),
    getTotalAssets(),
    getAssetDecimals(),
  ]);

  return (toWad(totalAssets, assetDecimals) * bufferRatio) / 10000n;
}

async function _calculateBufferDeficit(data: KeeperRunData): Promise<bigint> {
  await _refreshBufferValues(data);
  const deficit = data.bufferTarget - data.bufferTotal;
  if (data.bufferTotal >= data.bufferTarget) return 0n;

  return deficit > env.BUFFER_PADDING ? deficit - env.BUFFER_PADDING : 0n;
}

async function _refreshBufferValues(data: KeeperRunData) {
  [data.bufferTotal, data.bufferTarget] = await Promise.all([
    getBufferTotal(),
    _calculateBufferTarget(),
  ]);
}

// ============= Logging =============

function logRunExit(reason: string) {
  log.warn({ event: 'keeper_run_aborted', reason }, 'keeper run aborted');
}

async function logFinalState(data: KeeperRunData): Promise<void> {
  const finalBufferTotal = await getBufferTotal();

  log.info(
    {
      event: 'keeper_run_succeeded',
      bufferTotal: finalBufferTotal,
      bufferTarget: data.bufferTarget,
      quoteTokenPrice: data.price,
      optimalBucket: data.optimalBucket,
    },
    'keeper run complete',
  );
}
