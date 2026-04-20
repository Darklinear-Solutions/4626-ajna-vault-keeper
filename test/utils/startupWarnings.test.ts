import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../src/utils/config.ts');
  vi.doUnmock('../../src/utils/env.ts');
  vi.doUnmock('../../src/utils/logger.ts');
});

function mockEnv(overrides: { credentialMode?: string; env?: Record<string, unknown> } = {}): void {
  vi.doMock('../../src/utils/env.ts', () => ({
    credentialMode: overrides.credentialMode ?? 'privateKey',
    env: {
      RPC_URL: 'https://rpc.example',
      PRIVATE_KEY: '0xabc123',
      KEYSTORE_PATH: undefined,
      REMOTE_SIGNER_URL: undefined,
      REMOTE_SIGNER_ADDRESS: undefined,
      REMOTE_SIGNER_ALLOW_INSECURE: false,
      REMOTE_SIGNER_AUTH_TOKEN: undefined,
      SUBGRAPH_URL: 'https://subgraph.example',
      ORACLE_API_KEY: undefined,
      ORACLE_API_TIER: undefined,
      ...overrides.env,
    },
  }));
}

describe('logStartupWarnings', () => {
  it('emits warnings for explicit fail-open, stale-check disabling, and fixed-price mode', async () => {
    const warn = vi.fn();

    vi.doMock('../../src/utils/config.ts', () => ({
      config: {
        keeper: {
          exitOnSubgraphFailure: false,
        },
        oracle: {
          onchainAddress: '0x0000000000000000000000000000000000000002',
          onchainPrimary: true,
          onchainMaxStaleness: null,
          fixedPrice: '1.00',
        },
      },
    }));
    mockEnv();
    vi.doMock('../../src/utils/logger.ts', () => ({
      startupNoticeLog: { warn },
    }));

    const { logStartupWarnings } = await import('../../src/utils/startupWarnings.ts');

    logStartupWarnings();

    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ event: 'subgraph_fail_open_enabled' }),
      expect.stringContaining('fail-open'),
    );
    expect(warn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ event: 'oracle_staleness_check_disabled' }),
      expect.stringContaining('staleness checking is disabled'),
    );
    expect(warn).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ event: 'oracle_fixed_price_enabled', rawPrice: '1.00' }),
      expect.stringContaining('fixed-price mode is enabled'),
    );
  });

  it('does not emit startup warnings for the safe live-oracle path', async () => {
    const warn = vi.fn();

    vi.doMock('../../src/utils/config.ts', () => ({
      config: {
        keeper: {
          exitOnSubgraphFailure: true,
        },
        oracle: {
          onchainPrimary: true,
          onchainMaxStaleness: 86400,
          fixedPrice: null,
        },
      },
    }));
    mockEnv();
    vi.doMock('../../src/utils/logger.ts', () => ({
      startupNoticeLog: { warn },
    }));

    const { logStartupWarnings } = await import('../../src/utils/startupWarnings.ts');

    logStartupWarnings();

    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when an offchain-primary setup disables staleness checks on its onchain fallback', async () => {
    const warn = vi.fn();

    vi.doMock('../../src/utils/config.ts', () => ({
      config: {
        keeper: {
          exitOnSubgraphFailure: true,
        },
        oracle: {
          onchainAddress: '0x0000000000000000000000000000000000000002',
          onchainPrimary: false,
          onchainMaxStaleness: null,
          fixedPrice: null,
        },
      },
    }));
    mockEnv();
    vi.doMock('../../src/utils/logger.ts', () => ({
      startupNoticeLog: { warn },
    }));

    const { logStartupWarnings } = await import('../../src/utils/startupWarnings.ts');

    logStartupWarnings();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'oracle_staleness_check_disabled',
        onchainAddress: '0x0000000000000000000000000000000000000002',
        onchainPrimary: false,
      }),
      expect.stringContaining('staleness checking is disabled'),
    );
  });

  it('still emits startup notices when the main logger is configured at error level', async () => {
    const warn = vi.fn();

    vi.doMock('../../src/utils/config.ts', () => ({
      config: {
        keeper: {
          exitOnSubgraphFailure: false,
          logLevel: 'error',
        },
        oracle: {
          onchainPrimary: true,
          onchainMaxStaleness: 86400,
          fixedPrice: null,
        },
      },
    }));
    mockEnv();
    vi.doMock('../../src/utils/logger.ts', () => ({
      startupNoticeLog: { warn },
      log: { error: vi.fn(), warn: vi.fn() },
    }));

    const { logStartupWarnings } = await import('../../src/utils/startupWarnings.ts');

    logStartupWarnings();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'subgraph_fail_open_enabled' }),
      expect.stringContaining('fail-open'),
    );
  });

  it('warns when the remote signer URL is http and REMOTE_SIGNER_ALLOW_INSECURE is set', async () => {
    const warn = vi.fn();

    vi.doMock('../../src/utils/config.ts', () => ({
      config: {
        keeper: {
          exitOnSubgraphFailure: true,
        },
        oracle: {
          onchainPrimary: true,
          onchainMaxStaleness: 86400,
          fixedPrice: null,
        },
      },
    }));
    mockEnv({
      credentialMode: 'remoteSigner',
      env: {
        REMOTE_SIGNER_URL: 'http://signer.example',
        REMOTE_SIGNER_ADDRESS: '0x00000000000000000000000000000000000000A1',
        REMOTE_SIGNER_ALLOW_INSECURE: true,
      },
    });
    vi.doMock('../../src/utils/logger.ts', () => ({
      startupNoticeLog: { warn },
    }));

    const { logStartupWarnings } = await import('../../src/utils/startupWarnings.ts');

    logStartupWarnings();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'remote_signer_insecure_transport', tokenExposed: false }),
      expect.stringContaining('plaintext http'),
    );
  });

  it('warns that the bearer token is exposed when REMOTE_SIGNER_AUTH_TOKEN is set with http', async () => {
    const warn = vi.fn();

    vi.doMock('../../src/utils/config.ts', () => ({
      config: {
        keeper: {
          exitOnSubgraphFailure: true,
        },
        oracle: {
          onchainPrimary: true,
          onchainMaxStaleness: 86400,
          fixedPrice: null,
        },
      },
    }));
    mockEnv({
      credentialMode: 'remoteSigner',
      env: {
        REMOTE_SIGNER_URL: 'http://signer.example',
        REMOTE_SIGNER_ADDRESS: '0x00000000000000000000000000000000000000A1',
        REMOTE_SIGNER_ALLOW_INSECURE: true,
        REMOTE_SIGNER_AUTH_TOKEN: 'tok',
      },
    });
    vi.doMock('../../src/utils/logger.ts', () => ({
      startupNoticeLog: { warn },
    }));

    const { logStartupWarnings } = await import('../../src/utils/startupWarnings.ts');

    logStartupWarnings();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'remote_signer_insecure_transport', tokenExposed: true }),
      expect.stringContaining('bearer token'),
    );
  });
});
