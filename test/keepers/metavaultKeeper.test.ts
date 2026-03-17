import { describe, it, expect, vi } from 'vitest';
import {
  _isRateReallocationRequired,
  _validateAllocations,
  _rebalanceBuffer,
  _reallocateForRates,
  _buildFinalAllocations,
  type ArkAllocation,
  type BufferAllocation,
} from '../../src/keepers/metavaultKeeper';
import { type ArkEvaluation } from '../../src/metavault/utils/evaluateRates';
import { type createVault } from '../../src/ark/vault';
import { type Address, maxUint256 } from 'viem';

vi.mock('../../src/utils/config', () => ({
  config: { minRateDiff: 10 },
}));

vi.mock('../../src/utils/env', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    env: { ...(original.env as Record<string, unknown>), MIN_MOVE_AMOUNT: 1_000_001n },
  };
});

const ADDR_A = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa' as Address;
const ADDR_B = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' as Address;
const ADDR_C = '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC' as Address;
const ADDR_BUF = '0xdDdDddDdDdddDDddDDddDDDDdDdDDdDDdDDDDDDd' as Address;

// Scale factor so all move amounts exceed MIN_MOVE_AMOUNT (1_000_001 default)
const S = 1_000_000n;

type Vault = ReturnType<typeof createVault>;
const stubVault = {} as Vault;

function makeArk(overrides: Partial<ArkAllocation> & { id: Address }): ArkAllocation {
  return {
    assets: 0n,
    initialAssets: 0n,
    vault: stubVault,
    min: 5,
    max: 20,
    rate: 100n,
    ...overrides,
  };
}

function makeBuffer(overrides?: Partial<BufferAllocation>): BufferAllocation {
  return {
    id: ADDR_BUF,
    assets: 400n * S,
    initialAssets: 400n * S,
    allocation: 40,
    ...overrides,
  };
}

// ============= _isRateReallocationRequired =============

describe('_isRateReallocationRequired', () => {
  it('returns false for an empty evaluations array', () => {
    expect(_isRateReallocationRequired([])).toBe(false);
  });

  it('returns false when no ark has any targets', () => {
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [] },
      { address: ADDR_B, targets: [] },
    ];
    expect(_isRateReallocationRequired(evaluations)).toBe(false);
  });

  it('returns true when any ark has at least one target', () => {
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B] },
      { address: ADDR_B, targets: [] },
    ];
    expect(_isRateReallocationRequired(evaluations)).toBe(true);
  });

  it('returns true when all arks have targets', () => {
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B] },
      { address: ADDR_B, targets: [ADDR_A] },
    ];
    expect(_isRateReallocationRequired(evaluations)).toBe(true);
  });
});

// ============= _rebalanceBuffer =============

