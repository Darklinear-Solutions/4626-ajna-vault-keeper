import { config, resolveArkSettings } from '../utils/config.ts';
import { createVault } from '../ark/vault.ts';
import { isArkHalted } from './arkKeeper.ts';
import { evaluateRates, type ArkEvaluation } from '../metavault/utils/evaluateRates.ts';
import {
  getExpectedSupplyAssets,
  getTotalExpectedSupplyAssets,
  reallocate,
  type MarketAllocation,
} from '../metavault/metavault.ts';
import { poolBalanceCap } from '../ajna/utils/poolBalanceCap.ts';
import { poolHasBadDebt, SubgraphUnavailableError } from '../subgraph/poolHealth.ts';
import { log } from '../utils/logger.ts';
import { handleTransaction, getGasWithBuffer } from '../utils/transaction.ts';
import { selectBuckets, type BucketMove } from '../ark/utils/selectBuckets.ts';
import { toWad } from '../utils/decimalConversion.ts';
import { type Address, maxUint256 } from 'viem';

export const ACCRUAL_PAD_BPS = 5n;

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
  realInitialAssets: bigint;
  vault: ReturnType<typeof createVault>;
  min: number;
  max: number;
  rate: bigint;
  minMoveAmount: bigint;
  hasBadDebt: boolean;
};

export type BufferAllocation = {
  id: Address;
  assets: bigint;
  initialAssets: bigint;
  realInitialAssets: bigint;
  allocation: number;
};

// ============= Main Run Function =============

