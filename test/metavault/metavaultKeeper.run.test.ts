import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { maxUint256, type Address } from 'viem';

const BUFFER = '0x00000000000000000000000000000000000000ff' as Address;
const ARK_A = '0x00000000000000000000000000000000000000a1' as Address;
const ARK_B = '0x00000000000000000000000000000000000000b2' as Address;
const S = 1_000_000n;
const TX_HASH = '0x1111111111111111111111111111111111111111111111111111111111111111' as const;

type ArkConfig = {
  address: Address;
  allocation: { min: number; max: number };
  vaultAddress?: Address;
};

function buildVaultFixture(
  address: Address,
  { paused = false, rate = 100n }: { paused?: boolean; rate?: bigint } = {},
) {
  return {
    getAddress: () => address,
    isPaused: vi.fn().mockResolvedValue(paused),
    getBorrowFeeRate: vi.fn().mockResolvedValue(rate),
    drain: vi.fn().mockResolvedValue(TX_HASH),
    moveToBuffer: vi.fn().mockResolvedValue(TX_HASH),
  };
}

function resetMetavaultKeeperModules() {
  vi.resetModules();
  vi.doUnmock('../../src/utils/config.ts');
  vi.doUnmock('../../src/ark/vault.ts');
  vi.doUnmock('../../src/metavault/metavault.ts');
  vi.doUnmock('../../src/metavault/utils/evaluateRates.ts');
  vi.doUnmock('../../src/subgraph/poolHealth.ts');
  vi.doUnmock('../../src/ark/utils/selectBuckets.ts');
  vi.doUnmock('../../src/utils/transaction.ts');
  vi.doUnmock('../../src/ajna/utils/poolBalanceCap.ts');
  vi.doUnmock('../../src/utils/logger.ts');
}

beforeEach(() => {
  resetMetavaultKeeperModules();
});

afterEach(() => {
  resetMetavaultKeeperModules();
});

async function setupMetavaultRunTest({
  arkConfigs = [
    { address: ARK_A, allocation: { min: 5, max: 20 } },
    { address: ARK_B, allocation: { min: 5, max: 60 } },
  ],
  balances = {
    [BUFFER]: 400n * S,
    [ARK_A]: 100n * S,
    [ARK_B]: 500n * S,
  } as Partial<Record<Address, bigint>>,
  totalAssets = 1000n * S,
  vaults,
  evaluations = [],
  bucketPlan = [],
  poolBalanceCaps = {},
}: {
  arkConfigs?: ArkConfig[];
  balances?: Partial<Record<Address, bigint>>;
  totalAssets?: bigint;
  vaults?: Partial<Record<Address, ReturnType<typeof buildVaultFixture>>>;
  evaluations?: Array<{ address: Address; targets: Address[] }>;
  bucketPlan?: Array<{ bucket: bigint; amount: bigint }>;
  poolBalanceCaps?: Partial<Record<Address, bigint>>;
} = {}) {
  const vaultFixtures = {
    [ARK_A]: buildVaultFixture(ARK_A, { rate: 100n }),
    [ARK_B]: buildVaultFixture(ARK_B, { rate: 200n }),
    ...(vaults ?? {}),
  } as Record<Address, ReturnType<typeof buildVaultFixture>>;

  const balanceMap = {
    [BUFFER]: 400n * S,
    [ARK_A]: 100n * S,
    [ARK_B]: 500n * S,
    ...balances,
  } as Record<Address, bigint>;

  const getExpectedSupplyAssets = vi.fn(async (address: Address) => balanceMap[address] ?? 0n);
  const getTotalExpectedSupplyAssets = vi.fn().mockResolvedValue(totalAssets);
  const reallocate = vi.fn().mockReturnValue({ kind: 'reallocate' });
  const evaluateRates = vi.fn().mockReturnValue(evaluations);
  const selectBuckets = vi.fn().mockResolvedValue(bucketPlan);
  const handleTransaction = vi.fn().mockResolvedValue({ status: true });
  const getGasWithBuffer = vi.fn().mockResolvedValue(77n);
  const poolBalanceCap = vi.fn(async (amount: bigint, vault: { getAddress: () => Address }) => {
    return poolBalanceCaps[vault.getAddress()] ?? amount;
  });
  const log = {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };

  vi.doMock('../../src/utils/config.ts', () => ({
    config: {
      minRateDiff: 10,
      keeper: { logLevel: 'warn', haltIfLupBelowHtp: true, exitOnSubgraphFailure: false },
      oracle: {
        onchainPrimary: false,
        onchainMaxStaleness: null,
        fixedPrice: null,
        futureSkewTolerance: 120,
      },
      arkGlobal: { optimalBucketDiff: 1, maxAuctionAge: 259200, minMoveAmount: '1000001' },
      transaction: { confirmations: 1 },
      defaultGas: 3_000_000n,
      gasBuffer: 50n,
      chainId: 1,
      buffer: { address: BUFFER, allocation: 40 },
      arks: arkConfigs,
    },
    resolveArkSettings: () => ({
      optimalBucketDiff: 1n,
      bufferPadding: 0n,
      minMoveAmount: 1_000_001n,
      minTimeSinceBankruptcy: 0n,
      maxAuctionAge: 0,
    }),
  }));
  vi.doMock('../../src/ark/vault.ts', () => ({
    createVault: vi.fn((address: Address) => {
      const fixture = vaultFixtures[address];
      if (!fixture) throw new Error(`Missing vault fixture for ${address}`);
      return fixture;
    }),
  }));
  vi.doMock('../../src/metavault/metavault.ts', () => ({
    getExpectedSupplyAssets,
    getTotalExpectedSupplyAssets,
    reallocate,
  }));
  vi.doMock('../../src/metavault/utils/evaluateRates.ts', () => ({
    evaluateRates,
  }));
  vi.doMock('../../src/subgraph/poolHealth.ts', () => ({
    poolHasBadDebt: vi.fn().mockResolvedValue(false),
  }));
  vi.doMock('../../src/ark/utils/selectBuckets.ts', () => ({
    selectBuckets,
  }));
  vi.doMock('../../src/utils/transaction.ts', () => ({
    handleTransaction,
    getGasWithBuffer,
  }));
  vi.doMock('../../src/ajna/utils/poolBalanceCap.ts', () => ({
    poolBalanceCap,
  }));
  vi.doMock('../../src/utils/logger.ts', () => ({ log }));

  const { metavaultRun } = await import('../../src/keepers/metavaultKeeper.ts');

  return {
    metavaultRun,
    vaults: vaultFixtures,
    getTotalExpectedSupplyAssets,
    reallocate,
    selectBuckets,
    handleTransaction,
    getGasWithBuffer,
  };
}

