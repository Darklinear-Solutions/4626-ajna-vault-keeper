import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../src/utils/config.ts');
  vi.doUnmock('../../src/utils/logger.ts');
});

describe('logStartupWarnings', () => {
  it('emits warnings for explicit stale-check disabling and fixed-price mode', async () => {
    const warn = vi.fn();

    vi.doMock('../../src/utils/config.ts', () => ({
      config: {
        oracle: {
          onchainPrimary: true,
          onchainMaxStaleness: null,
          fixedPrice: '1.00',
        },
      },
    }));
    vi.doMock('../../src/utils/logger.ts', () => ({
      log: { warn },
    }));

    const { logStartupWarnings } = await import('../../src/utils/startupWarnings.ts');

    logStartupWarnings();

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ event: 'oracle_staleness_check_disabled' }),
      expect.stringContaining('staleness checking is disabled'),
    );
    expect(warn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ event: 'oracle_fixed_price_enabled', rawPrice: '1.00' }),
      expect.stringContaining('fixed-price mode is enabled'),
    );
  });

  it('does not emit startup warnings for the safe live-oracle path', async () => {
    const warn = vi.fn();

    vi.doMock('../../src/utils/config.ts', () => ({
      config: {
        oracle: {
          onchainPrimary: true,
          onchainMaxStaleness: 86400,
          fixedPrice: null,
        },
      },
    }));
    vi.doMock('../../src/utils/logger.ts', () => ({
      log: { warn },
    }));

    const { logStartupWarnings } = await import('../../src/utils/startupWarnings.ts');

    logStartupWarnings();

    expect(warn).not.toHaveBeenCalled();
  });
});
