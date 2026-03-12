/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { run } from '../../src/keepers/metavaultKeeper';
import {
  getExpectedSupplyAssets,
  getTotalExpectedSupplyAssets,
} from '../../src/metavault/metavault';
import { config } from '../../src/utils/config';
import { client } from '../../src/utils/client';
import { type Address } from 'viem';

describe('metavault keeper run', () => {
  let snapshot: string;

  const getStrategyAddresses = (): Address[] => [
    config.buffer.address,
    ...config.arks.map((ark) => ark.address),
  ];

  const getBalances = async () => {
    const bufferBalance = await getExpectedSupplyAssets(config.buffer.address);
    const arkBalances = await Promise.all(
      config.arks.map((ark) => getExpectedSupplyAssets(ark.address)),
    );
    const totalAssets = await getTotalExpectedSupplyAssets(getStrategyAddresses());
    return { bufferBalance, arkBalances, totalAssets };
  };

  beforeAll(async () => {
    snapshot = await client.request({ method: 'evm_snapshot' as any, params: [] as any });
  });

  afterAll(async () => {
    await client.request({ method: 'evm_revert' as any, params: [snapshot] as any });
  });

  beforeEach(async () => {
    await client.request({ method: 'evm_revert' as any, params: [snapshot] as any });
    snapshot = await client.request({ method: 'evm_snapshot' as any, params: [] as any });
  });

  it('reallocates from buffer to arks when buffer holds all funds', async () => {
    const before = await getBalances();

    // Verify initial state: all funds in buffer, arks empty
    expect(Number(before.bufferBalance) / 1e18).toBeCloseTo(500, 0);
    for (const balance of before.arkBalances) {
      expect(balance).toBe(0n);
    }

    await run();

    const after = await getBalances();

    const tolerance = after.totalAssets / 1_000_000n || 1n;

    // Buffer should be at its target allocation (40%)
    const bufferTarget = (after.totalAssets * BigInt(config.buffer.allocation)) / 100n;
    expect(Number(after.bufferBalance) / 1e18).toBeCloseTo(Number(bufferTarget) / 1e18, 0);

    // Each ark should have received funds and be within its min/max bounds
    for (let i = 0; i < config.arks.length; i++) {
      const arkConfig = config.arks[i]!;
      const minAssets = (after.totalAssets * BigInt(arkConfig.allocation.min)) / 100n;
      const maxAssets = (after.totalAssets * BigInt(arkConfig.allocation.max)) / 100n;

      expect(after.arkBalances[i]!).toBeGreaterThanOrEqual(minAssets - tolerance);
      expect(after.arkBalances[i]!).toBeLessThanOrEqual(maxAssets + tolerance);
    }

    // Total assets should be preserved
    expect(Number(after.totalAssets) / 1e18).toBeCloseTo(Number(before.totalAssets) / 1e18, 0);
  });

  it('is a no-op when allocations are already at target', async () => {
    // First run: move funds from buffer to arks
    await run();
    const afterFirstRun = await getBalances();

    // Second run: should be a no-op since allocations are at target
    await run();
    const afterSecondRun = await getBalances();

    const tolerance = afterFirstRun.totalAssets / 1_000_000n || 1n;

    const bufferDiff =
      afterSecondRun.bufferBalance > afterFirstRun.bufferBalance
        ? afterSecondRun.bufferBalance - afterFirstRun.bufferBalance
        : afterFirstRun.bufferBalance - afterSecondRun.bufferBalance;
    expect(bufferDiff).toBeLessThanOrEqual(tolerance);

    for (let i = 0; i < config.arks.length; i++) {
      const diff =
        afterSecondRun.arkBalances[i]! > afterFirstRun.arkBalances[i]!
          ? afterSecondRun.arkBalances[i]! - afterFirstRun.arkBalances[i]!
          : afterFirstRun.arkBalances[i]! - afterSecondRun.arkBalances[i]!;
      expect(diff).toBeLessThanOrEqual(tolerance);
    }
  });

  it('respects ark max allocation bounds', async () => {
    await run();
    const after = await getBalances();
    const tolerance = after.totalAssets / 1_000_000n || 1n;

    for (let i = 0; i < config.arks.length; i++) {
      const arkConfig = config.arks[i]!;
      const maxAssets = (after.totalAssets * BigInt(arkConfig.allocation.max)) / 100n;
      expect(after.arkBalances[i]!).toBeLessThanOrEqual(maxAssets + tolerance);
    }
  });

  it('preserves total assets across reallocation', async () => {
    const before = await getBalances();
    await run();
    const after = await getBalances();

    // Total should be the same (within rounding tolerance)
    expect(Number(after.totalAssets) / 1e18).toBeCloseTo(Number(before.totalAssets) / 1e18, 0);
  });
});
