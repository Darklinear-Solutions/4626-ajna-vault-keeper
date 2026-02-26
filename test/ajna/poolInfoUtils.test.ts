import { describe, it, expect } from 'vitest';
import { createVault } from '../../src/ark/vault';
import type { Address } from 'viem';

const vault = createVault(
  process.env.VAULT_ADDRESS as Address,
  process.env.VAULT_AUTH_ADDRESS as Address,
);

describe('PoolInfoUtils interface', () => {
  it('can query priceToIndex', async () => {
    const priceToIndex = await vault.getPriceToIndex(10n ** 18n);
    expect(priceToIndex).toBe(4156n);
  });

  it('can query indexToPrice', async () => {
    const lup = await vault.getLup();
    const lupIndex = await vault.getPriceToIndex(lup);
    const indexToPrice = await vault.getIndexToPrice(lupIndex);
    expect(indexToPrice).toBe(lup);
  });

  it('can query htp', async () => {
    const htp = await vault.getHtp();
    const value = Number(htp) / 1e18;
    const expectedValue = Number(976430666641620462n) / 1e18;
    expect(expectedValue).toBeCloseTo(value);
  });

  it('can query lup', async () => {
    const lup = await vault.getLup();
    const value = Number(lup) / 1e18;
    const expectedValue = Number(995024875621890556n) / 1e18;
    expect(value).toBeCloseTo(expectedValue);
  });

  it('can query auction status', async () => {
    const auction = await vault.getAuctionStatus('0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf');
    expect((auction as any[]).length).toBe(9);
  });
});
