import { log } from '../utils/logger.ts';
import { config } from '../utils/config.ts';
import { toAsset } from '../utils/decimalConversion.ts';
import { getOffchainPrice } from './offchain.ts';
import { getOnchainPrice } from './onchain.ts';

type PriceSource = () => Promise<bigint | number>;

const SOURCES: Record<'onchain' | 'offchain', PriceSource> = {
  onchain: getOnchainPrice,
  offchain: getOffchainPrice,
};

export async function getPrice(assetDecimals: number): Promise<bigint> {
  if (config.oracle.fixedPrice && config.oracle.fixedPrice > 0)
    return getFixedPrice(config.oracle.fixedPrice, assetDecimals);

  const errors: Error[] = [];
  const order: ('onchain' | 'offchain')[] = config.oracle.onchainPrimary
    ? ['onchain', 'offchain']
    : ['offchain', 'onchain'];

  for (const tag of order) {
    try {
      const price = await SOURCES[tag]();
      return typeof price === 'bigint' ? price : toAsset(price, assetDecimals);
    } catch (err) {
      const e = new Error(`${tag} price query failed`, { cause: err });
      errors.push(e);
      log.warn({ event: 'price_query_failed', err, tag }, `${tag} price query failed`);
    }
  }

  throw new AggregateError(errors, 'unable to fetch price from either source');
}

async function getFixedPrice(rawPrice: number, assetDecimals: number): Promise<bigint> {
  const price = toAsset(rawPrice, assetDecimals);
  log.info({ event: 'keeper_price_fixed', rawPrice, price }, `using fixed price: ${price}`);
  return price;
}
