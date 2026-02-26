import { client } from './client';
import { env } from './env';
import { erc20Abi, type Address } from 'viem';

type VaultLike = { getPoolAddress: () => Promise<Address> };

async function getPoolBalance(vault: VaultLike) {
  const poolAddress = await vault.getPoolAddress();
  return client.readContract({
    address: env.QUOTE_TOKEN_ADDRESS as Address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [poolAddress],
  });
}

export async function poolBalanceCap(initialAmount: bigint, vault: VaultLike): Promise<bigint> {
  if (process.env.INTEGRATION_TEST) return initialAmount;
  const poolBalance = await getPoolBalance(vault);
  return initialAmount > poolBalance ? poolBalance : initialAmount;
}
