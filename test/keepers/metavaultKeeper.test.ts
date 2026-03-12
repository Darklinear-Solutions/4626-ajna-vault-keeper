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

const ADDR_A = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa' as Address;
const ADDR_B = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' as Address;
const ADDR_C = '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC' as Address;
const ADDR_BUF = '0xdDdDddDdDdddDDddDDddDDDDdDdDDdDDdDDDDDDd' as Address;

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
    assets: 400n,
    initialAssets: 400n,
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
  // totalAssets = 1000n for clean percentage math

  it('does nothing when buffer is exactly at target', () => {
    const arks = [makeArk({ id: ADDR_A, assets: 200n, rate: 100n })];
    const buffer = makeBuffer({ assets: 400n });

    _rebalanceBuffer(arks, buffer, 1000n);

    expect(arks[0]!.assets).toBe(200n);
    expect(buffer.assets).toBe(400n);
  });

  describe('buffer deficit (fillBuffer)', () => {
    it('fills buffer from lowest-rate ark', () => {
      const arks = [
        makeArk({ id: ADDR_A, assets: 200n, rate: 200n }),
        makeArk({ id: ADDR_B, assets: 200n, rate: 100n }),
      ];
      const buffer = makeBuffer({ assets: 350n });

      _rebalanceBuffer(arks, buffer, 1000n);

      // Buffer deficit = 400 - 350 = 50
      // Lowest rate is B (100). B has 200, min = 50 (5%), available = 150
      // Deduct 50 from B
      expect(arks[1]!.assets).toBe(150n); // B reduced
      expect(arks[0]!.assets).toBe(200n); // A untouched
      expect(buffer.assets).toBe(400n);
    });

    it('fills from multiple arks when lowest-rate ark hits min', () => {
      const arks = [
        makeArk({ id: ADDR_A, assets: 200n, rate: 200n }),
        makeArk({ id: ADDR_B, assets: 70n, rate: 100n }),
      ];
      const buffer = makeBuffer({ assets: 350n });

      _rebalanceBuffer(arks, buffer, 1000n);

      // Buffer deficit = 50
      // B (lowest rate): 70 - 50 (min) = 20 available, deduct 20
      // A (next lowest): 200 - 50 (min) = 150 available, deduct remaining 30
      expect(arks[1]!.assets).toBe(50n); // B at min
      expect(arks[0]!.assets).toBe(170n); // A lost 30
      expect(buffer.assets).toBe(400n);
    });

    it('skips arks already at their minimum', () => {
      const arks = [
        makeArk({ id: ADDR_A, assets: 200n, rate: 200n }),
        makeArk({ id: ADDR_B, assets: 50n, rate: 100n }), // already at min (5% of 1000)
      ];
      const buffer = makeBuffer({ assets: 380n });

      _rebalanceBuffer(arks, buffer, 1000n);

      // Buffer deficit = 20
      // B at min, skip. A: 200 - 50 = 150 available, deduct 20
      expect(arks[1]!.assets).toBe(50n);
      expect(arks[0]!.assets).toBe(180n);
      expect(buffer.assets).toBe(400n);
    });

    it('fills from three arks in rate order (lowest first)', () => {
      const arks = [
        makeArk({ id: ADDR_A, assets: 70n, rate: 300n }),
        makeArk({ id: ADDR_B, assets: 70n, rate: 100n }),
        makeArk({ id: ADDR_C, assets: 70n, rate: 200n }),
      ];
      const buffer = makeBuffer({ assets: 340n });

      _rebalanceBuffer(arks, buffer, 1000n);

      // Buffer deficit = 60
      // Rate order: B(100), C(200), A(300)
      // B: 70 - 50 = 20 available, deduct 20
      // C: 70 - 50 = 20 available, deduct 20
      // A: 70 - 50 = 20 available, deduct 20
      expect(arks[1]!.assets).toBe(50n);
      expect(arks[2]!.assets).toBe(50n);
      expect(arks[0]!.assets).toBe(50n);
      expect(buffer.assets).toBe(400n);
    });
  });

  describe('buffer excess (drainBuffer)', () => {
    it('drains excess to highest-rate ark', () => {
      const arks = [
        makeArk({ id: ADDR_A, assets: 100n, rate: 100n }),
        makeArk({ id: ADDR_B, assets: 100n, rate: 200n }),
      ];
      const buffer = makeBuffer({ assets: 450n });

      _rebalanceBuffer(arks, buffer, 1000n);

      // Excess = 50
      // Highest rate is B(200). B: max = 200 (20%), capacity = 100, add 50
      expect(arks[1]!.assets).toBe(150n); // B increased
      expect(arks[0]!.assets).toBe(100n); // A untouched
      expect(buffer.assets).toBe(400n);
    });

    it('drains to multiple arks when highest-rate hits max', () => {
      const arks = [
        makeArk({ id: ADDR_A, assets: 100n, rate: 100n }),
        makeArk({ id: ADDR_B, assets: 190n, rate: 200n }),
      ];
      const buffer = makeBuffer({ assets: 450n });

      _rebalanceBuffer(arks, buffer, 1000n);

      // Excess = 50
      // B (highest rate): max 200, capacity = 10, add 10
      // A (next highest): max 200, capacity = 100, add 40
      expect(arks[1]!.assets).toBe(200n); // B at max
      expect(arks[0]!.assets).toBe(140n);
      expect(buffer.assets).toBe(400n);
    });

    it('excess stays in buffer when all arks hit max', () => {
      const arks = [
        makeArk({ id: ADDR_A, assets: 200n, rate: 100n }),
        makeArk({ id: ADDR_B, assets: 200n, rate: 200n }),
      ];
      const buffer = makeBuffer({ assets: 500n });

      _rebalanceBuffer(arks, buffer, 1000n);

      // Excess = 100, but both arks are already at max (200 = 20%)
      expect(arks[0]!.assets).toBe(200n);
      expect(arks[1]!.assets).toBe(200n);
      expect(buffer.assets).toBe(500n); // excess stays
    });

    it('drains to three arks in rate order (highest first)', () => {
      const arks = [
        makeArk({ id: ADDR_A, assets: 180n, rate: 300n }),
        makeArk({ id: ADDR_B, assets: 180n, rate: 100n }),
        makeArk({ id: ADDR_C, assets: 180n, rate: 200n }),
      ];
      const buffer = makeBuffer({ assets: 460n });

      _rebalanceBuffer(arks, buffer, 1000n);

      // Excess = 60
      // Rate order (desc): A(300), C(200), B(100)
      // A: max 200, capacity = 20, add 20
      // C: max 200, capacity = 20, add 20
      // B: max 200, capacity = 20, add 20
      expect(arks[0]!.assets).toBe(200n);
      expect(arks[2]!.assets).toBe(200n);
      expect(arks[1]!.assets).toBe(200n);
      expect(buffer.assets).toBe(400n);
    });
  });
});

