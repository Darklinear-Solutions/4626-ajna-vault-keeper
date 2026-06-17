import { config, resolveArkSettings } from '../utils/config.ts';
import { createVault } from '../ark/vault.ts';
import { isArkHalted } from './arkKeeper.ts';
import { evaluateRates, type ArkEvaluation } from '../metavault/utils/evaluateRates.ts';
import {
  getExpectedSupplyAssets,
  getSupplyCap,
  getTotalExpectedSupplyAssets,
  reallocate,
  type MarketAllocation,
} from '../metavault/metavault.ts';
import { poolBalanceCapAsset } from '../ajna/utils/poolBalanceCap.ts';
import { poolHasBadDebt, SubgraphUnavailableError } from '../subgraph/poolHealth.ts';
import { ChainTimeUnavailableError } from '../utils/chainTime.ts';
import { log } from '../utils/logger.ts';
import { handleTransaction, getGasWithBuffer } from '../utils/transaction.ts';
import { selectBuckets, type BucketMove } from '../ark/utils/selectBuckets.ts';
import { toWad, toWadTokenUnit } from '../utils/decimalConversion.ts';
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
  supplyCap: bigint;
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
  supplyCap: bigint;
  allocation: number;
};

type SupplyCappedAllocation = {
  assets: bigint;
  initialAssets: bigint;
  realInitialAssets: bigint;
  supplyCap: bigint;
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

    const preparedArks = await _executeMoveToBufferCalls(arkAllocations);

    await _refreshRealInitialAssets(arkAllocations, bufferAllocation);

    const allocations = _buildFinalAllocations(arkAllocations, bufferAllocation);
    if (typeof allocations === 'string') return _logRunExit(allocations);

    const unpreparedArk = _findUnpreparedArkWithdrawal(allocations, arkAllocations, preparedArks);
    if (unpreparedArk) {
      return _logRunExit(`ark ${unpreparedArk} has a withdrawal target without a prepared buffer`);
    }

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
    if (e instanceof ChainTimeUnavailableError) {
      log.error(
        { event: 'metavault_run_aborted', reason: 'chain time unavailable', err: e },
        'metavault run aborted: chain time unavailable',
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
    const [balance, supplyCap, rate, badDebt] = await Promise.all([
      getExpectedSupplyAssets(arkConfig.address) as Promise<bigint>,
      getSupplyCap(arkConfig.address),
      vault.getBorrowFeeRate() as Promise<bigint>,
      poolHasBadDebt(vault, settings.maxAuctionAge),
    ]);
    const cappedBalance = await poolBalanceCapAsset(balance, vault);

    allocations.push({
      id: arkConfig.address,
      assets: cappedBalance,
      initialAssets: cappedBalance,
      realInitialAssets: balance,
      supplyCap,
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
  const [balance, supplyCap] = (await Promise.all([
    getExpectedSupplyAssets(config.buffer.address),
    getSupplyCap(config.buffer.address),
  ])) as [bigint, bigint];

  return {
    id: config.buffer.address,
    assets: balance,
    initialAssets: balance,
    realInitialAssets: balance,
    supplyCap,
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
      const addition = min(excess, remainingSupplyCapacity(buffer));
      ark.assets -= addition;
      buffer.assets += addition;
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
  let deficit = receivableCapacity(buffer, bufferTarget);

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
    const capacity = receivableCapacity(ark, maxAssets);
    if (capacity <= 0n) continue;

    const addition = min(capacity, excess);
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
      const capacity = receivableCapacity(target, maxAssets);
      if (capacity <= 0n) continue;

      const moveAmount = min(available, capacity);
      if (moveAmount < ark.minMoveAmount) continue;
      ark.assets -= moveAmount;
      target.assets += moveAmount;
      available -= moveAmount;
    }
  }
}

// ============= MoveToBuffer Execution =============

async function _executeMoveToBufferCalls(arks: ArkAllocation[]): Promise<Set<Address>> {
  const plans: Array<{ ark: ArkAllocation; plan: BucketMove[] }> = [];
  const preparedArks = new Set<Address>();

  for (const ark of arks) {
    if (ark.assets >= ark.initialAssets) continue;

    const decrease = ark.initialAssets - ark.assets;
    if (_effectiveWithdrawal(ark.realInitialAssets, decrease) === 0n) continue;

    const assetDecimals = (await ark.vault.getAssetDecimals()) as number;
    const amountToMoveWad = toWad(decrease, assetDecimals);
    const assetUnitWad = toWadTokenUnit(assetDecimals);
    const bucketPlan = (await selectBuckets(ark.vault, amountToMoveWad)).filter(
      ({ amount }) => amount >= assetUnitWad,
    );

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
    preparedArks.add(ark.id);
  }

  return preparedArks;
}

async function _refreshRealInitialAssets(
  arks: ArkAllocation[],
  buffer: BufferAllocation,
): Promise<void> {
  const ids = [...arks.map((ark) => ark.id), buffer.id];
  const [balances, supplyCaps] = (await Promise.all([
    Promise.all(ids.map((id) => getExpectedSupplyAssets(id))),
    Promise.all(ids.map((id) => getSupplyCap(id))),
  ])) as [bigint[], bigint[]];

  arks.forEach((ark, i) => {
    ark.realInitialAssets = balances[i]!;
    ark.supplyCap = supplyCaps[i]!;
  });
  buffer.realInitialAssets = balances[balances.length - 1]!;
  buffer.supplyCap = supplyCaps[supplyCaps.length - 1]!;
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
    const supplyCapError = supplyCapErrorMessage('Ark', ark.id, ark);
    if (supplyCapError) return supplyCapError;
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

  const bufferSupplyCapError = supplyCapErrorMessage('Buffer', buffer.id, buffer);
  if (bufferSupplyCapError) return bufferSupplyCapError;

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
      supplyCap: a.supplyCap,
    })),
    {
      id: buffer.id,
      delta: buffer.assets - buffer.initialAssets,
      realInitialAssets: buffer.realInitialAssets,
      supplyCap: buffer.supplyCap,
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
      const decrease = -a.delta;
      pad = _accrualPad(a.realInitialAssets, decrease);
    }
    const finalTarget = base + pad;
    const effectiveWithdrawn =
      a.delta < 0n && a.realInitialAssets > finalTarget ? a.realInitialAssets - finalTarget : 0n;
    return {
      id: a.id,
      delta: a.delta,
      realInitialAssets: a.realInitialAssets,
      finalTarget,
      effectiveWithdrawn,
    };
  });

  const decreasing = withTargets.filter((a) => a.delta < 0n && a.effectiveWithdrawn > 0n);
  const increasing = withTargets.filter((a) => a.delta > 0n);

  if (decreasing.length === 0 && increasing.length === 0) return [];

  const totalWithdrawn = withTargets.reduce((sum, a) => (a.delta < 0n ? sum + -a.delta : sum), 0n);
  const totalSupplied = increasing.reduce((sum, a) => sum + a.delta, 0n);
  if (totalWithdrawn !== totalSupplied) {
    return `inconsistent reallocation: totalWithdrawn (${totalWithdrawn}) != totalSupplied (${totalSupplied})`;
  }

  const effectiveWithdrawn = decreasing.reduce((sum, a) => sum + a.effectiveWithdrawn, 0n);
  if (effectiveWithdrawn === 0n) {
    return `accrual pad absorbs planned withdrawals (${totalWithdrawn})`;
  }

  let remainingSupply = effectiveWithdrawn;
  const ordered: MarketAllocation[] = decreasing.map((a) => ({ id: a.id, assets: a.finalTarget }));

  for (const a of increasing.slice(0, -1)) {
    if (remainingSupply === 0n) break;
    const supply = a.delta < remainingSupply ? a.delta : remainingSupply;
    ordered.push({ id: a.id, assets: a.realInitialAssets + supply });
    remainingSupply -= supply;
  }

  if (increasing.length > 0) {
    ordered.push({ id: increasing[increasing.length - 1]!.id, assets: maxUint256 });
  }

  const simulated = _simulateEulerReallocationAccounting(ordered, all);
  if (simulated.capExceeded) {
    return `supply cap exceeded for ${simulated.capExceeded.id}: final assets ${simulated.capExceeded.finalAssets} > cap ${simulated.capExceeded.supplyCap}`;
  }
  if (simulated.totalWithdrawn !== simulated.totalSupplied) {
    return `inconsistent reallocation: totalWithdrawn (${simulated.totalWithdrawn}) != totalSupplied (${simulated.totalSupplied})`;
  }

  return ordered;
}

