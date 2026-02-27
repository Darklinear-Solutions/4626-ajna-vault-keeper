import { contract } from '../utils/contract';
import { type Address } from 'viem';

const metavault = contract('metavault');

export const getExpectedSupplyAssets = (id: Address) => metavault().read.expectedSupplyAssets(id);

export const getTotalExpectedSupplyAssets = async (ids: Address[]) => {
  let totalAssets = 0n;

  for (let i = 0; i < ids.length; i++) {
    const assets = await getExpectedSupplyAssets(ids[i] as Address);
    totalAssets += assets;
  }

  return totalAssets;
};

export const getConfig = (id: Address) => metavault().read.config(id);

export const getSupplyCap = async (id: Address) => {
  const config = await getConfig(id);
  return config.cap;
};