describe('_rebalanceBuffer', () => {
  // totalAssets = 1000n * S for clean percentage math

  it('does nothing when buffer is exactly at target', () => {
    const arks = [makeArk({ id: ADDR_A, assets: 200n * S, rate: 100n })];
    const buffer = makeBuffer({ assets: 400n * S });

    _rebalanceBuffer(arks, buffer, 1000n * S);

    expect(arks[0]!.assets).toBe(200n * S);
    expect(buffer.assets).toBe(400n * S);
  });

  describe('buffer deficit (fillBuffer)', () => {
    it('fills buffer from lowest-rate ark', () => {
      const arks = [
        makeArk({ id: ADDR_A, assets: 200n * S, rate: 200n }),
        makeArk({ id: ADDR_B, assets: 200n * S, rate: 100n }),
      ];
      const buffer = makeBuffer({ assets: 350n * S });

      _rebalanceBuffer(arks, buffer, 1000n * S);

      // Buffer deficit = 50 * S
      // Lowest rate is B (100). B has 200*S, min = 50*S (5%), available = 150*S
      // Deduct 50*S from B
      expect(arks[1]!.assets).toBe(150n * S); // B reduced
      expect(arks[0]!.assets).toBe(200n * S); // A untouched
      expect(buffer.assets).toBe(400n * S);
    });

    it('fills from multiple arks when lowest-rate ark hits min', () => {
      const arks = [
        makeArk({ id: ADDR_A, assets: 200n * S, rate: 200n }),
        makeArk({ id: ADDR_B, assets: 70n * S, rate: 100n }),
      ];
      const buffer = makeBuffer({ assets: 350n * S });

      _rebalanceBuffer(arks, buffer, 1000n * S);

      // Buffer deficit = 50*S
      // B (lowest rate): 70*S - 50*S (min) = 20*S available, deduct 20*S
      // A (next lowest): 200*S - 50*S (min) = 150*S available, deduct remaining 30*S
      expect(arks[1]!.assets).toBe(50n * S); // B at min
      expect(arks[0]!.assets).toBe(170n * S); // A lost 30*S
      expect(buffer.assets).toBe(400n * S);
    });

    it('skips arks already at their minimum', () => {
      const arks = [
        makeArk({ id: ADDR_A, assets: 200n * S, rate: 200n }),
        makeArk({ id: ADDR_B, assets: 50n * S, rate: 100n }), // already at min (5% of 1000*S)
      ];
      const buffer = makeBuffer({ assets: 380n * S });

      _rebalanceBuffer(arks, buffer, 1000n * S);

      // Buffer deficit = 20*S
      // B at min, skip. A: 200*S - 50*S = 150*S available, deduct 20*S
      expect(arks[1]!.assets).toBe(50n * S);
      expect(arks[0]!.assets).toBe(180n * S);
      expect(buffer.assets).toBe(400n * S);
    });

    it('fills from three arks in rate order (lowest first)', () => {
      const arks = [
        makeArk({ id: ADDR_A, assets: 70n * S, rate: 300n }),
        makeArk({ id: ADDR_B, assets: 70n * S, rate: 100n }),
        makeArk({ id: ADDR_C, assets: 70n * S, rate: 200n }),
      ];
      const buffer = makeBuffer({ assets: 340n * S });

      _rebalanceBuffer(arks, buffer, 1000n * S);

      // Buffer deficit = 60*S
      // Rate order: B(100), C(200), A(300)
      // B: 70*S - 50*S = 20*S available, deduct 20*S
      // C: 70*S - 50*S = 20*S available, deduct 20*S
      // A: 70*S - 50*S = 20*S available, deduct 20*S
      expect(arks[1]!.assets).toBe(50n * S);
      expect(arks[2]!.assets).toBe(50n * S);
      expect(arks[0]!.assets).toBe(50n * S);
      expect(buffer.assets).toBe(400n * S);
    });
  });

  describe('buffer excess (drainBuffer)', () => {
    it('drains excess to highest-rate ark', () => {
      const arks = [
        makeArk({ id: ADDR_A, assets: 100n * S, rate: 100n }),
        makeArk({ id: ADDR_B, assets: 100n * S, rate: 200n }),
      ];
      const buffer = makeBuffer({ assets: 450n * S });

      _rebalanceBuffer(arks, buffer, 1000n * S);

      // Excess = 50*S
      // Highest rate is B(200). B: max = 200*S (20%), capacity = 100*S, add 50*S
      expect(arks[1]!.assets).toBe(150n * S); // B increased
      expect(arks[0]!.assets).toBe(100n * S); // A untouched
      expect(buffer.assets).toBe(400n * S);
    });

    it('drains to multiple arks when highest-rate hits max', () => {
      const arks = [
        makeArk({ id: ADDR_A, assets: 100n * S, rate: 100n }),
        makeArk({ id: ADDR_B, assets: 190n * S, rate: 200n }),
      ];
      const buffer = makeBuffer({ assets: 450n * S });

      _rebalanceBuffer(arks, buffer, 1000n * S);

      // Excess = 50*S
      // B (highest rate): max 200*S, capacity = 10*S, add 10*S
      // A (next highest): max 200*S, capacity = 100*S, add 40*S
      expect(arks[1]!.assets).toBe(200n * S); // B at max
      expect(arks[0]!.assets).toBe(140n * S);
      expect(buffer.assets).toBe(400n * S);
    });

    it('excess stays in buffer when all arks hit max', () => {
      const arks = [
        makeArk({ id: ADDR_A, assets: 200n * S, rate: 100n }),
        makeArk({ id: ADDR_B, assets: 200n * S, rate: 200n }),
      ];
      const buffer = makeBuffer({ assets: 500n * S });

      _rebalanceBuffer(arks, buffer, 1000n * S);

      // Excess = 100*S, but both arks are already at max (200*S = 20%)
      expect(arks[0]!.assets).toBe(200n * S);
      expect(arks[1]!.assets).toBe(200n * S);
      expect(buffer.assets).toBe(500n * S); // excess stays
    });

    it('drains to three arks in rate order (highest first)', () => {
      const arks = [
        makeArk({ id: ADDR_A, assets: 180n * S, rate: 300n }),
        makeArk({ id: ADDR_B, assets: 180n * S, rate: 100n }),
        makeArk({ id: ADDR_C, assets: 180n * S, rate: 200n }),
      ];
      const buffer = makeBuffer({ assets: 460n * S });

      _rebalanceBuffer(arks, buffer, 1000n * S);

      // Excess = 60*S
      // Rate order (desc): A(300), C(200), B(100)
      // A: max 200*S, capacity = 20*S, add 20*S
      // C: max 200*S, capacity = 20*S, add 20*S
      // B: max 200*S, capacity = 20*S, add 20*S
      expect(arks[0]!.assets).toBe(200n * S);
      expect(arks[2]!.assets).toBe(200n * S);
      expect(arks[1]!.assets).toBe(200n * S);
      expect(buffer.assets).toBe(400n * S);
    });
  });
});

