import { describe, it, expect } from 'vitest';
import { createVault } from '../../src/ark/vault';
import { config } from '../../src/utils/config';
import type { Address } from 'viem';

const vault = createVault(config.vaultAddress as Address, config.vaultAuthAddress as Address);

describe('buffer interface', () => {
  it('can query buffer total', async () => {
    const total = await vault.getBufferTotal();
    expect(total).not.toBe(0n);
  });
});
