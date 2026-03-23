import { config } from '../utils/config';
import { createVault } from '../ark/vault';
import { evaluateRates, type ArkEvaluation } from '../metavault/utils/evaluateRates';
import {
  getExpectedSupplyAssets,
  getTotalExpectedSupplyAssets,
  reallocate,
  type MarketAllocation,
} from '../metavault/metavault';
import { poolBalanceCap } from '../ajna/utils/poolBalanceCap';
import { log } from '../utils/logger';
import { handleTransaction, getGasWithBuffer } from '../utils/transaction';
import { selectBuckets } from '../ark/utils/selectBuckets';
import { type Address, maxUint256 } from 'viem';

// ============= Types =============

export type Ark = {
  vault: ReturnType<typeof createVault>;
  min: number | undefined;
  max: number | undefined;
  rate: bigint;
};

export type ArkAllocation = {
  id: Address;
  assets: bigint;
  initialAssets: bigint;
  vault: ReturnType<typeof createVault>;
  min: number;
  max: number;
  rate: bigint;
};

export type BufferAllocation = {
  id: Address;
  assets: bigint;
  initialAssets: bigint;
  allocation: number;
};

// ============= Main Run Function =============

export async function run() {
  const pausedArks = await _getPausedArks();
  if (pausedArks.length > 0) {
    return log.info(
      { event: 'paused_arks_detected', arks: pausedArks },
      'skipping run: one or more arks are paused',
    );
  }

  const strategyAddresses = [config.buffer.address, ...config.arks.map((ark) => ark.address)];
  const totalAssets = (await getTotalExpectedSupplyAssets(strategyAddresses)) as bigint;
  const arkAllocations = await _buildArkAllocations();
  const bufferAllocation = await _buildBufferAllocation();

  _rebalanceBuffer(arkAllocations, bufferAllocation, totalAssets);

  const arks = _toArks(arkAllocations);
  const evaluations = evaluateRates(arks);

  if (_isRateReallocationRequired(evaluations)) {
    _reallocateForRates(arkAllocations, evaluations, totalAssets);
  }

  await _executeMoveToBufferCalls(arkAllocations);

  const validationError = _validateAllocations(arkAllocations, bufferAllocation, totalAssets);
  if (validationError) return _logRunExit(validationError);

  const allocations = _buildFinalAllocations(arkAllocations, bufferAllocation);
  if (typeof allocations === 'string') return _logRunExit(allocations);

  if (allocations.length === 0) {
    return log.info(
      { event: 'no_metavault_reallocation_needed' },
      'no metavault reallocation needed',
    );
  }

  const gas = await getGasWithBuffer('metavault', 'reallocate', [allocations]);
  await handleTransaction(reallocate(allocations, gas), { action: 'reallocate' });

  log.info({ event: 'metavault_run_complete', allocations }, 'metavault run complete');
}

// ============= Initialization =============

async function _buildArkAllocations(): Promise<ArkAllocation[]> {
  const allocations: ArkAllocation[] = [];

  for (const arkConfig of config.arks) {
    const vault = createVault(arkConfig.address);
    const balance = (await getExpectedSupplyAssets(arkConfig.address)) as bigint;
    const cappedBalance = await poolBalanceCap(balance, vault);
    const rate = (await vault.getBorrowFeeRate()) as bigint;

    allocations.push({
      id: arkConfig.address,
      assets: cappedBalance,
      initialAssets: cappedBalance,
      vault,
      min: arkConfig.allocation.min,
      max: arkConfig.allocation.max,
      rate,
    });
  }

  return allocations;
}

async function _buildBufferAllocation(): Promise<BufferAllocation> {
  const balance = (await getExpectedSupplyAssets(config.buffer.address)) as bigint;

  return {
    id: config.buffer.address,
    assets: balance,
    initialAssets: balance,
    allocation: config.buffer.allocation,
  };
}

// ============= Buffer Rebalancing =============

