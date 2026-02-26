import { describe, it, expect } from 'vitest';
import { getBufferTotal } from '../../src/ark/buffer';

describe('buffer interface', () => {
  it('can query buffer total', async () => {
    const total = await getBufferTotal();
    expect(total).not.toBe(0n);
  });
});
