import { describe, it, expect } from 'vitest';
import { _isRateReallocationRequired } from '../../src/keepers/metavaultKeeper';
import { type ArkEvaluation } from '../../src/metavault/utils/evaluateRates';
import { type Address } from 'viem';

const ADDR_A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as Address;
const ADDR_B = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as Address;

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
