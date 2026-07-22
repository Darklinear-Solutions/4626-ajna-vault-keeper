import { afterEach, describe, expect, it, vi } from 'vitest';
import { zeroAddress, type Address } from 'viem';

const VAULT_ADDRESS = '0x0000000000000000000000000000000000000002' as Address;
const BORROWER_A = '0x0000000000000000000000000000000000000003' as Address;
const BORROWER_B = '0x0000000000000000000000000000000000000004' as Address;

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../src/utils/config');
  vi.doUnmock('../../src/utils/chainTime.ts');
});

type AuctionList = Address[];

function makeVault(auctionList: AuctionList) {
  return {
    getAddress: () => VAULT_ADDRESS,
    getTotalAuctionsInPool: vi.fn().mockResolvedValue(BigInt(auctionList.length)),
    getAuctionNext: vi.fn().mockImplementation((borrower: Address) =>
      Promise.resolve({
        head: auctionList[0] ?? zeroAddress,
        next:
          auctionList[auctionList.indexOf(borrower) + 1] === undefined
            ? zeroAddress
            : auctionList[auctionList.indexOf(borrower) + 1]!,
      }),
    ),
    getAuctionStatus: vi.fn(),
  };
}

async function loadPoolHealth(opts: { chainTimeSec?: bigint; maxAuctionAge?: number } = {}) {
  vi.doMock('../../src/utils/config', () => ({
    config: { arkGlobal: { maxAuctionAge: opts.maxAuctionAge ?? 600 } },
  }));
  vi.doMock('../../src/utils/chainTime.ts', () => ({
    getChainTime: vi.fn().mockResolvedValue(opts.chainTimeSec ?? 1_700_000_000n),
  }));
  return await import('../../src/ajna/poolHealth');
}

// Regression (PR19-D02): the auction set was previously enumerated through an external indexer, so a
// lagged or incomplete response could silently hide a just-kicked auction from the
// bad-debt gate. Enumeration now walks the pool's own auction linked list onchain.
describe('poolHasBadDebt onchain auction enumeration', () => {
  it('reports no bad debt when the pool has no active auctions', async () => {
    const { poolHasBadDebt } = await loadPoolHealth();
    const vault = makeVault([]);

    await expect(poolHasBadDebt(vault)).resolves.toBe(false);
    expect(vault.getAuctionNext).not.toHaveBeenCalled();
    expect(vault.getAuctionStatus).not.toHaveBeenCalled();
  });

  it('flags zero-collateral active debt found by walking the auction list', async () => {
    const chainTimeSec = 1_700_000_000n;
    const { poolHasBadDebt } = await loadPoolHealth({ chainTimeSec });
    const vault = makeVault([BORROWER_A]);
    vault.getAuctionStatus.mockResolvedValue([chainTimeSec - 10n, 0n, 1000n]);

    await expect(poolHasBadDebt(vault)).resolves.toBe(true);
    expect(vault.getAuctionStatus).toHaveBeenCalledWith(BORROWER_A);
  });

  it('flags over-age collateralized debt using chain time', async () => {
    const chainTimeSec = 1_700_000_000n;
    const { poolHasBadDebt } = await loadPoolHealth({ chainTimeSec, maxAuctionAge: 600 });
    const vault = makeVault([BORROWER_A]);
    vault.getAuctionStatus.mockResolvedValue([chainTimeSec - 601n, 1n, 1000n]);

    await expect(poolHasBadDebt(vault)).resolves.toBe(true);
  });

  it('does not flag young collateralized auctions', async () => {
    const chainTimeSec = 1_700_000_000n;
    const { poolHasBadDebt } = await loadPoolHealth({ chainTimeSec, maxAuctionAge: 600 });
    const vault = makeVault([BORROWER_A]);
    vault.getAuctionStatus.mockResolvedValue([chainTimeSec - 100n, 1n, 1000n]);

    await expect(poolHasBadDebt(vault)).resolves.toBe(false);
  });

  it('walks past a healthy head auction to find bad debt later in the list', async () => {
    const chainTimeSec = 1_700_000_000n;
    const { poolHasBadDebt } = await loadPoolHealth({ chainTimeSec, maxAuctionAge: 600 });
    const vault = makeVault([BORROWER_A, BORROWER_B]);
    vault.getAuctionStatus.mockImplementation((borrower: Address) =>
      Promise.resolve(
        borrower === BORROWER_B ? [chainTimeSec - 10n, 0n, 1000n] : [chainTimeSec - 10n, 1n, 1000n],
      ),
    );

    await expect(poolHasBadDebt(vault)).resolves.toBe(true);
    expect(vault.getAuctionStatus).toHaveBeenCalledWith(BORROWER_B);
  });

  // A settlement mid-walk deletes the removed borrower's struct, so a cursor sitting on it
  // reads next = 0x0 and the walk silently truncates. Enumeration must therefore only be
  // accepted when a full pass is self-consistent: walked length equals the count read before,
  // and the count is unchanged after. Anything else retries and then fails closed.
  it('fails closed when the walked list stays longer than the reported count', async () => {
    const { _getActiveAuctionBorrowers } = await loadPoolHealth();
    const vault = makeVault([BORROWER_A, BORROWER_B]);
    vault.getTotalAuctionsInPool.mockResolvedValue(1n);

    await expect(_getActiveAuctionBorrowers(vault)).rejects.toThrow(
      'kept changing during enumeration',
    );
  });

  it('fails closed when the walked list stays shorter than the reported count', async () => {
    const { _getActiveAuctionBorrowers } = await loadPoolHealth();
    const vault = makeVault([BORROWER_A]);
    vault.getTotalAuctionsInPool.mockResolvedValue(2n);

    await expect(_getActiveAuctionBorrowers(vault)).rejects.toThrow(
      'kept changing during enumeration',
    );
  });

  it('retries after a mid-walk mutation and returns the consistent second pass', async () => {
    const { _getActiveAuctionBorrowers } = await loadPoolHealth();
    const vault = makeVault([BORROWER_A]);
    vault.getTotalAuctionsInPool
      .mockResolvedValueOnce(2n)
      .mockResolvedValueOnce(1n)
      .mockResolvedValueOnce(1n);

    await expect(_getActiveAuctionBorrowers(vault)).resolves.toEqual([BORROWER_A]);
    expect(vault.getTotalAuctionsInPool).toHaveBeenCalledTimes(3);
  });

  it('fails closed when the count changes between the walk and the recheck', async () => {
    const { _getActiveAuctionBorrowers } = await loadPoolHealth();
    const vault = makeVault([BORROWER_A]);
    vault.getTotalAuctionsInPool
      .mockResolvedValueOnce(1n)
      .mockResolvedValueOnce(2n)
      .mockResolvedValueOnce(1n)
      .mockResolvedValueOnce(2n)
      .mockResolvedValueOnce(1n)
      .mockResolvedValueOnce(2n);

    await expect(_getActiveAuctionBorrowers(vault)).rejects.toThrow(
      'kept changing during enumeration',
    );
  });
});

