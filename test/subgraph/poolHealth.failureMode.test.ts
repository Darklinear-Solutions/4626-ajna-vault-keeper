import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('graphql-request');
  vi.doUnmock('../../src/utils/env');
  vi.doUnmock('../../src/utils/config');
  vi.doUnmock('../../src/utils/logger');
});

const POOL_ADDRESS = '0x0000000000000000000000000000000000000001' as Address;
const VAULT_ADDRESS = '0x0000000000000000000000000000000000000002' as Address;

function makeVault() {
  return {
    getAddress: () => VAULT_ADDRESS,
    getPoolAddress: vi.fn().mockResolvedValue(POOL_ADDRESS),
    getAuctionStatus: vi.fn(),
  };
}

describe('subgraph failure handling', () => {
  it('fails closed when the subgraph query throws and exitOnSubgraphFailure is enabled', async () => {
    const request = vi.fn().mockRejectedValue(new Error('subgraph unavailable'));
    const error = vi.fn();
    const vault = makeVault();

    vi.doMock('graphql-request', () => ({
      gql: (strings: TemplateStringsArray) => strings[0] ?? '',
      request,
    }));
    vi.doMock('../../src/utils/env', () => ({
      env: { SUBGRAPH_URL: 'https://example.test/subgraph' },
    }));
    vi.doMock('../../src/utils/config', () => ({
      config: {
        keeper: { exitOnSubgraphFailure: true },
        arkGlobal: { maxAuctionAge: 259200 },
      },
    }));
    vi.doMock('../../src/utils/logger', () => ({
      log: { error },
    }));

    const { _getUnsettledAuctions, poolHasBadDebt } = await import('../../src/subgraph/poolHealth');

    await expect(_getUnsettledAuctions(vault)).resolves.toBe('error');
    await expect(poolHasBadDebt(vault)).resolves.toBe(true);
    expect(vault.getAuctionStatus).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'subgraph_query_failed', ark: VAULT_ADDRESS }),
      'subgraph query failed',
    );
  });

  it('keeps fail-open behavior available as an explicit opt-in', async () => {
    const request = vi.fn().mockRejectedValue(new Error('subgraph unavailable'));
    const vault = makeVault();

    vi.doMock('graphql-request', () => ({
      gql: (strings: TemplateStringsArray) => strings[0] ?? '',
      request,
    }));
    vi.doMock('../../src/utils/env', () => ({
      env: { SUBGRAPH_URL: 'https://example.test/subgraph' },
    }));
    vi.doMock('../../src/utils/config', () => ({
      config: {
        keeper: { exitOnSubgraphFailure: false },
        arkGlobal: { maxAuctionAge: 259200 },
      },
    }));
    vi.doMock('../../src/utils/logger', () => ({
      log: { error: vi.fn() },
    }));

    const { _getUnsettledAuctions, poolHasBadDebt } = await import('../../src/subgraph/poolHealth');

    await expect(_getUnsettledAuctions(vault)).resolves.toEqual({ liquidationAuctions: [] });
    await expect(poolHasBadDebt(vault)).resolves.toBe(false);
    expect(vault.getAuctionStatus).not.toHaveBeenCalled();
  });
});
