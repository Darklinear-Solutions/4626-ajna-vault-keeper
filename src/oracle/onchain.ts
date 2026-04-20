import { getAbi } from '../utils/abi.ts';
import { getAddress } from '../utils/address.ts';
import { client, readOnlyClient } from '../utils/client.ts';
import { config } from '../utils/config.ts';
import { log } from '../utils/logger.ts';
import type { Address } from 'viem';

type OracleData = readonly [bigint, bigint];
type PriceData = {
  value: OracleData;
  client: typeof client | typeof readOnlyClient;
};

const FUTURE_SKEW_TOLERANCE_SECS = BigInt(config.oracle.futureSkewTolerance);

export async function getOnchainPrice(): Promise<bigint> {
  if (!config.oracle.onchainAddress) throw new Error('onchain oracle address is undefined');

  const priceData = await _queryChronicle();
  const [price, rawAge] = priceData.value;
  const latestBlock = await priceData.client.getBlock({ blockTag: 'latest' });
  const latestBlockTimestamp = latestBlock.timestamp;
  const age = latestBlockTimestamp - rawAge;

  checkForFutureTimestamp(rawAge, latestBlockTimestamp);
  checkForStaleTimestamp(age);

  return price;
}

export async function _queryChronicle(): Promise<PriceData> {
  const queryData = {
    address: (await getAddress('chronicle')) as Address,
    abi: getAbi('chronicle'),
    functionName: 'readWithAge',
  } as const;

  try {
    return {
      value: (await client.readContract(queryData)) as OracleData,
      client,
    };
  } catch {
    log.info(
      { event: 'chronicle_read' },
      'account not tolled by chronicle, falling back to read-only client',
    );
    return {
      value: (await readOnlyClient.readContract(queryData)) as OracleData,
      client: readOnlyClient,
    };
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
