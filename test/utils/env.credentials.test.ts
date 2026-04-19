import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

function restoreEnv(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function setCredentialTestEnv(overrides: Record<string, string | undefined>): void {
  restoreEnv(ORIGINAL_ENV);
  process.env.RPC_URL = 'https://rpc.example';
  process.env.SUBGRAPH_URL = 'https://subgraph.example';

  delete process.env.PRIVATE_KEY;
  delete process.env.KEYSTORE_PATH;
  delete process.env.REMOTE_SIGNER_URL;
  delete process.env.REMOTE_SIGNER_ADDRESS;

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  restoreEnv(ORIGINAL_ENV);
  vi.resetModules();
  vi.doUnmock('dotenv/config');
});

describe('credential mode validation', () => {
  it('rejects ambiguous credential configuration', async () => {
    vi.doMock('dotenv/config', () => ({}));
    setCredentialTestEnv({
      KEYSTORE_PATH: './keystore/keeper-key.json',
      PRIVATE_KEY: '0xabc123',
    });

    await expect(import('../../src/utils/env.ts')).rejects.toThrow(
      'Configure exactly one credential mode',
    );
  });

  it('rejects partial remote signer configuration', async () => {
    vi.doMock('dotenv/config', () => ({}));
    setCredentialTestEnv({
      REMOTE_SIGNER_URL: 'https://signer.example',
    });

    await expect(import('../../src/utils/env.ts')).rejects.toThrow(
      'REMOTE_SIGNER_URL and REMOTE_SIGNER_ADDRESS must both be specified together',
    );
  });

  it('accepts the remote signer credential mode', async () => {
    vi.doMock('dotenv/config', () => ({}));
    setCredentialTestEnv({
      REMOTE_SIGNER_ADDRESS: '0x00000000000000000000000000000000000000A1',
      REMOTE_SIGNER_URL: 'https://signer.example',
    });

    const { credentialMode, env } = await import('../../src/utils/env.ts');

    expect(credentialMode).toBe('remoteSigner');
    expect(env.PRIVATE_KEY).toBeUndefined();
    expect(env.KEYSTORE_PATH).toBeUndefined();
    expect(env.REMOTE_SIGNER_URL).toBe('https://signer.example');
    expect(env.REMOTE_SIGNER_ADDRESS).toBe('0x00000000000000000000000000000000000000A1');
  });
});
