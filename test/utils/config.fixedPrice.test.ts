import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('fs');
});

describe('config fixedPrice validation', () => {
  it('rejects numeric fixedPrice values to avoid precision loss', async () => {
    vi.doMock('fs', () => ({
      readFileSync: () => `{
        "chainId": 1,
        "quoteTokenAddress": "0x1",
        "keeper": {
          "intervalMs": 1,
          "haltIfLupBelowHtp": true
        },
        "oracle": {
          "onchainPrimary": true,
          "onchainAddress": "0x2",
          "onchainMaxStaleness": null,
          "fixedPrice": 0.999870478245824934
        },
        "arkGlobal": {},
        "transaction": {
          "confirmations": 1
        },
        "arks": [],
        "buffer": {
          "address": "0x3",
          "allocation": 0
        },
        "minRateDiff": 10
      }`,
    }));

    await expect(import('../../src/utils/config.ts')).rejects.toThrow(
      'config.json: oracle.fixedPrice must be a string decimal to avoid precision loss',
    );
  });
});
