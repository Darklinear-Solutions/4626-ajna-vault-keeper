import { client } from './client';
import { env } from './env';
import { getPoolAddress } from '../vault/vault';
import { erc20Abi, type Address } from 'viem';

async function getPoolBalance() {
  const poolAddress: Address = await getPoolAddress();
  return client.readContract({
    address: env.QUOTE_TOKEN_ADDRESS as Address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [poolAddress],
  });
}

export async function poolBalanceCap(initialAmount: bigint): Promise<bigint> {
  if (process.env.INTEGRATION_TEST) return initialAmount;
  const poolBalance = await getPoolBalance();
  return initialAmount > poolBalance ? poolBalance : initialAmount;
}
