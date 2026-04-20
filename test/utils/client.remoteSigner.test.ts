import { afterEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  parseTransaction,
  signatureToHex,
  type Signature,
  type TransactionSerializable,
} from 'viem';

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

function setClientTestEnv(overrides: Record<string, string | undefined>): void {
  restoreEnv(ORIGINAL_ENV);

  process.env.RPC_URL = 'https://rpc.example';
  process.env.SUBGRAPH_URL = 'https://subgraph.example';
  process.env.TEST_ENV = 'false';

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
  vi.unstubAllGlobals();
  vi.doUnmock('dotenv/config');
  vi.doUnmock('../../src/utils/config.ts');
  vi.doUnmock('../../src/utils/logger.ts');
});

describe('client credential selection', () => {
  it('uses the raw private key account when PRIVATE_KEY is configured', async () => {
    vi.doMock('dotenv/config', () => ({}));
    vi.doMock('../../src/utils/config.ts', () => ({ config: { chainId: 1 } }));
    vi.doMock('../../src/utils/logger.ts', () => ({ log: { warn: vi.fn() } }));

    const privateKey =
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
    setClientTestEnv({ PRIVATE_KEY: privateKey });

    const { client } = await import('../../src/utils/client.ts');

    expect(client.account.address).toBe(privateKeyToAccount(privateKey).address);
  });

  it('uses the configured remote signer account when remote signer mode is configured', async () => {
    vi.doMock('dotenv/config', () => ({}));
    vi.doMock('../../src/utils/config.ts', () => ({ config: { chainId: 1 } }));
    vi.doMock('../../src/utils/logger.ts', () => ({ log: { warn: vi.fn() } }));

    setClientTestEnv({
      REMOTE_SIGNER_ADDRESS: '0x00000000000000000000000000000000000000A1',
      REMOTE_SIGNER_URL: 'https://signer.example',
    });

    const { client } = await import('../../src/utils/client.ts');

    expect(client.account.address).toBe('0x00000000000000000000000000000000000000A1');
  });
});

describe('remote signer account', () => {
  it('signs keeper transactions through eth_signTransaction and serializes them locally', async () => {
    const signer = privateKeyToAccount(
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    );
    const transaction = {
      chainId: 1,
      data: '0x1234',
      gas: 21000n,
      maxFeePerGas: 20n,
      maxPriorityFeePerGas: 2n,
      nonce: 7,
      to: '0x00000000000000000000000000000000000000b2',
      type: 'eip1559',
      value: 0n,
    } satisfies TransactionSerializable;
    const signedTransaction = await signer.signTransaction(transaction);
    const parsedTransaction = parseTransaction(signedTransaction);
    const signatureHex = signatureToHex({
      r: parsedTransaction.r!,
      s: parsedTransaction.s!,
      yParity: parsedTransaction.yParity!,
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 1,
        jsonrpc: '2.0',
        result: signatureHex,
      }),
      status: 200,
      statusText: 'OK',
    });

    vi.stubGlobal('fetch', fetchMock);

    const { createRemoteSignerAccount } = await import('../../src/utils/remoteSigner.ts');

    const account = createRemoteSignerAccount({
      address: signer.address,
      url: 'https://signer.example',
    });
    const serializer = vi.fn((request: TransactionSerializable, signature?: Signature) => {
      expect(request).toMatchObject(transaction);
      expect(signature).toEqual(
        expect.objectContaining({
          r: expect.stringMatching(/^0x[0-9a-f]+$/),
          s: expect.stringMatching(/^0x[0-9a-f]+$/),
        }),
      );

      return '0xserialized';
    });

    const serialized = await account.signTransaction(transaction, {
      serializer: serializer as typeof import('viem').serializeTransaction,
    });
    const request = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);

    expect(serialized).toBe('0xserialized');
    expect(request).toEqual({
      id: 1,
      jsonrpc: '2.0',
      method: 'eth_signTransaction',
      params: [
        {
          chainId: '0x1',
          data: '0x1234',
          from: signer.address,
          gas: '0x5208',
          maxFeePerGas: '0x14',
          maxPriorityFeePerGas: '0x2',
          nonce: '0x7',
          to: '0x00000000000000000000000000000000000000b2',
          type: '0x2',
          value: '0x0',
        },
      ],
    });
  });

  it('rejects transaction signatures that recover to a different address', async () => {
    const configuredAddress = '0x00000000000000000000000000000000000000A1' as const;
    const wrongSigner = privateKeyToAccount(
      '0x59c6995e998f97a5a0044966f094538c5f6d2e7d31be9c4754b150f8f7f7b1d8',
    );
    const transaction = {
      chainId: 1,
      data: '0x1234',
      gas: 21000n,
      maxFeePerGas: 20n,
      maxPriorityFeePerGas: 2n,
      nonce: 7,
      to: '0x00000000000000000000000000000000000000b2',
      type: 'eip1559',
      value: 0n,
    } satisfies TransactionSerializable;
    const signedTransaction = await wrongSigner.signTransaction(transaction);
    const parsedTransaction = parseTransaction(signedTransaction);
    const signatureHex = signatureToHex({
      r: parsedTransaction.r!,
      s: parsedTransaction.s!,
      yParity: parsedTransaction.yParity!,
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 1,
        jsonrpc: '2.0',
        result: signatureHex,
      }),
      status: 200,
      statusText: 'OK',
    });

    vi.stubGlobal('fetch', fetchMock);

    const { createRemoteSignerAccount } = await import('../../src/utils/remoteSigner.ts');

    const account = createRemoteSignerAccount({
      address: configuredAddress,
      url: 'https://signer.example',
    });

    await expect(account.signTransaction(transaction)).rejects.toThrow(
      `Remote signer transaction signature recovered ${wrongSigner.address}, expected ${configuredAddress}`,
    );
  });
});

describe('remote signer startup verification', () => {
  it('fails initClient when the remote signer message signature does not match the configured address', async () => {
    vi.doMock('dotenv/config', () => ({}));
    vi.doMock('../../src/utils/config.ts', () => ({ config: { chainId: 1 } }));
    vi.doMock('../../src/utils/logger.ts', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

    setClientTestEnv({
      REMOTE_SIGNER_ADDRESS: '0x00000000000000000000000000000000000000A1',
      REMOTE_SIGNER_URL: 'https://signer.example',
    });

    const wrongSigner = privateKeyToAccount(
      '0x59c6995e998f97a5a0044966f094538c5f6d2e7d31be9c4754b150f8f7f7b1d8',
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 1,
        jsonrpc: '2.0',
        result: await wrongSigner.signMessage({
          message: '4626-ajna-vault-keeper remote signer identity check',
        }),
      }),
      status: 200,
      statusText: 'OK',
    });

    vi.stubGlobal('fetch', fetchMock);

    const { initClient } = await import('../../src/utils/client.ts');

    await expect(initClient()).rejects.toThrow(
      `Remote signer message signature recovered ${wrongSigner.address}, expected 0x00000000000000000000000000000000000000A1`,
    );
  });
});
