import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPrice } from '../../src/oracle/price.ts';
import { env } from '../../src/utils/env.ts';

describe('getPrice', () => {
  beforeAll(() => {
    env.FIXED_PRICE = 0;
  });

  it('returns price from either feed', async () => {
    const currentPrice = await getPrice();
    expect(currentPrice).toBe(999870478245824934n);
  });
});

describe('get fixed price', () => {
  beforeAll(() => {
    env.FIXED_PRICE = 1;
  });

  afterAll(() => {
    env.FIXED_PRICE = 0;
  });

  it('returns properly converted fixed price', async () => {
    const currentPrice = await getPrice();
    expect(currentPrice).toBe(1000000000000000000n);
  });
});
