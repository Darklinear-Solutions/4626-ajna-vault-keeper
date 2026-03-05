import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createVault } from '../../src/ark/vault';
import { handleTransaction, getGasWithBuffer } from '../../src/utils/transaction';
import { client } from '../../src/utils/client.ts';
import { setBufferRatio } from '../helpers/vaultHelpers.ts';
import type { Address } from 'viem';

/* eslint-disable @typescript-eslint/no-explicit-any */

const vault = createVault(
  process.env.VAULT_ADDRESS as Address,
  process.env.VAULT_AUTH_ADDRESS as Address,
);

describe('vault interface', () => {
  it('can query buckets', async () => {
    const buckets = await vault.getBuckets();
    expect(buckets).toSatisfy(
      (val: any) => (val.length === 1 && val[0] === 4161n) || val.length === 0,
    );
  });

  it('can query asset decimals', async () => {
    const decimals = await vault.getAssetDecimals();
    expect(decimals).toBe(18);
  });

  it('can calculate dust threshold', async () => {
    const dustThreshold = await vault.getDustThreshold();
    expect(dustThreshold).toBe(1000001n);
  });

  it('can query paused status', async () => {
    const paused = await vault.isPaused();
    expect(paused).toBe(false);
  });

  it('can query contract addresses', async () => {
    const buffer = await vault.getBufferAddress();
    const info = await vault.getPoolInfoUtilsAddress();
    const pool = await vault.getPoolAddress();

    expect(buffer).toBe('0x787B797Ed807E5882d1a7bE68C4D742289df32a5');
    expect(info).toBe('0x30c5eF2997d6a882DE52c4ec01B6D0a5e5B4fAAE');
    expect(pool).toBe('0x34bC3D3d274A355f3404c5dEe2a96335540234de');
  });

  it('can drain bucket', async () => {
    // Test that it doesn't revert
    await vault.drain(4156n);
  });
});

if (!process.env.CI) {
  describe('vault operations', () => {
    let snapshot: string;
    let htp: bigint;
    let htpIndex: bigint;
    let assets: bigint;
    let initialBufferBalance: bigint;
    let initialHtpQts: bigint;

    beforeAll(async () => {
      htp = await vault.getHtp();
      htpIndex = await vault.getPriceToIndex(htp);
      assets = BigInt(2e10);

      [initialBufferBalance, initialHtpQts] = await Promise.all([
        vault.getBufferTotal(),
        vault.lpToValue(htpIndex),
      ]);
      const gas = await getGasWithBuffer('vault', 'moveFromBuffer', [htpIndex, assets]);

      await handleTransaction(vault.moveFromBuffer(htpIndex, assets, gas), {
        action: 'moveFromBuffer',
        to: htpIndex,
        amount: assets,
      });

      snapshot = await client.request({ method: 'evm_snapshot' as any, params: [] as any });
      await setBufferRatio(0n);
    });

    beforeEach(async () => {
      await client.request({ method: 'evm_revert' as any, params: [snapshot] as any });
      snapshot = await client.request({ method: 'evm_snapshot' as any, params: [] as any });
    });

    afterAll(async () => {
      await setBufferRatio(5000n);
    });

    it('can move between buckets', async () => {
      const toIndex = htpIndex - 1n;

      const [beforeHtpQts, beforeToQts] = await Promise.all([
        vault.lpToValue(htpIndex),
        vault.lpToValue(toIndex),
      ]);

      const toAssets = 19999721737n;
      const gas = await getGasWithBuffer('vault', 'move', [htpIndex, toIndex, toAssets]);

      await handleTransaction(vault.move(htpIndex, toIndex, toAssets, gas), {
        action: 'move',
        from: htpIndex,
        to: toIndex,
        amount: toAssets,
      });

      const [afterHtpQts, afterToQts] = await Promise.all([
        vault.lpToValue(htpIndex),
        vault.lpToValue(toIndex),
      ]);

      const htpDelta = beforeHtpQts - afterHtpQts;
      const toDelta = afterToQts - beforeToQts;
      const deltaDiff = toDelta - htpDelta;

      expect(deltaDiff).toBeLessThan(2n);
      expect(toDelta).toBeGreaterThan(0n);
    });

    it('can move from bucket to buffer', async () => {
      await setBufferRatio(0n);

      const [beforeBufferBalance, beforeHtpQts] = await Promise.all([
        vault.getBufferTotal(),
        vault.lpToValue(htpIndex),
      ]);

      const toAssets = BigInt(1e10);
      const gas = await getGasWithBuffer('vault', 'moveToBuffer', [htpIndex, toAssets]);

      await handleTransaction(vault.moveToBuffer(htpIndex, toAssets, gas), {
        action: 'moveToBuffer',
        from: htpIndex,
        amount: toAssets,
      });

      const [afterBufferBalance, afterHtpQts] = await Promise.all([
        vault.getBufferTotal() as Promise<bigint>,
        vault.lpToValue(htpIndex),
      ]);

      const bufferDelta: bigint = afterBufferBalance - beforeBufferBalance;
      const htpDelta = beforeHtpQts - afterHtpQts;
      const deltaDiff = htpDelta - bufferDelta;

      expect(deltaDiff).toBeLessThan(3n);
      expect(bufferDelta).toBeGreaterThan(0n);
    });

    it('can move from buffer to bucket', async () => {
      const [afterBufferBalance, afterHtpQts] = await Promise.all([
        vault.getBufferTotal(),
        vault.lpToValue(htpIndex),
      ]);

      const htpDelta = afterHtpQts - initialHtpQts;
      const bufferDelta = initialBufferBalance - afterBufferBalance;
      const deltaDiff = bufferDelta - htpDelta;

      expect(deltaDiff).toBeLessThan(300000);
      expect(htpDelta).toBeGreaterThan(0n);
    });
  });
}
