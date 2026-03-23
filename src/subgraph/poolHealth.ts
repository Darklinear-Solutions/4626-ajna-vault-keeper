import { gql, request } from 'graphql-request';
import { env } from '../utils/env';
import { config } from '../utils/config';
import { log } from '../utils/logger';
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

export async function poolHasBadDebt(vault: VaultLike): Promise<boolean> {
  const unfilteredAuctions = await _getUnsettledAuctions(vault);
  if (unfilteredAuctions === 'error') return true;
  const auctionsBeforeCutoff = _filterAuctions(unfilteredAuctions as GetUnsettledAuctionsResponse);

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
): Promise<GetUnsettledAuctionsResponse | string> {
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
      { event: 'subgraph_query_failed', url: env.SUBGRAPH_URL, ark: vault.getAddress(), err },
      'subgraph query failed',
    );

    return config.keeper.exitOnSubgraphFailure ? 'error' : { liquidationAuctions: [] };
  }
}

export function _filterAuctions(response: GetUnsettledAuctionsResponse): LiquidationAuction[] {
  const unsettledAuctions = response.liquidationAuctions;
  const maxAge = config.pool.maxAuctionAge;

  if (maxAge === 0) return unsettledAuctions;

  let auctionsBeforeCutoff: LiquidationAuction[] = [];

  for (let i = 0; i < unsettledAuctions.length; i++) {
    const kickTime = Number(unsettledAuctions[i]!.kickTime);
    const auctionAge = Math.floor(Date.now() / 1000) - kickTime;

    if (auctionAge > maxAge) {
      auctionsBeforeCutoff.push(unsettledAuctions[i]!);
    }
  }

  return auctionsBeforeCutoff;
}