export function _rebalanceBuffer(
  arks: ArkAllocation[],
  buffer: BufferAllocation,
  totalAssets: bigint,
): void {
  for (const ark of arks) {
    const maxAssets = (totalAssets * BigInt(ark.max)) / 100n;
    if (ark.assets > maxAssets) {
      const excess = ark.assets - maxAssets;
      ark.assets -= excess;
      buffer.assets += excess;
    }
  }

  const bufferTarget = (totalAssets * BigInt(buffer.allocation)) / 100n;

  if (buffer.assets < bufferTarget) {
    _fillBuffer(arks, buffer, bufferTarget, totalAssets);
  } else if (buffer.assets > bufferTarget) {
    _drainBuffer(arks, buffer, bufferTarget, totalAssets);
  }
}

function _fillBuffer(
  arks: ArkAllocation[],
  buffer: BufferAllocation,
  bufferTarget: bigint,
  totalAssets: bigint,
): void {
  let deficit = bufferTarget - buffer.assets;

  const sorted = [...arks].sort((a, b) => (a.rate < b.rate ? -1 : a.rate > b.rate ? 1 : 0));

  for (const ark of sorted) {
    if (deficit <= 0n) break;

    const minAssets = (totalAssets * BigInt(ark.min)) / 100n;
    const available = ark.assets - minAssets;
    if (available <= 0n) continue;

    const deduction = available < deficit ? available : deficit;
    if (deduction < config.minMoveAmount) continue;
    ark.assets -= deduction;
    buffer.assets += deduction;
    deficit -= deduction;
  }
}

function _drainBuffer(
  arks: ArkAllocation[],
  buffer: BufferAllocation,
  bufferTarget: bigint,
  totalAssets: bigint,
): void {
  let excess = buffer.assets - bufferTarget;

  const sorted = [...arks].sort((a, b) => (a.rate > b.rate ? -1 : a.rate < b.rate ? 1 : 0));

  for (const ark of sorted) {
    if (excess <= 0n) break;

    const maxAssets = (totalAssets * BigInt(ark.max)) / 100n;
    const capacity = maxAssets - ark.assets;
    if (capacity <= 0n) continue;

    const addition = capacity < excess ? capacity : excess;
    if (addition < config.minMoveAmount) continue;
    ark.assets += addition;
    buffer.assets -= addition;
    excess -= addition;
  }
}

// ============= Rate Reallocation =============

export function _isRateReallocationRequired(evaluations: ArkEvaluation[]): boolean {
  return evaluations.some((e) => e.targets.length > 0);
}

export function _reallocateForRates(
  arks: ArkAllocation[],
  evaluations: ArkEvaluation[],
  totalAssets: bigint,
): void {
  const sorted = [...arks].sort((a, b) => (a.rate < b.rate ? -1 : a.rate > b.rate ? 1 : 0));

  for (const ark of sorted) {
    const evaluation = evaluations.find((e) => e.address === ark.id);
    if (!evaluation || evaluation.targets.length === 0) continue;

    const minAssets = (totalAssets * BigInt(ark.min)) / 100n;
    let available = ark.assets - minAssets;
    if (available <= 0n) continue;

    for (const targetAddress of evaluation.targets) {
      if (available <= 0n) break;

      const target = arks.find((a) => a.id === targetAddress);
      if (!target) continue;

      const maxAssets = (totalAssets * BigInt(target.max)) / 100n;
      const capacity = maxAssets - target.assets;
      if (capacity <= 0n) continue;

      const moveAmount = available < capacity ? available : capacity;
      if (moveAmount < config.minMoveAmount) continue;
      ark.assets -= moveAmount;
      target.assets += moveAmount;
      available -= moveAmount;
    }
  }
}

// ============= MoveToBuffer Execution =============

async function _executeMoveToBufferCalls(arks: ArkAllocation[]): Promise<void> {
  for (const ark of arks) {
    if (ark.assets >= ark.initialAssets) continue;

    const amountToMove = ark.initialAssets - ark.assets;
    const bucketPlan = await selectBuckets(ark.vault, amountToMove);

    for (const { bucket, amount } of bucketPlan) {
      await handleTransaction(ark.vault.drain(bucket), { action: 'drain', bucket });
      const gas = await getGasWithBuffer('vault', 'moveToBuffer', [bucket, amount], ark.id);
      await handleTransaction(ark.vault.moveToBuffer(bucket, amount, gas), {
        action: 'moveToBuffer',
        from: bucket,
        amount,
        ark: ark.id,
      });
    }
  }
}

