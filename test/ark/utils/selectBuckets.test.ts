import { describe, it, expect, vi } from 'vitest';
import { selectBuckets } from '../../../src/ark/utils/selectBuckets';
import { type createVault } from '../../../src/ark/vault';

type Vault = ReturnType<typeof createVault>;

function makeVault(
  buckets: bigint[],
  values: Record<string, bigint>,
  prices: Record<string, bigint>,
): Vault {
  return {
    getBuckets: vi.fn().mockResolvedValue(buckets),
    lpToValue: vi
      .fn()
      .mockImplementation((bucket: bigint) => Promise.resolve(values[bucket.toString()] ?? 0n)),
    getIndexToPrice: vi
      .fn()
      .mockImplementation((index: bigint) => Promise.resolve(prices[index.toString()] ?? 0n)),
  } as unknown as Vault;
}

describe('selectBuckets', () => {
  it('returns single bucket when exactly one has enough funds', async () => {
    const vault = makeVault(
      [100n, 200n, 300n],
      { '100': 50n, '200': 500n, '300': 10n },
      { '100': 1000n, '200': 900n, '300': 800n },
    );

    const result = await selectBuckets(vault, 200n);
    expect(result).toEqual([{ bucket: 200n, amount: 200n }]);
  });

  it('returns lowest-price bucket when multiple have enough funds', async () => {
    const vault = makeVault(
      [100n, 200n, 300n],
      { '100': 500n, '200': 500n, '300': 500n },
      { '100': 1000n, '200': 800n, '300': 900n },
    );

    const result = await selectBuckets(vault, 200n);
    expect(result).toEqual([{ bucket: 200n, amount: 200n }]);
  });

  it('returns multiple buckets ordered by value desc when none have enough', async () => {
    const vault = makeVault(
      [100n, 200n, 300n],
      { '100': 30n, '200': 80n, '300': 50n },
      { '100': 1000n, '200': 900n, '300': 800n },
    );

    const result = await selectBuckets(vault, 120n);
    expect(result).toEqual([
      { bucket: 200n, amount: 80n },
      { bucket: 300n, amount: 40n },
    ]);
  });

  it('uses all buckets when total value just barely covers amount', async () => {
    const vault = makeVault(
      [100n, 200n],
      { '100': 40n, '200': 60n },
      { '100': 1000n, '200': 900n },
    );

    const result = await selectBuckets(vault, 100n);
    expect(result).toEqual([
      { bucket: 200n, amount: 60n },
      { bucket: 100n, amount: 40n },
    ]);
  });

  it('returns empty array when all buckets have zero value', async () => {
    const vault = makeVault([100n, 200n], { '100': 0n, '200': 0n }, { '100': 1000n, '200': 900n });

    const result = await selectBuckets(vault, 100n);
    expect(result).toEqual([]);
  });

  it('returns empty array when no buckets exist', async () => {
    const vault = makeVault([], {}, {});
    const result = await selectBuckets(vault, 100n);
    expect(result).toEqual([]);
  });

  it('skips zero-value buckets in multi-bucket scenario', async () => {
    const vault = makeVault(
      [100n, 200n, 300n],
      { '100': 0n, '200': 40n, '300': 30n },
      { '100': 1000n, '200': 900n, '300': 800n },
    );

    const result = await selectBuckets(vault, 60n);
    expect(result).toEqual([
      { bucket: 200n, amount: 40n },
      { bucket: 300n, amount: 20n },
    ]);
  });

  it('picks the single sufficient bucket regardless of price when only one qualifies', async () => {
    // Bucket 300 has a high price but is the only one with enough funds
    const vault = makeVault(
      [100n, 200n, 300n],
      { '100': 10n, '200': 10n, '300': 500n },
      { '100': 100n, '200': 200n, '300': 9999n },
    );

    const result = await selectBuckets(vault, 100n);
    expect(result).toEqual([{ bucket: 300n, amount: 100n }]);
  });

  it('handles single bucket vault', async () => {
    const vault = makeVault([100n], { '100': 500n }, { '100': 1000n });

    const result = await selectBuckets(vault, 200n);
    expect(result).toEqual([{ bucket: 100n, amount: 200n }]);
  });
});
