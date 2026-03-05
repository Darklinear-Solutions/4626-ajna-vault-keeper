import type { Address } from 'viem';

type StaticTuple = readonly [string | undefined, string | undefined];

export const contracts = {
  vault: [process.env.VAULT_ADDRESS, process.env.MOCK_VAULT_ADDRESS] as StaticTuple,
  vaultAuth: [process.env.VAULT_AUTH_ADDRESS, process.env.MOCK_VAULT_AUTH_ADDRESS] as StaticTuple,
  chronicle: [
    process.env.ONCHAIN_ORACLE_ADDRESS,
    process.env.MOCK_CHRONICLE_ADDRESS,
  ] as StaticTuple,
  metavault: [process.env.METAVAULT_ADDRESS, process.env.METAVAULT_ADDRESS] as StaticTuple,
} as const;

export type ContractAddressKey = keyof typeof contracts;

export async function getAddress(name: ContractAddressKey): Promise<Address> {
  const entry = contracts[name];
  const idx = process.env.USE_MOCKS === 'true' ? 1 : 0;
  const addr = (entry as StaticTuple)[idx];
  if (!addr) throw new Error(`Missing ${name} address`);
  return addr as Address;
}
