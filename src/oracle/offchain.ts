import { env } from '../utils/env.ts';
import { config } from '../utils/config.ts';

const tier = env.ORACLE_API_TIER ?? 'none';
const key = env.ORACLE_API_KEY ?? '';

const headers: Record<string, string> = {
  accept: 'application/json',
  ...(tier === 'demo' && key && { 'x-cg-demo-api-key': key }),
  ...(tier === 'pro' && key && { 'x-cg-pro-api-key': key }),
};

export async function getOffchainPrice(): Promise<string> {
  const address = config.quoteTokenAddress;

  const res = await fetch(config.oracle.apiUrl as string, { method: 'GET', headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const body = await res.text();
  const price = _extractUsdPriceLiteral(body, address);
  if (price == null) throw new Error('price is undefined or could not be parsed exactly');

  return price;
}

function _extractUsdPriceLiteral(body: string, address: string): string | undefined {
  const escapedAddress = address.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const numberPattern = '(-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)';
  const match = body
    .toLowerCase()
    .match(new RegExp(`"${escapedAddress}"\\s*:\\s*\\{[^{}]*"usd"\\s*:\\s*${numberPattern}`));

  return match?.[1];
}