// ============= _reallocateForRates =============

describe('_reallocateForRates', () => {
  it('moves from lowest-rate to highest-rate ark', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 150n, min: 5, max: 20, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 150n, min: 5, max: 20, rate: 200n }),
    ];
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B] },
      { address: ADDR_B, targets: [] },
    ];

    _reallocateForRates(arks, evaluations, 1000n);

    // A: 150 - 50 (min) = 100 available. B: 200 (max) - 150 = 50 capacity
    // Move min(100, 50) = 50
    expect(arks[0]!.assets).toBe(100n);
    expect(arks[1]!.assets).toBe(200n);
  });

  it('respects min allocation for source ark', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 80n, min: 5, max: 20, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 100n, min: 5, max: 20, rate: 200n }),
    ];
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B] },
      { address: ADDR_B, targets: [] },
    ];

    _reallocateForRates(arks, evaluations, 1000n);

    // A: 80 - 50 = 30 available. B: 200 - 100 = 100 capacity. Move 30
    expect(arks[0]!.assets).toBe(50n); // at min
    expect(arks[1]!.assets).toBe(130n);
  });

  it('respects max allocation for target ark', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 200n, min: 5, max: 20, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 180n, min: 5, max: 20, rate: 200n }),
    ];
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B] },
      { address: ADDR_B, targets: [] },
    ];

    _reallocateForRates(arks, evaluations, 1000n);

    // A: 200 - 50 = 150 available. B: 200 - 180 = 20 capacity. Move 20
    expect(arks[0]!.assets).toBe(180n);
    expect(arks[1]!.assets).toBe(200n); // at max
  });

  it('does nothing when source is already at min', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 50n, min: 5, max: 20, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 100n, min: 5, max: 20, rate: 200n }),
    ];
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B] },
      { address: ADDR_B, targets: [] },
    ];

    _reallocateForRates(arks, evaluations, 1000n);

    expect(arks[0]!.assets).toBe(50n);
    expect(arks[1]!.assets).toBe(100n);
  });

  it('does nothing when target is already at max', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 150n, min: 5, max: 20, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 200n, min: 5, max: 20, rate: 200n }),
    ];
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B] },
      { address: ADDR_B, targets: [] },
    ];

    _reallocateForRates(arks, evaluations, 1000n);

    expect(arks[0]!.assets).toBe(150n);
    expect(arks[1]!.assets).toBe(200n);
  });

  it('processes arks lowest to highest rate', () => {
    // A(rate=100) should be processed before C(rate=200)
    const arks = [
      makeArk({ id: ADDR_A, assets: 150n, min: 5, max: 20, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 100n, min: 5, max: 20, rate: 300n }),
      makeArk({ id: ADDR_C, assets: 150n, min: 5, max: 20, rate: 200n }),
    ];
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B] },
      { address: ADDR_B, targets: [] },
      { address: ADDR_C, targets: [ADDR_B] },
    ];

    _reallocateForRates(arks, evaluations, 1000n);

    // A (rate 100, processed first): available = 150-50 = 100. B capacity = 200-100 = 100. Move 100
    // After A: A=50, B=200
    // C (rate 200, processed second): available = 150-50 = 100. B capacity = 200-200 = 0. No move
    expect(arks[0]!.assets).toBe(50n); // A drained to min
    expect(arks[1]!.assets).toBe(200n); // B at max
    expect(arks[2]!.assets).toBe(150n); // C unchanged
  });

  it('moves to next target when first target hits max', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 150n, min: 5, max: 20, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 180n, min: 5, max: 20, rate: 300n }),
      makeArk({ id: ADDR_C, assets: 100n, min: 5, max: 20, rate: 250n }),
    ];
    // A targets B first, then C (sorted by rate desc in evaluateRates)
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B, ADDR_C] },
      { address: ADDR_B, targets: [] },
      { address: ADDR_C, targets: [] },
    ];

    _reallocateForRates(arks, evaluations, 1000n);

    // A: available = 150-50 = 100
    // B: capacity = 200-180 = 20. Move 20 to B. A=130, available=80
    // C: capacity = 200-100 = 100. Move 80 to C. A=50, C=180
    expect(arks[0]!.assets).toBe(50n);
    expect(arks[1]!.assets).toBe(200n);
    expect(arks[2]!.assets).toBe(180n);
  });

  it('does nothing when evaluations have no targets', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 150n, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 150n, rate: 100n }),
    ];
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [] },
      { address: ADDR_B, targets: [] },
    ];

    _reallocateForRates(arks, evaluations, 1000n);

    expect(arks[0]!.assets).toBe(150n);
    expect(arks[1]!.assets).toBe(150n);
  });
});

