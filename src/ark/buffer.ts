import type { Address } from 'viem';
import { contract } from '../utils/contract.ts';

export function createBuffer(address: Address) {
  const buffer = contract('buffer', address);

  return {
    getBufferTotal: () => buffer().read.total(),
  };
}
