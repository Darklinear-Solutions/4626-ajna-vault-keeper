import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

const POOL_ADDRESS = '0x00000000000000000000000000000000000000AB' as Address;
const VAULT_ADDRESS = '0x0000000000000000000000000000000000000002' as Address;

type RequestVariables = {
  poolId: string;
  first: number;
  skip: number;
};

type RequestArgs = {
  url: string;
  document: string;
  variables: RequestVariables;
  signal: AbortSignal;
};

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('graphql-request');
  vi.doUnmock('../../src/utils/env');
  vi.doUnmock('../../src/utils/config');
  vi.doUnmock('../../src/utils/logger');
  vi.doUnmock('../../src/utils/chainTime.ts');
});

function makeVault() {
  return {
    getAddress: () => VAULT_ADDRESS,
    getPoolAddress: vi.fn().mockResolvedValue(POOL_ADDRESS),
    getAuctionStatus: vi.fn(),
  };
}

function makeAuctions(count: number, offset: number) {
  return Array.from({ length: count }, (_, i) => {
    const n = offset + i + 1;
    return {
      borrower: `0x${n.toString(16).padStart(40, '0')}`,
      kickTime: String(1_700_000_000 + n),
    };
  });
}

function mockPoolHealth(
  request: ReturnType<typeof vi.fn>,
  exitOnSubgraphFailure = true,
  chainTime = 1_700_001_000n,
) {
  vi.doMock('graphql-request', () => ({
    gql: (strings: TemplateStringsArray) => strings[0] ?? '',
    request,
  }));
  vi.doMock('../../src/utils/env', () => ({
    env: { SUBGRAPH_URL: 'https://example.test/subgraph' },
  }));
  vi.doMock('../../src/utils/config', () => ({
    config: {
      keeper: { exitOnSubgraphFailure },
      arkGlobal: { maxAuctionAge: 259200 },
      subgraph: { requestTimeoutMs: 10000 },
    },
  }));
  vi.doMock('../../src/utils/logger', () => ({
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  }));
  vi.doMock('../../src/utils/chainTime.ts', () => ({
    getChainTime: vi.fn().mockResolvedValue(chainTime),
  }));
}

describe('_getUnsettledAuctions pagination', () => {
  it('fetches every page with explicit bounds and deterministic ordering', async () => {
    const requestedPages: RequestVariables[] = [];
    const request = vi.fn(async ({ variables }: RequestArgs) => {
      requestedPages.push({ ...variables });
      if (requestedPages.length <= 2) {
        return { liquidationAuctions: makeAuctions(variables.first, variables.skip) };
      }
      return { liquidationAuctions: makeAuctions(1, variables.skip) };
    });

    mockPoolHealth(request);
    const { _getUnsettledAuctions } = await import('../../src/subgraph/poolHealth');

    const result = await _getUnsettledAuctions(makeVault());

    const pageSize = requestedPages[0]!.first;
    expect(pageSize).toBeGreaterThan(0);
    expect(result.liquidationAuctions).toHaveLength(pageSize * 2 + 1);
    expect(requestedPages).toEqual([
      { poolId: POOL_ADDRESS.toLowerCase(), first: pageSize, skip: 0 },
      { poolId: POOL_ADDRESS.toLowerCase(), first: pageSize, skip: pageSize },
      { poolId: POOL_ADDRESS.toLowerCase(), first: pageSize, skip: pageSize * 2 },
    ]);

    const { document: query, signal } = request.mock.calls[0]![0];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(query).toContain('first: $first');
    expect(query).toContain('skip: $skip');
    expect(query).toContain('orderBy: id');
    expect(query).toContain('orderDirection: asc');
  });

  it('fails closed when a later page cannot be fetched', async () => {
    const cause = new Error('second page unavailable');
    const request = vi.fn(async ({ variables }: { variables: RequestVariables }) => {
      if (variables.skip === 0) {
        return { liquidationAuctions: makeAuctions(variables.first, variables.skip) };
      }
      throw cause;
    });

    mockPoolHealth(request, true);
    const { _getUnsettledAuctions, SubgraphUnavailableError } = await import(
      '../../src/subgraph/poolHealth'
    );

    const result = await _getUnsettledAuctions(makeVault()).catch((e) => e);

    expect(result).toBeInstanceOf(SubgraphUnavailableError);
    expect((result as Error).cause).toBe(cause);
    expect(request).toHaveBeenCalledTimes(2);
    const firstPage = (request.mock.calls[0]![0] as { variables: RequestVariables }).variables;
    expect((request.mock.calls[1]![0] as { variables: RequestVariables }).variables).toMatchObject({
      skip: firstPage.first,
    });
  });

  it('detects bad debt returned after the first page', async () => {
    const badBorrower = '0x000000000000000000000000000000000000dEaD' as Address;
    const request = vi.fn(async ({ variables }: { variables: RequestVariables }) => {
      if (variables.skip === 0) {
        return { liquidationAuctions: makeAuctions(variables.first, variables.skip) };
      }
      return {
        liquidationAuctions: [{ borrower: badBorrower, kickTime: '1700000500' }],
      };
    });

    mockPoolHealth(request);
    const { poolHasBadDebt } = await import('../../src/subgraph/poolHealth');
    const vault = makeVault();
    vault.getAuctionStatus.mockImplementation(async (borrower: Address) => {
      if (borrower.toLowerCase() === badBorrower.toLowerCase()) return [1n, 0n, 1n];
      return [0n, 0n, 0n];
    });

    await expect(poolHasBadDebt(vault)).resolves.toBe(true);
    expect(vault.getAuctionStatus).toHaveBeenCalledWith(badBorrower);
  });

  it('fails closed when the subgraph returns a malformed borrower address', async () => {
    const request = vi.fn(async () => ({
      liquidationAuctions: [{ borrower: 'not-an-address', kickTime: '1700000500' }],
    }));

    mockPoolHealth(request, true);
    const { _getUnsettledAuctions, SubgraphUnavailableError } = await import(
      '../../src/subgraph/poolHealth'
    );

    const result = await _getUnsettledAuctions(makeVault()).catch((e) => e);

    expect(result).toBeInstanceOf(SubgraphUnavailableError);
  });

  it('honors fail-open for a malformed borrower when exitOnSubgraphFailure is disabled', async () => {
    const request = vi.fn(async () => ({
      liquidationAuctions: [{ borrower: 'not-an-address', kickTime: '1700000500' }],
    }));

    mockPoolHealth(request, false);
    const { _getUnsettledAuctions } = await import('../../src/subgraph/poolHealth');

    await expect(_getUnsettledAuctions(makeVault())).resolves.toEqual({ liquidationAuctions: [] });
  });
});
