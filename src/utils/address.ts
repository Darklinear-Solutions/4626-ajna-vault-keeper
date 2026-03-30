import type { Address } from 'viem';
import { config } from './config';

type StaticTuple = readonly [string | undefined, string | undefined];

export const contracts = {
  chronicle: [config.oracle.onchainAddress, process.env.MOCK_CHRONICLE_ADDRESS] as StaticTuple,
  metavault: [config.metavaultAddress, config.metavaultAddress] as StaticTuple,
} as const;

export type ContractAddressKey = keyof typeof contracts;

export async function getAddress(name: ContractAddressKey): Promise<Address> {
  const entry = contracts[name];
  const idx = process.env.USE_MOCKS === 'true' ? 1 : 0;
  const addr = (entry as StaticTuple)[idx];
  if (!addr) throw new Error(`Missing ${name} address`);
  return addr as Address;
}