// isPastAuctionAge cutoff is `auctionAge > maxAge` (strictly greater than). These tests pin
// the boundary so a refactor cannot silently turn it into >= and start flagging boundary-aged
// auctions as "stuck".
describe('isPastAuctionAge cutoff boundary', () => {
  it('excludes auctions whose age equals maxAge', async () => {
    const { isPastAuctionAge } = await loadPoolHealth();
    const nowSec = 1_700_000_000n;

    expect(isPastAuctionAge(nowSec - 100n, nowSec, 100)).toBe(false);
  });

  it('includes auctions whose age is one second past maxAge', async () => {
    const { isPastAuctionAge } = await loadPoolHealth();
    const nowSec = 1_700_000_000n;

    expect(isPastAuctionAge(nowSec - 101n, nowSec, 100)).toBe(true);
  });

  it('excludes auctions kicked in the future (kickTime > nowSec)', async () => {
    const { isPastAuctionAge } = await loadPoolHealth();
    const nowSec = 1_700_000_000n;

    expect(isPastAuctionAge(nowSec + 50n, nowSec, 100)).toBe(false);
  });

  it('returns true for every auction when maxAge is 0 regardless of nowSec', async () => {
    const { isPastAuctionAge } = await loadPoolHealth();
    const nowSec = 1_700_000_000n;

    expect(isPastAuctionAge(nowSec - 10n, nowSec, 0)).toBe(true);
    expect(isPastAuctionAge(nowSec + 10n, nowSec, 0)).toBe(true);
  });

  it('falls back to the configured global maxAuctionAge when no override is given', async () => {
    const { isPastAuctionAge } = await loadPoolHealth({ maxAuctionAge: 600 });
    const nowSec = 1_700_000_000n;

    expect(isPastAuctionAge(nowSec - 601n, nowSec)).toBe(true);
    expect(isPastAuctionAge(nowSec - 600n, nowSec)).toBe(false);
  });
});