// ============= _validateAllocations =============

describe('_validateAllocations', () => {
  const totalAssets = 1000n;

  it('passes when all arks within range and buffer at target', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 100n, min: 5, max: 20 }),
      makeArk({ id: ADDR_B, assets: 150n, min: 5, max: 20 }),
    ];
    const buffer = makeBuffer({ assets: 400n, allocation: 40 });

    expect(() => _validateAllocations(arks, buffer, totalAssets)).not.toThrow();
  });

  it('throws when ark is below min', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 30n, min: 5, max: 20 }), // 30 < 50 (5%)
    ];
    const buffer = makeBuffer({ assets: 400n });

    expect(() => _validateAllocations(arks, buffer, totalAssets)).toThrow('below min');
  });

  it('throws when ark is above max', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 250n, min: 5, max: 20 }), // 250 > 200 (20%)
    ];
    const buffer = makeBuffer({ assets: 400n });

    expect(() => _validateAllocations(arks, buffer, totalAssets)).toThrow('above max');
  });

  it('passes when arks at exact min and max boundaries', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 50n, min: 5, max: 20 }), // exactly at min
      makeArk({ id: ADDR_B, assets: 200n, min: 5, max: 20 }), // exactly at max
    ];
    const buffer = makeBuffer({ assets: 400n });

    expect(() => _validateAllocations(arks, buffer, totalAssets)).not.toThrow();
  });

  it('throws when buffer does not equal target and not all arks at max', () => {
    const arks = [makeArk({ id: ADDR_A, assets: 100n, min: 5, max: 20 })];
    const buffer = makeBuffer({ assets: 350n, allocation: 40 }); // 350 !== 400

    expect(() => _validateAllocations(arks, buffer, totalAssets)).toThrow('does not equal target');
  });

  it('passes when all arks at max and buffer above target', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 200n, min: 5, max: 20 }),
      makeArk({ id: ADDR_B, assets: 200n, min: 5, max: 20 }),
    ];
    const buffer = makeBuffer({ assets: 500n, allocation: 40 }); // 500 > 400

    expect(() => _validateAllocations(arks, buffer, totalAssets)).not.toThrow();
  });

  it('passes when all arks at max and buffer exactly at target', () => {
    const arks = [makeArk({ id: ADDR_A, assets: 200n, min: 5, max: 20 })];
    const buffer = makeBuffer({ assets: 400n, allocation: 40 });

    expect(() => _validateAllocations(arks, buffer, totalAssets)).not.toThrow();
  });

  it('throws when all arks at max but buffer below target', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 200n, min: 5, max: 20 }),
      makeArk({ id: ADDR_B, assets: 200n, min: 5, max: 20 }),
    ];
    const buffer = makeBuffer({ assets: 350n, allocation: 40 }); // 350 < 400

    expect(() => _validateAllocations(arks, buffer, totalAssets)).toThrow('below target');
  });
});

