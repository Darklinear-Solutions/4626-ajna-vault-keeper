import { describe, it, expect } from 'vitest';
import {
  getConfig,
  getExpectedSupplyAssets,
  getSupplyCap,
  getTotalExpectedSupplyAssets,
} from '../../src/metavault/metavault';
import { type Address } from 'viem';

describe('metavault interface', () => {
  it('can read expectedSupplyAssets', async () => {
    const bufferAddress = process.env.AAVE_VAULT_ADDRESS as Address;
    const assets = await getExpectedSupplyAssets(bufferAddress);
    expect(500e18 - Number(assets)).toBeCloseTo(0);
  });

  it('can return total expected supply assets', async () => {
    const strategyAddresses: Address[] = [
      process.env.AAVE_VAULT_ADDRESS as Address,
      process.env.ARK_1_ADDRESS as Address,
      process.env.ARK_2_ADDRESS as Address,
      process.env.ARK_3_ADDRESS as Address,
    ];

    const totalAssets = await getTotalExpectedSupplyAssets(strategyAddresses);
    expect(500e18 - Number(totalAssets)).toBeCloseTo(0);
  });

  it('can read market config', async () => {
    const bufferAddress = process.env.AAVE_VAULT_ADDRESS as Address;
    const config = await getConfig(bufferAddress);
    expect(Object.keys(config)).toStrictEqual(['balance', 'cap', 'enabled', 'removableAt']);
  });

  it('can return supply cap', async () => {
    const bufferAddress = process.env.AAVE_VAULT_ADDRESS as Address;
    const bufferCap = await getSupplyCap(bufferAddress);
    expect(bufferCap).toBe(87112285931760246646623899502532662132735n);
  });
});
