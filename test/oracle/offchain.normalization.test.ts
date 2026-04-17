import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock('../../src/utils/config.ts');
  vi.doUnmock('../../src/utils/env.ts');
});

describe('offchain oracle exact parsing', () => {
  it('preserves the exact CoinGecko numeric literal when parsing price', async () => {
    vi.doMock('../../src/utils/config.ts', () => ({
      config: {
        quoteTokenAddress: '0xabc',
        oracle: {
          apiUrl: 'https://example.test',
        },
      },
    }));
    vi.doMock('../../src/utils/env.ts', () => ({ env: {} }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '{"0xabc":{"usd":0.999870478245824934}}',
      }),
    );

    const { getOffchainPrice } = await import('../../src/oracle/offchain.ts');

    await expect(getOffchainPrice()).resolves.toBe('0.999870478245824934');
  });

  it('fails closed when exact literal extraction is not possible', async () => {
    vi.doMock('../../src/utils/config.ts', () => ({
      config: {
        quoteTokenAddress: '0xabc',
        oracle: {
          apiUrl: 'https://example.test',
        },
      },
    }));
    vi.doMock('../../src/utils/env.ts', () => ({ env: {} }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '{"0xabc":{"meta":{"source":"cg"},"usd":0.999870478245824934}}',
      }),
    );

    const { getOffchainPrice } = await import('../../src/oracle/offchain.ts');

    await expect(getOffchainPrice()).rejects.toThrow(
      'price is undefined or could not be parsed exactly',
    );
  });
});
