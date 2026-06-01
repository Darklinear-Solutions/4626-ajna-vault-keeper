import { gql, request } from 'graphql-request';
import { env } from '../utils/env.ts';
import { config } from '../utils/config.ts';
import { log } from '../utils/logger.ts';
import { getChainTime } from '../utils/chainTime.ts';
import type { Address } from 'viem';

type GetUnsettledAuctionsResponse = {
  liquidationAuctions: LiquidationAuction[];
};

type LiquidationAuction = {
  borrower: string;
  kickTime: string;
};

type VaultLike = {
  getAddress: () => Address | undefined;
  getPoolAddress: () => Promise<Address>;
  getAuctionStatus: (borrower: Address) => Promise<readonly [bigint, bigint, bigint, ...unknown[]]>;
};

export class SubgraphUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('subgraph query failed in fail-closed mode', { cause });
    this.name = 'SubgraphUnavailableError';
  }
}

export async function poolHasBadDebt(vault: VaultLike, maxAuctionAge?: number): Promise<boolean> {
  const auctions = await _getUnsettledAuctions(vault);
  const nowSec = await getChainTime();
  const auctionsBeforeCutoff = _filterAuctions(auctions, nowSec, maxAuctionAge);

  for (let i = 0; i < auctionsBeforeCutoff.length; i++) {
    const [kickTime, collateralRemaining, debtRemaining] = await vault.getAuctionStatus(
      auctionsBeforeCutoff[i]!.borrower as Address,
    );

    if (kickTime !== 0n && debtRemaining > 0n && collateralRemaining === 0n) return true;
  }

  return false;
}

export async function _getUnsettledAuctions(
  vault: VaultLike,
): Promise<GetUnsettledAuctionsResponse> {
  try {
    const poolAddress = (await vault.getPoolAddress()).toLowerCase();
    const subgraphUrl = env.SUBGRAPH_URL;

    const query = gql`
      query GetUnsettledAuctions($poolId: String!) {
        liquidationAuctions(where: { pool: $poolId, settled: false }) {
          borrower
          kickTime
        }
      }
    `;

    const result: GetUnsettledAuctionsResponse = await request(subgraphUrl!, query, {
      poolId: poolAddress,
    });

    return result;
  } catch (err) {
    log.error(
      {
        event: 'subgraph_query_failed',
        subgraphOrigin: safeOrigin(env.SUBGRAPH_URL),
        ark: vault.getAddress(),
        err,
      },
      'subgraph query failed',
    );

    if (config.keeper.exitOnSubgraphFailure) throw new SubgraphUnavailableError(err);
    return { liquidationAuctions: [] };
  }
}

function safeOrigin(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  try {
    return new URL(rawUrl).origin;
  } catch {
    return undefined;
  }
}

export function _filterAuctions(
  response: GetUnsettledAuctionsResponse,
  nowSec: bigint,
  maxAuctionAge?: number,
): LiquidationAuction[] {
  const unsettledAuctions = response.liquidationAuctions;
  const maxAge = maxAuctionAge ?? config.arkGlobal.maxAuctionAge;

  if (maxAge === 0) return unsettledAuctions;

  const maxAgeBig = BigInt(maxAge);
  const auctionsBeforeCutoff: LiquidationAuction[] = [];

  for (let i = 0; i < unsettledAuctions.length; i++) {
    const kickTime = BigInt(unsettledAuctions[i]!.kickTime);
    const auctionAge = nowSec - kickTime;

    if (auctionAge > maxAgeBig) {
      auctionsBeforeCutoff.push(unsettledAuctions[i]!);
    }
  }

  return auctionsBeforeCutoff;
}