// ============= _reallocateForRates =============

describe('_reallocateForRates', () => {
  it('moves from lowest-rate to highest-rate ark', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 150n * S, min: 5, max: 20, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 150n * S, min: 5, max: 20, rate: 200n }),
    ];
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B] },
      { address: ADDR_B, targets: [] },
    ];

    _reallocateForRates(arks, evaluations, 1000n * S);

    // A: 150*S - 50*S (min) = 100*S available. B: 200*S (max) - 150*S = 50*S capacity
    // Move min(100*S, 50*S) = 50*S
    expect(arks[0]!.assets).toBe(100n * S);
    expect(arks[1]!.assets).toBe(200n * S);
  });

  it('respects min allocation for source ark', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 80n * S, min: 5, max: 20, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 100n * S, min: 5, max: 20, rate: 200n }),
    ];
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B] },
      { address: ADDR_B, targets: [] },
    ];

    _reallocateForRates(arks, evaluations, 1000n * S);

    // A: 80*S - 50*S = 30*S available. B: 200*S - 100*S = 100*S capacity. Move 30*S
    expect(arks[0]!.assets).toBe(50n * S); // at min
    expect(arks[1]!.assets).toBe(130n * S);
  });

  it('respects max allocation for target ark', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 200n * S, min: 5, max: 20, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 180n * S, min: 5, max: 20, rate: 200n }),
    ];
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B] },
      { address: ADDR_B, targets: [] },
    ];

    _reallocateForRates(arks, evaluations, 1000n * S);

    // A: 200*S - 50*S = 150*S available. B: 200*S - 180*S = 20*S capacity. Move 20*S
    expect(arks[0]!.assets).toBe(180n * S);
    expect(arks[1]!.assets).toBe(200n * S); // at max
  });

  it('does nothing when source is already at min', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 50n * S, min: 5, max: 20, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 100n * S, min: 5, max: 20, rate: 200n }),
    ];
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B] },
      { address: ADDR_B, targets: [] },
    ];

    _reallocateForRates(arks, evaluations, 1000n * S);

    expect(arks[0]!.assets).toBe(50n * S);
    expect(arks[1]!.assets).toBe(100n * S);
  });

  it('does nothing when target is already at max', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 150n * S, min: 5, max: 20, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 200n * S, min: 5, max: 20, rate: 200n }),
    ];
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B] },
      { address: ADDR_B, targets: [] },
    ];

    _reallocateForRates(arks, evaluations, 1000n * S);

    expect(arks[0]!.assets).toBe(150n * S);
    expect(arks[1]!.assets).toBe(200n * S);
  });

  it('processes arks lowest to highest rate', () => {
    // A(rate=100) should be processed before C(rate=200)
    const arks = [
      makeArk({ id: ADDR_A, assets: 150n * S, min: 5, max: 20, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 100n * S, min: 5, max: 20, rate: 300n }),
      makeArk({ id: ADDR_C, assets: 150n * S, min: 5, max: 20, rate: 200n }),
    ];
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B] },
      { address: ADDR_B, targets: [] },
      { address: ADDR_C, targets: [ADDR_B] },
    ];

    _reallocateForRates(arks, evaluations, 1000n * S);

    // A (rate 100, processed first): available = 150*S-50*S = 100*S. B capacity = 200*S-100*S = 100*S. Move 100*S
    // After A: A=50*S, B=200*S
    // C (rate 200, processed second): available = 150*S-50*S = 100*S. B capacity = 200*S-200*S = 0. No move
    expect(arks[0]!.assets).toBe(50n * S); // A drained to min
    expect(arks[1]!.assets).toBe(200n * S); // B at max
    expect(arks[2]!.assets).toBe(150n * S); // C unchanged
  });

  it('moves to next target when first target hits max', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 150n * S, min: 5, max: 20, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 180n * S, min: 5, max: 20, rate: 300n }),
      makeArk({ id: ADDR_C, assets: 100n * S, min: 5, max: 20, rate: 250n }),
    ];
    // A targets B first, then C (sorted by rate desc in evaluateRates)
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B, ADDR_C] },
      { address: ADDR_B, targets: [] },
      { address: ADDR_C, targets: [] },
    ];

    _reallocateForRates(arks, evaluations, 1000n * S);

    // A: available = 150*S-50*S = 100*S
    // B: capacity = 200*S-180*S = 20*S. Move 20*S to B. A=130*S, available=80*S
    // C: capacity = 200*S-100*S = 100*S. Move 80*S to C. A=50*S, C=180*S
    expect(arks[0]!.assets).toBe(50n * S);
    expect(arks[1]!.assets).toBe(200n * S);
    expect(arks[2]!.assets).toBe(180n * S);
  });

  it('does nothing when evaluations have no targets', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 150n * S, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 150n * S, rate: 100n }),
    ];
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [] },
      { address: ADDR_B, targets: [] },
    ];

    _reallocateForRates(arks, evaluations, 1000n * S);

    expect(arks[0]!.assets).toBe(150n * S);
    expect(arks[1]!.assets).toBe(150n * S);
  });
});

