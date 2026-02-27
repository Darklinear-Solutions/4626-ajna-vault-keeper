import { describe, it, expect } from 'vitest';
import { createVault } from '../../src/ark/vault';
import type { Address } from 'viem';

const vault = createVault(
  process.env.VAULT_ADDRESS as Address,
  process.env.VAULT_AUTH_ADDRESS as Address,
);

describe('buffer interface', () => {
  it('can query buffer total', async () => {
    const total = await vault.getBufferTotal();
    expect(total).not.toBe(0n);
  });
});
