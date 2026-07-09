import { getAbi } from '../utils/abi.ts';
import { getAddress } from '../utils/address.ts';
import { client, readOnlyClient } from '../utils/client.ts';
import { getChainTime } from '../utils/chainTime.ts';
import { config } from '../utils/config.ts';
import { log } from '../utils/logger.ts';
import { quotePerCollateralWad } from './denominate.ts';
import type { Address } from 'viem';

type OracleData = readonly [bigint, bigint];
type ChronicleFeed = 'chronicleCollateral' | 'chronicleQuote';

const FUTURE_SKEW_TOLERANCE_SECS = BigInt(config.oracle.futureSkewTolerance);

export async function getOnchainPrice(): Promise<bigint> {
  if (!config.oracle.onchainCollateralAddress || !config.oracle.onchainQuoteAddress) {
    throw new Error('onchain oracle addresses are undefined');
  }

  const [[collateralUsd, collateralAge], [quoteUsd, quoteAge]] = await Promise.all([
    _queryChronicle('chronicleCollateral'),
    _queryChronicle('chronicleQuote'),
  ]);
  const latestBlockTimestamp = await getChainTime();

  for (const rawAge of [collateralAge, quoteAge]) {
    checkForFutureTimestamp(rawAge, latestBlockTimestamp);
    checkForStaleTimestamp(latestBlockTimestamp - rawAge);
  }

  return quotePerCollateralWad(collateralUsd, quoteUsd);
}

export async function _queryChronicle(feed: ChronicleFeed): Promise<OracleData> {
  const queryData = {
    address: (await getAddress(feed)) as Address,
    abi: getAbi('chronicle'),
    functionName: 'readWithAge',
  } as const;

  try {
    return (await client.readContract(queryData)) as OracleData;
  } catch {
    log.info(
      { event: 'chronicle_read' },
      'account not tolled by chronicle, falling back to read-only client',
    );
    return (await readOnlyClient.readContract(queryData)) as OracleData;
  }
}

function checkForFutureTimestamp(rawAge: bigint, latestBlockTimestamp: bigint) {
  if (rawAge > latestBlockTimestamp + FUTURE_SKEW_TOLERANCE_SECS) {
    throw new Error('onchain oracle price has future timestamp');
  }
}

function checkForStaleTimestamp(age: bigint) {
  const maxStalenessSecs =
    config.oracle.onchainMaxStaleness == null ? null : BigInt(config.oracle.onchainMaxStaleness);

  if (maxStalenessSecs != null && age > maxStalenessSecs) {
    throw new Error('onchain oracle price is stale');
  }
}