// ============= _validateAllocations =============

describe('_validateAllocations', () => {
  const totalAssets = 1000n * S;

  it('passes when all arks within range and buffer at target', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 100n * S, min: 5, max: 20 }),
      makeArk({ id: ADDR_B, assets: 150n * S, min: 5, max: 20 }),
    ];
    const buffer = makeBuffer({ assets: 400n * S, allocation: 40 });

    expect(() => _validateAllocations(arks, buffer, totalAssets)).not.toThrow();
  });

  it('throws when ark is below min', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 30n * S, min: 5, max: 20 }), // 30*S < 50*S (5%)
    ];
    const buffer = makeBuffer({ assets: 400n * S });

    expect(() => _validateAllocations(arks, buffer, totalAssets)).toThrow('below min');
  });

  it('throws when ark is above max', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 250n * S, min: 5, max: 20 }), // 250*S > 200*S (20%)
    ];
    const buffer = makeBuffer({ assets: 400n * S });

    expect(() => _validateAllocations(arks, buffer, totalAssets)).toThrow('above max');
  });

  it('passes when arks at exact min and max boundaries', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 50n * S, min: 5, max: 20 }), // exactly at min
      makeArk({ id: ADDR_B, assets: 200n * S, min: 5, max: 20 }), // exactly at max
    ];
    const buffer = makeBuffer({ assets: 400n * S });

    expect(() => _validateAllocations(arks, buffer, totalAssets)).not.toThrow();
  });

  it('throws when buffer does not equal target and not all arks at max', () => {
    const arks = [makeArk({ id: ADDR_A, assets: 100n * S, min: 5, max: 20 })];
    const buffer = makeBuffer({ assets: 350n * S, allocation: 40 }); // 350*S !== 400*S

    expect(() => _validateAllocations(arks, buffer, totalAssets)).toThrow('does not equal target');
  });

  it('passes when all arks at max and buffer above target', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 200n * S, min: 5, max: 20 }),
      makeArk({ id: ADDR_B, assets: 200n * S, min: 5, max: 20 }),
    ];
    const buffer = makeBuffer({ assets: 500n * S, allocation: 40 }); // 500*S > 400*S

    expect(() => _validateAllocations(arks, buffer, totalAssets)).not.toThrow();
  });

  it('passes when all arks at max and buffer exactly at target', () => {
    const arks = [makeArk({ id: ADDR_A, assets: 200n * S, min: 5, max: 20 })];
    const buffer = makeBuffer({ assets: 400n * S, allocation: 40 });

    expect(() => _validateAllocations(arks, buffer, totalAssets)).not.toThrow();
  });

  it('throws when all arks at max but buffer below target', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 200n * S, min: 5, max: 20 }),
      makeArk({ id: ADDR_B, assets: 200n * S, min: 5, max: 20 }),
    ];
    const buffer = makeBuffer({ assets: 350n * S, allocation: 40 }); // 350*S < 400*S

    expect(() => _validateAllocations(arks, buffer, totalAssets)).toThrow('below target');
  });
});

// ============= _buildFinalAllocations =============

