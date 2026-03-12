import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/utils/config', () => ({
  config: { minRateDiff: 10 },
}));

import {
  _rebalanceBuffer,
  _reallocateForRates,
  _buildFinalAllocations,
  _validateAllocations,
  type ArkAllocation,
  type BufferAllocation,
} from '../../src/keepers/metavaultKeeper';
import { type ArkEvaluation } from '../../src/metavault/utils/evaluateRates';
import { type createVault } from '../../src/ark/vault';
import { type Address, maxUint256 } from 'viem';

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

describe('buffer rebalance followed by rate reallocation', () => {
  it('fills buffer then reallocates between arks', () => {
    // totalAssets = 1000, buffer target = 400 (40%)
    // Initial: buffer=350, A=250(rate=100), B=200(rate=300), C=200(rate=200)
    const arks = [
      makeArk({ id: ADDR_A, assets: 250n, min: 5, max: 40, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 200n, min: 5, max: 40, rate: 300n }),
      makeArk({ id: ADDR_C, assets: 200n, min: 5, max: 40, rate: 200n }),
    ];
    const buffer = makeBuffer({ assets: 350n });
    const totalAssets = 1000n;

    // Step 1: fill buffer (deficit = 50)
    _rebalanceBuffer(arks, buffer, totalAssets);

    // Lowest rate = A(100): 250 - 50 (min) = 200 available. Deduct 50
    expect(arks[0]!.assets).toBe(200n);
    expect(buffer.assets).toBe(400n);

    // Step 2: rate reallocation — A should move to B (highest rate)
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B, ADDR_C] },
      { address: ADDR_B, targets: [] },
      { address: ADDR_C, targets: [ADDR_B] },
    ];

    _reallocateForRates(arks, evaluations, totalAssets);

    // A (rate 100, processed first): available = 200 - 50 = 150
    // B: max = 400, capacity = 400 - 200 = 200. Move 150 to B. A=50, B=350
    // C (rate 200, processed second): available = 200 - 50 = 150
    // B: capacity = 400 - 350 = 50. Move 50 to B. C=150, B=400
    expect(arks[0]!.assets).toBe(50n); // A drained to min
    expect(arks[1]!.assets).toBe(400n); // B received from both A and C
    expect(arks[2]!.assets).toBe(150n); // C gave 50 to B
  });

  it('drains buffer excess then reallocates for rates', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 100n, min: 5, max: 30, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 100n, min: 5, max: 30, rate: 300n }),
      makeArk({ id: ADDR_C, assets: 100n, min: 5, max: 30, rate: 200n }),
    ];
    const buffer = makeBuffer({ assets: 700n });
    const totalAssets = 1000n;

    // Step 1: drain buffer (excess = 300)
    _rebalanceBuffer(arks, buffer, totalAssets);

    // Rate order (desc): B(300), C(200), A(100)
    // B: max=300, capacity=200, add 200. C: max=300, capacity=200, add 100 (remaining)
    expect(arks[1]!.assets).toBe(300n);
    expect(arks[2]!.assets).toBe(200n);
    expect(arks[0]!.assets).toBe(100n);
    expect(buffer.assets).toBe(400n);

    // Step 2: rate reallocation
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B] },
      { address: ADDR_B, targets: [] },
      { address: ADDR_C, targets: [ADDR_B] },
    ];

    _reallocateForRates(arks, evaluations, totalAssets);

    // A: available = 100-50 = 50. B at max (300), no capacity. No move.
    // C: available = 200-50 = 150. B at max (300), no capacity. No move.
    expect(arks[0]!.assets).toBe(100n);
    expect(arks[1]!.assets).toBe(300n);
    expect(arks[2]!.assets).toBe(200n);
  });

  it('full pipeline: rebalance, reallocate, validate, build final allocations', () => {
    const arks = [
      makeArk({ id: ADDR_A, assets: 200n, initialAssets: 200n, min: 5, max: 30, rate: 100n }),
      makeArk({ id: ADDR_B, assets: 150n, initialAssets: 150n, min: 5, max: 30, rate: 300n }),
      makeArk({ id: ADDR_C, assets: 150n, initialAssets: 150n, min: 5, max: 30, rate: 200n }),
    ];
    const buffer = makeBuffer({ assets: 350n, initialAssets: 350n });
    const totalAssets = 1000n;

    // Step 1: buffer rebalance (deficit = 50)
    _rebalanceBuffer(arks, buffer, totalAssets);
    expect(buffer.assets).toBe(400n);

    // Step 2: rate reallocation
    const evaluations: ArkEvaluation[] = [
      { address: ADDR_A, targets: [ADDR_B, ADDR_C] },
      { address: ADDR_B, targets: [] },
      { address: ADDR_C, targets: [ADDR_B] },
    ];
    _reallocateForRates(arks, evaluations, totalAssets);

    // Step 3: validation should pass
    expect(() => _validateAllocations(arks, buffer, totalAssets)).not.toThrow();

    // Step 4: build final allocations
    const allocations = _buildFinalAllocations(arks, buffer);

    // Should have changes since buffer and arks moved
    expect(allocations.length).toBeGreaterThan(0);

    // Decreasing entries should come before increasing entries
    const decreasingIds = allocations
      .filter((a) => a.assets !== maxUint256)
      .filter((a) => {
        const all = [...arks, buffer];
        const original = all.find((o) => o.id === a.id);
        return original && a.assets < original.initialAssets;
      })
      .map((a) => a.id);

    const firstIncreasingIdx = allocations.findIndex((a) => {
      const all = [...arks, buffer];
      const original = all.find((o) => o.id === a.id);
      return original && (a.assets > original.initialAssets || a.assets === maxUint256);
    });

    let lastDecreasingIdx = -1;
    for (let i = allocations.length - 1; i >= 0; i--) {
      const a = allocations[i]!;
      const all = [...arks, buffer];
      const original = all.find((o) => o.id === a.id);
      if (original && a.assets < original.initialAssets) {
        lastDecreasingIdx = i;
        break;
      }
    }

    if (decreasingIds.length > 0 && firstIncreasingIdx >= 0) {
      expect(lastDecreasingIdx).toBeLessThan(firstIncreasingIdx);
    }

    // Last entry should be maxUint256
    const lastAllocation = allocations[allocations.length - 1]!;
    expect(lastAllocation.assets).toBe(maxUint256);
  });
});
