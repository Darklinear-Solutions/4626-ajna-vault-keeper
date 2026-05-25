import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

const POOL_ADDRESS = '0x0000000000000000000000000000000000000001' as Address;
const VAULT_ADDRESS = '0x0000000000000000000000000000000000000002' as Address;
const BORROWER = '0x0000000000000000000000000000000000000003' as Address;

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

// _filterAuctions cutoff is `auctionAge > maxAge` (strictly greater than). These
// tests pin the boundary so a refactor cannot silently turn it into >= and start
// flagging boundary-aged auctions as "stuck".
describe('_filterAuctions cutoff boundary', () => {
  async function loadFilter() {
    vi.doMock('../../src/utils/config', () => ({
      config: { arkGlobal: { maxAuctionAge: 1 } },
    }));
    vi.doMock('../../src/utils/logger', () => ({
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    }));
    vi.doMock('../../src/utils/chainTime.ts', () => ({
      getChainTime: vi.fn(),
    }));
    const mod = await import('../../src/subgraph/poolHealth');
    return mod._filterAuctions;
  }

  function auction(kickTime: bigint) {
    return { borrower: BORROWER, kickTime: String(kickTime) };
  }

  it('excludes auctions whose age equals maxAge', async () => {
    const _filterAuctions = await loadFilter();
    const nowSec = 1_700_000_000n;
    const maxAge = 100;
    const kickTime = nowSec - BigInt(maxAge);

    const result = _filterAuctions({ liquidationAuctions: [auction(kickTime)] }, nowSec, maxAge);

    expect(result).toEqual([]);
  });

  it('includes auctions whose age is one second past maxAge', async () => {
    const _filterAuctions = await loadFilter();
    const nowSec = 1_700_000_000n;
    const maxAge = 100;
    const kickTime = nowSec - BigInt(maxAge) - 1n;

    const result = _filterAuctions({ liquidationAuctions: [auction(kickTime)] }, nowSec, maxAge);

    expect(result).toHaveLength(1);
    expect(result[0]?.kickTime).toBe(String(kickTime));
  });

  it('excludes auctions kicked in the future (kickTime > nowSec)', async () => {
    const _filterAuctions = await loadFilter();
    const nowSec = 1_700_000_000n;
    const kickTime = nowSec + 50n;

    const result = _filterAuctions({ liquidationAuctions: [auction(kickTime)] }, nowSec, 100);

    expect(result).toEqual([]);
  });

  it('excludes auctions with kickTime exactly equal to nowSec (age 0)', async () => {
    const _filterAuctions = await loadFilter();
    const nowSec = 1_700_000_000n;

    const result = _filterAuctions({ liquidationAuctions: [auction(nowSec)] }, nowSec, 100);

    expect(result).toEqual([]);
  });

  it('returns every auction when maxAge is 0 regardless of nowSec', async () => {
    const _filterAuctions = await loadFilter();
    const nowSec = 1_700_000_000n;

    const result = _filterAuctions(
      {
        liquidationAuctions: [auction(nowSec - 10n), auction(nowSec + 10n)],
      },
      nowSec,
      0,
    );

    expect(result).toHaveLength(2);
  });
});

// End-to-end coverage that poolHasBadDebt sources "now" from chain time, not
// from Date.now(). Failure of this test would mean an operator with a drifted
// host clock could under- or over-report bad-debt status.
describe('poolHasBadDebt uses chain time, not host wall clock', () => {
  async function loadPoolHealth(opts: {
    chainTimeSec: bigint;
    auctions: Array<{ borrower: string; kickTime: string }>;
  }) {
    vi.doMock('graphql-request', () => ({
      gql: (strings: TemplateStringsArray) => strings[0] ?? '',
      request: vi.fn().mockResolvedValue({ liquidationAuctions: opts.auctions }),
    }));
    vi.doMock('../../src/utils/env', () => ({
      env: { SUBGRAPH_URL: 'https://example.test/subgraph' },
    }));
    vi.doMock('../../src/utils/config', () => ({
      config: {
        keeper: { exitOnSubgraphFailure: true },
        arkGlobal: { maxAuctionAge: 600 },
      },
    }));
    vi.doMock('../../src/utils/logger', () => ({
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    }));
    vi.doMock('../../src/utils/chainTime.ts', () => ({
      getChainTime: vi.fn().mockResolvedValue(opts.chainTimeSec),
    }));
    return await import('../../src/subgraph/poolHealth');
  }

  it('flags bad debt when chain time puts the auction past the cutoff even if Date.now would not', async () => {
    const chainTimeSec = 1_700_000_700n;
    const dateNowSec = 1_700_000_000n;
    const kickTimeSec = 1_700_000_050n;

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Number(dateNowSec) * 1000));
    try {
      const { poolHasBadDebt } = await loadPoolHealth({
        chainTimeSec,
        auctions: [{ borrower: BORROWER, kickTime: String(kickTimeSec) }],
      });

      const vault = makeVault();
      vault.getAuctionStatus.mockResolvedValue([1n, 0n, 1n]);

      await expect(poolHasBadDebt(vault)).resolves.toBe(true);
      expect(vault.getAuctionStatus).toHaveBeenCalledExactlyOnceWith(BORROWER);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not flag bad debt when chain time leaves the auction inside the cutoff even if Date.now would', async () => {
    const chainTimeSec = 1_700_000_100n;
    const dateNowSec = 1_700_000_900n;
    const kickTimeSec = 1_700_000_050n;

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Number(dateNowSec) * 1000));
    try {
      const { poolHasBadDebt } = await loadPoolHealth({
        chainTimeSec,
        auctions: [{ borrower: BORROWER, kickTime: String(kickTimeSec) }],
      });

      const vault = makeVault();

      await expect(poolHasBadDebt(vault)).resolves.toBe(false);
      expect(vault.getAuctionStatus).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