describe('_buildFinalAllocations', () => {
  it('returns empty array when no allocations changed', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 100n * S, initialAssets: 100n * S }),
      makeArk({ id: ADDR_B, assets: 200n * S, initialAssets: 200n * S }),
    ];
    const buffer = makeBuffer({ assets: 400n * S, initialAssets: 400n * S });

    const result = _buildFinalAllocations(arks, buffer);
    expect(result).toEqual([]);
  });

  it('places decreasing allocations before increasing', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 200n * S, initialAssets: 300n * S }), // decreasing
      makeArk({ id: ADDR_B, assets: 200n * S, initialAssets: 100n * S }), // increasing
    ];
    const buffer = makeBuffer({ assets: 400n * S, initialAssets: 400n * S });

    const result = _buildFinalAllocations(arks, buffer);

    expect(result[0]!.id).toBe(ADDR_A); // decreasing first
    expect(result[0]!.assets).toBe(200n * S);
    expect(result[1]!.id).toBe(ADDR_B); // increasing last
  });

  it('sets maxUint256 on the last increasing allocation', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 200n * S, initialAssets: 300n * S }),
      makeArk({ id: ADDR_B, assets: 200n * S, initialAssets: 100n * S }),
    ];
    const buffer = makeBuffer({ assets: 400n * S, initialAssets: 400n * S });

    const result = _buildFinalAllocations(arks, buffer);

    expect(result[result.length - 1]!.assets).toBe(maxUint256);
  });

  it('handles multiple decreasing and multiple increasing entries', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 80n * S, initialAssets: 150n * S }), // decreasing (-70)
      makeArk({ id: ADDR_B, assets: 250n * S, initialAssets: 200n * S }), // increasing (+50)
      makeArk({ id: ADDR_C, assets: 230n * S, initialAssets: 160n * S }), // increasing (+70)
    ];
    const buffer = makeBuffer({ assets: 350n * S, initialAssets: 400n * S }); // decreasing (-50)

    // totalWithdrawn = 70 + 50 = 120, totalSupplied = 50 + 70 = 120
    const result = _buildFinalAllocations(arks, buffer);

    const decreasingIds = result.slice(0, 2).map((a) => a.id);
    expect(decreasingIds).toContain(ADDR_A);
    expect(decreasingIds).toContain(ADDR_BUF);

    // Increasing: B, C — last two, final one has maxUint256
    expect(result.length).toBe(4);
    expect(result[3]!.assets).toBe(maxUint256);
  });

  it('excludes unchanged allocations', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 100n * S, initialAssets: 100n * S }), // unchanged
      makeArk({ id: ADDR_B, assets: 350n * S, initialAssets: 200n * S }), // increasing
    ];
    const buffer = makeBuffer({ assets: 350n * S, initialAssets: 500n * S }); // decreasing

    // sum(dec assets) = 350*S, sum(inc assets) = 350*S
    const result = _buildFinalAllocations(arks, buffer);

    expect(result.length).toBe(2);
    expect(result[0]!.id).toBe(ADDR_BUF); // decreasing
    expect(result[0]!.assets).toBe(350n * S);
    expect(result[1]!.id).toBe(ADDR_B); // increasing (maxUint256)
    expect(result[1]!.assets).toBe(maxUint256);
  });

  it('throws when only decreasing entries exist with no increasing', () => {
    const arks = [makeArk({ id: ADDR_A, assets: 80n * S, initialAssets: 100n * S })];
    const buffer = makeBuffer({ assets: 380n * S, initialAssets: 400n * S });

    expect(() => _buildFinalAllocations(arks, buffer)).toThrow('inconsistent reallocation');
  });

  it('throws when only increasing entries exist with no decreasing', () => {
    const arks = [makeArk({ id: ADDR_A, assets: 120n * S, initialAssets: 100n * S })];
    const buffer = makeBuffer({ assets: 420n * S, initialAssets: 400n * S });

    expect(() => _buildFinalAllocations(arks, buffer)).toThrow('inconsistent reallocation');
  });

  it('throws when increasing and decreasing deltas are mismatched', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 80n * S, initialAssets: 100n * S }), // withdrawn: 20
    ];
    const buffer = makeBuffer({ assets: 450n * S, initialAssets: 400n * S }); // supplied: 50

    // totalWithdrawn = 20, totalSupplied = 50 — not equal
    expect(() => _buildFinalAllocations(arks, buffer)).toThrow('inconsistent reallocation');
  });

  it('buffer can be the last increasing entry and receive maxUint256', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 350n * S, initialAssets: 500n * S }), // decreasing
    ];
    const buffer = makeBuffer({ assets: 350n * S, initialAssets: 200n * S }); // increasing

    // sum(dec assets) = 350*S, sum(inc assets) = 350*S
    const result = _buildFinalAllocations(arks, buffer);

    expect(result[0]!.id).toBe(ADDR_A);
    expect(result[0]!.assets).toBe(350n * S);
    expect(result[1]!.id).toBe(ADDR_BUF);
    expect(result[1]!.assets).toBe(maxUint256);
  });
});