function _simulateEulerReallocationAccounting(
  allocations: MarketAllocation[],
  balances: Array<{ id: Address; realInitialAssets: bigint; supplyCap: bigint }>,
): {
  totalWithdrawn: bigint;
  totalSupplied: bigint;
  capExceeded?: { id: Address; finalAssets: bigint; supplyCap: bigint };
} {
  let totalWithdrawn = 0n;
  let totalSupplied = 0n;
  const balanceById = new Map(balances.map((a) => [a.id, a]));

  for (const allocation of allocations) {
    const balance = balanceById.get(allocation.id);
    const supplyAssets = balance?.realInitialAssets ?? 0n;
    const withdrawn = supplyAssets > allocation.assets ? supplyAssets - allocation.assets : 0n;
    if (withdrawn > 0n) {
      totalWithdrawn += withdrawn;
      continue;
    }

    const supplied =
      allocation.assets === maxUint256
        ? totalWithdrawn > totalSupplied
          ? totalWithdrawn - totalSupplied
          : 0n
        : allocation.assets > supplyAssets
          ? allocation.assets - supplyAssets
          : 0n;
    const finalAssets = supplyAssets + supplied;
    if (balance && supplied > 0n && finalAssets > balance.supplyCap) {
      return {
        totalWithdrawn,
        totalSupplied,
        capExceeded: { id: allocation.id, finalAssets, supplyCap: balance.supplyCap },
      };
    }
    totalSupplied += supplied;
  }

  return { totalWithdrawn, totalSupplied };
}

