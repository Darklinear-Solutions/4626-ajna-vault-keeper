import { env } from '../utils/env';
import { config } from '../utils/config';

type OffchainPriceResponse = Record<string, { [currency: string]: number }>;

const tier = env.ORACLE_API_TIER ?? 'none';
const key = env.ORACLE_API_KEY ?? '';

const headers: Record<string, string> = {
  accept: 'application/json',
  ...(tier === 'demo' && key && { 'x-cg-demo-api-key': key }),
  ...(tier === 'pro' && key && { 'x-cg-pro-api-key': key }),
};

export async function getOffchainPrice(): Promise<number> {
  const address = config.quoteTokenAddress;

  const res = await fetch(config.oracle.apiUrl as string, { method: 'GET', headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = (await res.json()) as OffchainPriceResponse;
  const price = json[address]?.usd;
  if (price === undefined) throw new Error('price is undefined');

  return price;
}
