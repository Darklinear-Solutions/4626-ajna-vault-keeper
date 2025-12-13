import { log } from '../utils/logger.ts';
import { env } from '../utils/env.ts';
import { toAsset } from '../utils/decimalConversion.ts';
import { getOffchainPrice } from './offchain.ts';
import { getOnchainPrice } from './onchain.ts';

type PriceSource = () => Promise<bigint | number>;

const SOURCES: Record<'onchain' | 'offchain', PriceSource> = {
  onchain: getOnchainPrice,
  offchain: getOffchainPrice,
};

export async function getPrice(): Promise<bigint> {
  if (env.FIXED_PRICE && env.FIXED_PRICE > 0) return getFixedPrice(env.FIXED_PRICE);

  const errors: Error[] = [];
  const order: ('onchain' | 'offchain')[] = env.ONCHAIN_ORACLE_PRIMARY
    ? ['onchain', 'offchain']
    : ['offchain', 'onchain'];

  for (const tag of order) {
    try {
      const price = await SOURCES[tag]();
      return typeof price === 'bigint' ? price : toAsset(price);
    } catch (err) {
      const e = new Error(`${tag} price query failed`, { cause: err });
      errors.push(e);
      log.warn({ event: 'price_query_failed', err, tag }, `${tag} price query failed`);
    }
  }

  throw new AggregateError(errors, 'unable to fetch price from either source');
}

async function getFixedPrice(rawPrice: number): Promise<bigint> {
  const price = await toAsset(rawPrice);
  log.info({ event: 'keeper_price_fixed', rawPrice, price }, `using fixed price: ${price}`);
  return price;
}