function receivableCapacity(allocation: SupplyCappedAllocation, maxAssets: bigint): bigint {
  if (allocation.assets >= maxAssets) return 0n;
  return min(maxAssets - allocation.assets, remainingSupplyCapacity(allocation));
}

function remainingSupplyCapacity(allocation: SupplyCappedAllocation): bigint {
  const neutralIncrease =
    allocation.assets < allocation.initialAssets
      ? allocation.initialAssets - allocation.assets
      : 0n;
  const plannedSupply =
    allocation.assets > allocation.initialAssets
      ? allocation.assets - allocation.initialAssets
      : 0n;
  const capSupply =
    allocation.supplyCap > allocation.realInitialAssets
      ? allocation.supplyCap - allocation.realInitialAssets
      : 0n;

  return neutralIncrease + (capSupply > plannedSupply ? capSupply - plannedSupply : 0n);
}

function plannedSupply(allocation: SupplyCappedAllocation): bigint {
  return allocation.assets > allocation.initialAssets
    ? allocation.assets - allocation.initialAssets
    : 0n;
}

function supplyCapErrorMessage(
  label: 'Ark' | 'Buffer',
  id: Address,
  allocation: SupplyCappedAllocation,
): string | null {
  const supply = plannedSupply(allocation);
  const cap =
    allocation.supplyCap > allocation.realInitialAssets
      ? allocation.supplyCap - allocation.realInitialAssets
      : 0n;
  return supply > cap
    ? `${label} ${id} planned supply ${supply} exceeds supply cap capacity ${cap}`
    : null;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function _accrualPad(realInitialAssets: bigint, decrease: bigint): bigint {
  const bpsPad = (realInitialAssets * ACCRUAL_PAD_BPS) / 10000n;
  return bpsPad < decrease ? bpsPad : decrease;
}

function _effectiveWithdrawal(realInitialAssets: bigint, decrease: bigint): bigint {
  return decrease - _accrualPad(realInitialAssets, decrease);
}

function _findUnpreparedArkWithdrawal(
  allocations: MarketAllocation[],
  arks: ArkAllocation[],
  preparedArks: Set<Address>,
): Address | null {
  const arkById = new Map(arks.map((ark) => [ark.id, ark]));

  for (const allocation of allocations) {
    const ark = arkById.get(allocation.id);
    if (!ark) continue;
    if (allocation.assets !== maxUint256 && ark.realInitialAssets > allocation.assets) {
      if (!preparedArks.has(ark.id)) return ark.id;
    }
  }

  return null;
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
