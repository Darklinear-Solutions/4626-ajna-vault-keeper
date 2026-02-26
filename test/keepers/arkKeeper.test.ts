import { describe, it, expect } from 'vitest';
import { _calculateBufferTarget, _calculateOptimalBucket } from '../../src/keepers/arkKeeper';
import { getPrice } from '../../src/oracle/price';
import { createVault } from '../../src/ark/vault';
import type { Address } from 'viem';

const vault = createVault(
  process.env.VAULT_ADDRESS as Address,
  process.env.VAULT_AUTH_ADDRESS as Address,
);

describe('keeper calculations', () => {
  it('correctly calculates buffer target', async () => {
    const target = await _calculateBufferTarget();
    expect(50000000000000000000n - target).toBeLessThan(150000);
  });

  it('correctly calculates optimal bucket', async () => {
    const price = await getPrice();
    const currentBucket = await vault.getPriceToIndex(price);
    const newBucket = await _calculateOptimalBucket(price);
    const newBucketPrice = await vault.getIndexToPrice(newBucket);
    expect(newBucket).toBeGreaterThan(currentBucket);
    expect(newBucketPrice).toBeLessThan(price);
  });
});