// ============= Validation =============

export function _validateAllocations(
  arks: ArkAllocation[],
  buffer: BufferAllocation,
  totalAssets: bigint,
): string | null {
  const tolerance = totalAssets / 1_000_000n || 1n;

  for (const ark of arks) {
    const minAssets = (totalAssets * BigInt(ark.min)) / 100n;
    const maxAssets = (totalAssets * BigInt(ark.max)) / 100n;

    if (ark.assets + tolerance < minAssets) {
      return `Ark ${ark.id} allocation ${ark.assets} is below min ${minAssets}`;
    }
    if (ark.assets > maxAssets + tolerance) {
      return `Ark ${ark.id} allocation ${ark.assets} is above max ${maxAssets}`;
    }
  }

  const bufferTarget = (totalAssets * BigInt(buffer.allocation)) / 100n;
  const allArksAtMax = arks.every(
    (ark) => ark.assets + tolerance >= (totalAssets * BigInt(ark.max)) / 100n,
  );

  if (allArksAtMax) {
    if (buffer.assets + tolerance < bufferTarget) {
      return `Buffer allocation ${buffer.assets} is below target ${bufferTarget} despite all arks at max`;
    }
  } else {
    const diff =
      buffer.assets > bufferTarget ? buffer.assets - bufferTarget : bufferTarget - buffer.assets;
    if (diff > tolerance) {
      return `Buffer allocation ${buffer.assets} does not equal target ${bufferTarget}`;
    }
  }

  return null;
}

// ============= Final Allocation Building =============

export function _buildFinalAllocations(
  arks: ArkAllocation[],
  buffer: BufferAllocation,
): MarketAllocation[] | string {
  const all: { id: Address; assets: bigint; initialAssets: bigint }[] = [
    ...arks.map((a) => ({ id: a.id, assets: a.assets, initialAssets: a.initialAssets })),
    { id: buffer.id, assets: buffer.assets, initialAssets: buffer.initialAssets },
  ];

  const decreasing = all.filter((a) => a.assets < a.initialAssets);
  const increasing = all.filter((a) => a.assets > a.initialAssets);

  if (decreasing.length === 0 && increasing.length === 0) return [];

  const totalWithdrawn = decreasing.reduce((sum, a) => sum + (a.initialAssets - a.assets), 0n);
  const totalSupplied = increasing.reduce((sum, a) => sum + (a.assets - a.initialAssets), 0n);
  if (totalWithdrawn !== totalSupplied) {
    return `inconsistent reallocation: totalWithdrawn (${totalWithdrawn}) != totalSupplied (${totalSupplied})`;
  }

  const ordered: MarketAllocation[] = [
    ...decreasing.map((a) => ({ id: a.id, assets: a.assets })),
    ...increasing.slice(0, -1).map((a) => ({ id: a.id, assets: a.assets })),
  ];

  if (increasing.length > 0) {
    ordered.push({ id: increasing[increasing.length - 1]!.id, assets: maxUint256 });
  }

  return ordered;
}

// ============= Helpers =============

function _logRunExit(reason: string) {
  log.error({ event: 'metavault_run_aborted', reason }, `metavault run aborted: ${reason}`);
}

function _toArks(allocations: ArkAllocation[]): Ark[] {
  return allocations.map((a) => ({
    vault: a.vault,
    min: a.min,
    max: a.max,
    rate: a.rate,
  }));
}

async function _getPausedArks(): Promise<Address[]> {
  const paused: Address[] = [];
  for (const arkConfig of config.arks) {
    const vault = createVault(arkConfig.address);
    if (await vault.isPaused()) {
      paused.push(arkConfig.address);
    }
  }
  return paused;
}
