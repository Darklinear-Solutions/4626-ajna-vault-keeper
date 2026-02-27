/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Address } from 'viem';
import { contract } from '../utils/contract';

export function createPool(address: Address) {
  const pool = contract('pool', address);

  return {
    getBucketInfo: (index: bigint) => pool().read.bucketInfo([index]),
    getBankruptcyTime: async (index: bigint) => {
      const bucketInfo = await pool().read.bucketInfo([index]);
      return (bucketInfo as any)[2];
    },
    getBucketLps: async (index: bigint) => {
      const bucketInfo = await pool().read.bucketInfo([index]);
      return (bucketInfo as any)[0];
    },
    updateInterest: (gas: bigint) => pool().write.updateInterest({ gas }),
    getTotalT0DebtInAuction: () => pool().read.totalT0DebtInAuction(),
    getInflatorInfo: () => pool().read.inflatorInfo(),
    getDepositIndex: (debt: bigint) => pool().read.depositIndex(debt),
    isBucketDebtLocked: async (index: bigint): Promise<boolean> => {
      const t0DebtInAuction = (await pool().read.totalT0DebtInAuction()) as bigint;
      if (t0DebtInAuction === 0n) return false;
      const inflatorInfo = await pool().read.inflatorInfo();
      const wad = 10n ** 18n;
      const debt = (t0DebtInAuction * (inflatorInfo as any)[0] + wad / 2n) / wad;
      const indexOfSum = (await pool().read.depositIndex(debt)) as bigint;
      return index <= indexOfSum;
    },
  };
}