export async function metavaultRun() {
  try {
    const haltedArks = _getHaltedArks();
    if (haltedArks.length > 0) {
      return log.warn(
        { event: 'halted_arks_detected', arks: haltedArks },
        'skipping run: one or more arks are halted',
      );
    }

    const pausedArks = await _getPausedArks();
    if (pausedArks.length > 0) {
      return log.warn(
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

    const validationError = _validateAllocations(arkAllocations, bufferAllocation, totalAssets);
    if (validationError) return _logRunExit(validationError);

    const preview = _buildFinalAllocations(arkAllocations, bufferAllocation);
    if (typeof preview === 'string') return _logRunExit(preview);

    if (preview.length === 0) {
      return log.info(
        { event: 'no_metavault_reallocation_needed' },
        'no metavault reallocation needed',
      );
    }

    await _executeMoveToBufferCalls(arkAllocations);

    await _refreshRealInitialAssets(arkAllocations, bufferAllocation);

    const allocations = _buildFinalAllocations(arkAllocations, bufferAllocation);
    if (typeof allocations === 'string') return _logRunExit(allocations);

    const reallocateTx = await handleTransaction(reallocate(allocations, config.defaultGas), {
      action: 'reallocate',
    });
    if (!reallocateTx.status) return _logRunExit('reallocate failed');

    log.info({ event: 'metavault_run_complete', allocations }, 'metavault run complete');
  } catch (e) {
    if (e instanceof SubgraphUnavailableError) {
      log.error(
        { event: 'metavault_run_aborted', reason: 'subgraph unavailable', err: e },
        'metavault run aborted: subgraph unavailable',
      );
      return;
    }
    if (!(e instanceof RunAbortError)) throw e;
  }
}

// ============= Initialization =============

async function _buildArkAllocations(): Promise<ArkAllocation[]> {
  const allocations: ArkAllocation[] = [];

  for (const arkConfig of config.arks) {
    const vault = createVault(arkConfig.address);
    const settings = resolveArkSettings(arkConfig);
    const [balance, rate, badDebt] = await Promise.all([
      getExpectedSupplyAssets(arkConfig.address) as Promise<bigint>,
      vault.getBorrowFeeRate() as Promise<bigint>,
      poolHasBadDebt(vault, settings.maxAuctionAge),
    ]);
    const cappedBalance = await poolBalanceCap(balance, vault);

    allocations.push({
      id: arkConfig.address,
      assets: cappedBalance,
      initialAssets: cappedBalance,
      realInitialAssets: balance,
      vault,
      min: arkConfig.allocation.min,
      max: arkConfig.allocation.max,
      rate,
      minMoveAmount: settings.minMoveAmount,
      hasBadDebt: badDebt,
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
    realInitialAssets: balance,
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
  const bufferMinMoveAmount = BigInt(config.arkGlobal.minMoveAmount);

  if (buffer.assets < bufferTarget) {
    if (bufferTarget - buffer.assets >= bufferMinMoveAmount) {
      _fillBuffer(arks, buffer, bufferTarget, totalAssets);
    }
  } else if (buffer.assets > bufferTarget) {
    if (buffer.assets - bufferTarget >= bufferMinMoveAmount) {
      _drainBuffer(arks, buffer, bufferTarget, totalAssets);
    }
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
    if (deduction < ark.minMoveAmount) continue;
    ark.assets -= deduction;
    buffer.assets += deduction;
    deficit -= deduction;
  }

  if (deficit > 0n) {
    for (const ark of sorted) {
      if (deficit <= 0n) break;
      if (ark.assets <= 0n) continue;

      const deduction = ark.assets < deficit ? ark.assets : deficit;
      if (deduction < ark.minMoveAmount) continue;
      ark.assets -= deduction;
      buffer.assets += deduction;
      deficit -= deduction;
    }
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
    if (ark.hasBadDebt) continue;

    const maxAssets = (totalAssets * BigInt(ark.max)) / 100n;
    const capacity = maxAssets - ark.assets;
    if (capacity <= 0n) continue;

    const addition = capacity < excess ? capacity : excess;
    if (addition < ark.minMoveAmount) continue;
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
      if (!target || target.hasBadDebt) continue;

      const maxAssets = (totalAssets * BigInt(target.max)) / 100n;
      const capacity = maxAssets - target.assets;
      if (capacity <= 0n) continue;

      const moveAmount = available < capacity ? available : capacity;
      if (moveAmount < ark.minMoveAmount) continue;
      ark.assets -= moveAmount;
      target.assets += moveAmount;
      available -= moveAmount;
    }
  }
}

// ============= MoveToBuffer Execution =============

async function _executeMoveToBufferCalls(arks: ArkAllocation[]): Promise<void> {
  const plans: Array<{ ark: ArkAllocation; plan: BucketMove[] }> = [];

  for (const ark of arks) {
    if (ark.assets >= ark.initialAssets) continue;

    const assetDecimals = (await ark.vault.getAssetDecimals()) as number;
    const amountToMoveWad = toWad(ark.initialAssets - ark.assets, assetDecimals);
    const bucketPlan = await selectBuckets(ark.vault, amountToMoveWad);

    const plannedCoverage = bucketPlan.reduce((sum, p) => sum + p.amount, 0n);
    if (plannedCoverage < amountToMoveWad) {
      return _logRunExit(
        `bucket plan for ark ${ark.id} covers ${plannedCoverage} of planned decrease ${amountToMoveWad}`,
      );
    }

    plans.push({ ark, plan: bucketPlan });
  }

  for (const { ark, plan } of plans) {
    for (const { bucket, amount } of plan) {
      const drainTx = await handleTransaction(ark.vault.drain(bucket), {
        action: 'drain',
        bucket,
        ark: ark.id,
      });
      if (!drainTx.status) return _logRunExit(`drain failed for ark ${ark.id}`);

      const gas = await getGasWithBuffer('vault', 'moveToBuffer', [bucket, amount], ark.id);
      const moveTx = await handleTransaction(ark.vault.moveToBuffer(bucket, amount, gas), {
        action: 'moveToBuffer',
        from: bucket,
        amount,
        ark: ark.id,
      });

      if (!moveTx.status) return _logRunExit(`moveToBuffer failed for ark ${ark.id}`);
    }
  }
}

async function _refreshRealInitialAssets(
  arks: ArkAllocation[],
  buffer: BufferAllocation,
): Promise<void> {
  const balances = (await Promise.all([
    ...arks.map((ark) => getExpectedSupplyAssets(ark.id)),
    getExpectedSupplyAssets(buffer.id),
  ])) as bigint[];

  arks.forEach((ark, i) => {
    ark.realInitialAssets = balances[i]!;
  });
  buffer.realInitialAssets = balances[balances.length - 1]!;
}

// ============= Validation =============

export function _validateAllocations(
  arks: ArkAllocation[],
  buffer: BufferAllocation,
  totalAssets: bigint,
): string | null {
  const tolerance = totalAssets / 1_000_000n || 1n;
  const bufferTarget = (totalAssets * BigInt(buffer.allocation)) / 100n;
  const bufferAtTarget = buffer.assets >= bufferTarget || bufferTarget - buffer.assets <= tolerance;

  for (const ark of arks) {
    const minAssets = (totalAssets * BigInt(ark.min)) / 100n;
    const maxAssets = (totalAssets * BigInt(ark.max)) / 100n;

    if (ark.assets + tolerance < minAssets && !bufferAtTarget) {
      return `Ark ${ark.id} allocation ${ark.assets} is below min ${minAssets}`;
    }
    if (ark.assets > maxAssets + tolerance) {
      return `Ark ${ark.id} allocation ${ark.assets} is above max ${maxAssets}`;
    }
  }

  const allArksAtMax = arks.every(
    (ark) => ark.assets + tolerance >= (totalAssets * BigInt(ark.max)) / 100n,
  );

  if (allArksAtMax) {
    if (buffer.assets + tolerance < bufferTarget) {
      return `Buffer allocation ${buffer.assets} is below target ${bufferTarget} despite all arks at max`;
    }
  } else if (!bufferAtTarget) {
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
  const all = [
    ...arks.map((a) => ({
      id: a.id,
      delta: a.assets - a.initialAssets,
      realInitialAssets: a.realInitialAssets,
    })),
    {
      id: buffer.id,
      delta: buffer.assets - buffer.initialAssets,
      realInitialAssets: buffer.realInitialAssets,
    },
  ];

  for (const a of all) {
    if (a.delta < 0n && a.realInitialAssets < -a.delta) {
      return `refreshed real balance for ${a.id} (${a.realInitialAssets}) is below planned decrease (${-a.delta})`;
    }
  }

  const withTargets = all.map((a) => {
    const base = a.realInitialAssets + a.delta;
    let pad = 0n;
    if (a.delta < 0n) {
      const bpsPad = (a.realInitialAssets * ACCRUAL_PAD_BPS) / 10000n;
      const decrease = -a.delta;
      pad = bpsPad < decrease ? bpsPad : decrease;
    }
    return { id: a.id, delta: a.delta, finalTarget: base + pad };
  });

  const decreasing = withTargets.filter((a) => a.delta < 0n);
  const increasing = withTargets.filter((a) => a.delta > 0n);

  if (decreasing.length === 0 && increasing.length === 0) return [];

  const totalWithdrawn = decreasing.reduce((sum, a) => sum + -a.delta, 0n);
  const totalSupplied = increasing.reduce((sum, a) => sum + a.delta, 0n);
  if (totalWithdrawn !== totalSupplied) {
    return `inconsistent reallocation: totalWithdrawn (${totalWithdrawn}) != totalSupplied (${totalSupplied})`;
  }

  const ordered: MarketAllocation[] = [
    ...decreasing.map((a) => ({ id: a.id, assets: a.finalTarget })),
    ...increasing.slice(0, -1).map((a) => ({ id: a.id, assets: a.finalTarget })),
  ];

  if (increasing.length > 0) {
    ordered.push({ id: increasing[increasing.length - 1]!.id, assets: maxUint256 });
  }

  return ordered;
}

// ============= Helpers =============

class RunAbortError extends Error {}

function _logRunExit(reason: string): never {
  log.error({ event: 'metavault_run_aborted', reason }, `metavault run aborted: ${reason}`);
  throw new RunAbortError(reason);
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

function _getHaltedArks(): Address[] {
  return config.arks.filter((a) => isArkHalted(a.address)).map((a) => a.address);
}