// ============= _buildFinalAllocations =============

describe('_buildFinalAllocations', () => {
  it('returns empty array when no allocations changed', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 100n, initialAssets: 100n }),
      makeArk({ id: ADDR_B, assets: 200n, initialAssets: 200n }),
    ];
    const buffer = makeBuffer({ assets: 400n, initialAssets: 400n });

    const result = _buildFinalAllocations(arks, buffer);
    expect(result).toEqual([]);
  });

  it('places decreasing allocations before increasing', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 150n, initialAssets: 200n }), // decreasing
      makeArk({ id: ADDR_B, assets: 250n, initialAssets: 200n }), // increasing
    ];
    const buffer = makeBuffer({ assets: 400n, initialAssets: 400n });

    const result = _buildFinalAllocations(arks, buffer);

    expect(result[0]!.id).toBe(ADDR_A); // decreasing first
    expect(result[0]!.assets).toBe(150n);
    expect(result[1]!.id).toBe(ADDR_B); // increasing last
  });

  it('sets maxUint256 on the last increasing allocation', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 150n, initialAssets: 200n }),
      makeArk({ id: ADDR_B, assets: 250n, initialAssets: 200n }),
    ];
    const buffer = makeBuffer({ assets: 400n, initialAssets: 400n });

    const result = _buildFinalAllocations(arks, buffer);

    expect(result[result.length - 1]!.assets).toBe(maxUint256);
  });

  it('handles multiple decreasing and multiple increasing entries', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 80n, initialAssets: 150n }), // decreasing
      makeArk({ id: ADDR_B, assets: 250n, initialAssets: 200n }), // increasing
      makeArk({ id: ADDR_C, assets: 220n, initialAssets: 200n }), // increasing
    ];
    const buffer = makeBuffer({ assets: 350n, initialAssets: 400n }); // decreasing

    const result = _buildFinalAllocations(arks, buffer);

    // Decreasing: A (80), buffer (350) — first two
    const decreasingIds = result.slice(0, 2).map((a) => a.id);
    expect(decreasingIds).toContain(ADDR_A);
    expect(decreasingIds).toContain(ADDR_BUF);

    // Increasing: B, C — last two, final one has maxUint256
    expect(result.length).toBe(4);
    expect(result[3]!.assets).toBe(maxUint256);
  });

  it('excludes unchanged allocations', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 100n, initialAssets: 100n }), // unchanged
      makeArk({ id: ADDR_B, assets: 250n, initialAssets: 200n }), // increasing
    ];
    const buffer = makeBuffer({ assets: 350n, initialAssets: 400n }); // decreasing

    const result = _buildFinalAllocations(arks, buffer);

    expect(result.length).toBe(2);
    expect(result[0]!.id).toBe(ADDR_BUF); // decreasing
    expect(result[0]!.assets).toBe(350n);
    expect(result[1]!.id).toBe(ADDR_B); // increasing (maxUint256)
    expect(result[1]!.assets).toBe(maxUint256);
  });

  it('handles only decreasing entries with no increasing', () => {
    // Edge case: if somehow only decreasing entries exist
    const arks = [makeArk({ id: ADDR_A, assets: 80n, initialAssets: 100n })];
    const buffer = makeBuffer({ assets: 380n, initialAssets: 400n });

    const result = _buildFinalAllocations(arks, buffer);

    // Both decreasing, no increasing => ordered decreasing, no maxUint256
    expect(result.length).toBe(2);
    expect(result[0]!.assets).toBe(80n);
    expect(result[1]!.assets).toBe(380n);
  });

  it('handles only increasing entries', () => {
    const arks = [makeArk({ id: ADDR_A, assets: 120n, initialAssets: 100n })];
    const buffer = makeBuffer({ assets: 420n, initialAssets: 400n });

    const result = _buildFinalAllocations(arks, buffer);

    // Both increasing, last one gets maxUint256
    expect(result.length).toBe(2);
    expect(result[0]!.assets).toBe(120n);
    expect(result[1]!.assets).toBe(maxUint256);
  });

  it('buffer can be the last increasing entry and receive maxUint256', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 80n, initialAssets: 100n }), // decreasing
    ];
    const buffer = makeBuffer({ assets: 420n, initialAssets: 400n }); // increasing

    const result = _buildFinalAllocations(arks, buffer);

    expect(result[0]!.id).toBe(ADDR_A);
    expect(result[0]!.assets).toBe(80n);
    expect(result[1]!.id).toBe(ADDR_BUF);
    expect(result[1]!.assets).toBe(maxUint256);
  });
});