describe('metavaultRun orchestration', () => {
  it('suppresses transaction-producing paths when any configured ark is paused', async () => {
    const pausedVault = buildVaultFixture(ARK_A, { paused: true, rate: 100n });
    const liveVault = buildVaultFixture(ARK_B, { rate: 300n });

    const {
      metavaultRun,
      getTotalExpectedSupplyAssets,
      reallocate,
      selectBuckets,
      handleTransaction,
    } = await setupMetavaultRunTest({
      balances: {
        [BUFFER]: 400n * S,
        [ARK_A]: 300n * S,
        [ARK_B]: 300n * S,
      },
      evaluations: [
        { address: ARK_A, targets: [ARK_B] },
        { address: ARK_B, targets: [] },
      ],
      bucketPlan: [{ bucket: 4150n, amount: 100n * S }],
      vaults: {
        [ARK_A]: pausedVault,
        [ARK_B]: liveVault,
      },
    });

    await metavaultRun();

    expect(getTotalExpectedSupplyAssets).not.toHaveBeenCalled();
    expect(selectBuckets).not.toHaveBeenCalled();
    expect(reallocate).not.toHaveBeenCalled();
    expect(handleTransaction).not.toHaveBeenCalled();
    expect(pausedVault.getBorrowFeeRate).not.toHaveBeenCalled();
    expect(pausedVault.drain).not.toHaveBeenCalled();
    expect(pausedVault.moveToBuffer).not.toHaveBeenCalled();
    expect(liveVault.getBorrowFeeRate).not.toHaveBeenCalled();
    expect(liveVault.drain).not.toHaveBeenCalled();
    expect(liveVault.moveToBuffer).not.toHaveBeenCalled();
  });

  it('drains the selected bucket and moves the exact decreased amount back to the buffer', async () => {
    const { metavaultRun, vaults, selectBuckets, handleTransaction, getGasWithBuffer, reallocate } =
      await setupMetavaultRunTest({
        balances: {
          [BUFFER]: 400n * S,
          [ARK_A]: 300n * S,
          [ARK_B]: 300n * S,
        },
        evaluations: [],
        bucketPlan: [{ bucket: 4150n, amount: 100n * S }],
      });

    const arkA = vaults[ARK_A]!;
    const arkB = vaults[ARK_B]!;

    await metavaultRun();

    expect(selectBuckets).toHaveBeenCalledOnce();
    expect(selectBuckets).toHaveBeenCalledWith(arkA, 100n * S);
    expect(arkA.drain).toHaveBeenCalledOnce();
    expect(arkA.drain).toHaveBeenCalledWith(4150n);
    expect(getGasWithBuffer).toHaveBeenCalledWith(
      'vault',
      'moveToBuffer',
      [4150n, 100n * S],
      ARK_A,
    );
    expect(arkA.moveToBuffer).toHaveBeenCalledOnce();
    expect(arkA.moveToBuffer).toHaveBeenCalledWith(4150n, 100n * S, 77n);
    expect(arkB.drain).not.toHaveBeenCalled();
    expect(arkB.moveToBuffer).not.toHaveBeenCalled();
    expect(reallocate).toHaveBeenCalledOnce();
    expect(reallocate).toHaveBeenCalledWith(
      [
        { id: ARK_A, assets: 200n * S },
        { id: ARK_B, assets: maxUint256 },
      ],
      3_000_000n,
    );
    expect(handleTransaction).toHaveBeenCalledTimes(3);
  });

  it('treats unchanged target allocations as a no-op and skips reallocate', async () => {
    const { metavaultRun, reallocate, selectBuckets, handleTransaction } =
      await setupMetavaultRunTest({
        balances: {
          [BUFFER]: 400n * S,
          [ARK_A]: 150n * S,
          [ARK_B]: 450n * S,
        },
        evaluations: [],
      });

    await metavaultRun();

    expect(selectBuckets).not.toHaveBeenCalled();
    expect(reallocate).not.toHaveBeenCalled();
    expect(handleTransaction).not.toHaveBeenCalled();
  });
});
