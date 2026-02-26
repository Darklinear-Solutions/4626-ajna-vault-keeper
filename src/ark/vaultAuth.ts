import type { Address } from 'viem';
import { contract } from '../utils/contract.ts';

export function createVaultAuth(address?: Address) {
  const vaultAuth = contract('vaultAuth', address);

  return {
    getBufferRatio: () => vaultAuth().read.bufferRatio(),
    getMinBucketIndex: () => vaultAuth().read.minBucketIndex(),
  };
}

const _default = createVaultAuth();

export const getBufferRatio = () => _default.getBufferRatio();
export const getMinBucketIndex = () => _default.getMinBucketIndex();
