import { env } from '../utils/env.ts';
import {
  config,
  DEFAULT_FUTURE_SKEW_TOLERANCE,
  DEFAULT_OFFCHAIN_MAX_STALENESS,
} from '../utils/config.ts';

const tier = env.ORACLE_API_TIER ?? 'none';
const key = env.ORACLE_API_KEY ?? '';
const MAX_OFFCHAIN_PRICE_LITERAL_LENGTH = 64;

const headers: Record<string, string> = {
  accept: 'application/json',
  ...(tier === 'demo' && key && { 'x-cg-demo-api-key': key }),
  ...(tier === 'pro' && key && { 'x-cg-pro-api-key': key }),
};

export async function getOffchainPrice(): Promise<string> {
  const address = config.quoteTokenAddress;

  const res = await fetch(_priceUrl(), { method: 'GET', headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const body = await res.text();
  const price = _extractUsdPrice(body, address);
  if (price == null) {
    throw new Error('price is undefined or could not be parsed exactly');
  }
  _checkFreshness(price.lastUpdatedAt);

  return price.usd;
}

function _priceUrl(): string {
  const url = new URL(config.oracle.apiUrl as string);
  url.searchParams.set('include_last_updated_at', 'true');
  return url.toString();
}

function _extractUsdPrice(
  body: string,
  address: string,
): { usd: string; lastUpdatedAt: bigint } | undefined {
  const escapedAddress = address.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const numberPattern = '(-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)';
  const tokenMatch = body
    .toLowerCase()
    .match(new RegExp(`"${escapedAddress}"\\s*:\\s*\\{([^{}]*)\\}`));
  const fields = tokenMatch?.[1];
  if (!fields) return undefined;

  const literal = fields.match(new RegExp(`"usd"\\s*:\\s*${numberPattern}`))?.[1];
  if (!literal) return undefined;
  if (literal.length > MAX_OFFCHAIN_PRICE_LITERAL_LENGTH) return undefined;
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(literal)) return undefined;

  const lastUpdatedAt = fields.match(/"last_updated_at"\s*:\s*(0|[1-9]\d*)/)?.[1];
  if (!lastUpdatedAt) return undefined;

  return { usd: literal, lastUpdatedAt: BigInt(lastUpdatedAt) };
}

function _checkFreshness(lastUpdatedAt: bigint): void {
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const futureSkewTolerance = BigInt(
    config.oracle.futureSkewTolerance ?? DEFAULT_FUTURE_SKEW_TOLERANCE,
  );
  const maxStaleness = BigInt(config.oracle.offchainMaxStaleness ?? DEFAULT_OFFCHAIN_MAX_STALENESS);

  if (lastUpdatedAt > nowSec + futureSkewTolerance) {
    throw new Error('offchain oracle price has future timestamp');
  }
  if (nowSec - lastUpdatedAt > maxStaleness) {
    throw new Error('offchain oracle price is stale');
  }
}
