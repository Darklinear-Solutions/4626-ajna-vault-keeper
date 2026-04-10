import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'node:path';
import { readFile, rm, stat } from 'node:fs/promises';
import {
  encryptKeystore,
  decryptKeystore,
  writeKeystoreFile,
  readKeystoreFile,
} from '../../src/utils/keystore';

// Anvil's default private key (deterministic and safe for tests)
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDRESS = 'f39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const TEST_PASSWORD = 'test-password-123';

const TMP_DIR = join(import.meta.dirname, '..', '..', '.test-keystore-tmp');

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

describe('encryptKeystore', () => {
  it('produces a valid V3 keystore structure', () => {
    const ks = encryptKeystore(TEST_KEY, TEST_PASSWORD);

    expect(ks.version).toBe(3);
    expect(ks.address).toBe(TEST_ADDRESS);
    expect(ks.crypto.cipher).toBe('aes-128-ctr');
    expect(ks.crypto.kdf).toBe('scrypt');
    expect(ks.crypto.kdfparams.dklen).toBe(32);
    expect(ks.crypto.kdfparams.n).toBe(262144);
    expect(ks.crypto.kdfparams.r).toBe(8);
    expect(ks.crypto.kdfparams.p).toBe(1);
    expect(ks.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('accepts keys with or without 0x prefix', () => {
    const withPrefix = encryptKeystore(TEST_KEY, TEST_PASSWORD);
    const withoutPrefix = encryptKeystore(TEST_KEY.slice(2), TEST_PASSWORD);

    expect(withPrefix.address).toBe(TEST_ADDRESS);
    expect(withoutPrefix.address).toBe(TEST_ADDRESS);
  });

  it('produces unique ciphertext and salt on each call', () => {
    const ks1 = encryptKeystore(TEST_KEY, TEST_PASSWORD);
    const ks2 = encryptKeystore(TEST_KEY, TEST_PASSWORD);

    expect(ks1.crypto.ciphertext).not.toBe(ks2.crypto.ciphertext);
    expect(ks1.crypto.kdfparams.salt).not.toBe(ks2.crypto.kdfparams.salt);
    expect(ks1.crypto.cipherparams.iv).not.toBe(ks2.crypto.cipherparams.iv);
  });
});

describe('decryptKeystore', () => {
  it('round-trips: encrypt then decrypt returns the original key', () => {
    const ks = encryptKeystore(TEST_KEY, TEST_PASSWORD);
    const decrypted = decryptKeystore(ks, TEST_PASSWORD);

    expect(decrypted).toBe(TEST_KEY);
  });

  it('throws on wrong password', () => {
    const ks = encryptKeystore(TEST_KEY, TEST_PASSWORD);

    expect(() => decryptKeystore(ks, 'wrong-password')).toThrow('Incorrect password: MAC mismatch');
  });

  it('throws on unsupported KDF', () => {
    const ks = encryptKeystore(TEST_KEY, TEST_PASSWORD);
    ks.crypto.kdf = 'pbkdf2';

    expect(() => decryptKeystore(ks, TEST_PASSWORD)).toThrow('Unsupported KDF: pbkdf2');
  });

  it('round-trips correctly with multiple different keys', () => {
    const keys = [
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
    ];

    for (const key of keys) {
      const ks = encryptKeystore(key, 'different-password');
      const decrypted = decryptKeystore(ks, 'different-password');
      expect(decrypted).toBe(key);
    }
  });
});

describe('file I/O', () => {
  it('writes and reads a keystore file', async () => {
    const ks = encryptKeystore(TEST_KEY, TEST_PASSWORD);
    const filePath = join(TMP_DIR, 'test-keystore.json');

    await writeKeystoreFile(filePath, ks);

    // Verify file exists and has restrictive permissions
    const stats = await stat(filePath);
    expect(stats.mode & 0o777).toBe(0o600);

    // Verify content round-trips through JSON
    const loaded = await readKeystoreFile(filePath);
    expect(loaded.version).toBe(3);
    expect(loaded.address).toBe(TEST_ADDRESS);

    const decrypted = decryptKeystore(loaded, TEST_PASSWORD);
    expect(decrypted).toBe(TEST_KEY);
  });

  it('creates parent directories as needed', async () => {
    const ks = encryptKeystore(TEST_KEY, TEST_PASSWORD);
    const filePath = join(TMP_DIR, 'nested', 'deep', 'keystore.json');

    await writeKeystoreFile(filePath, ks);

    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.version).toBe(3);
  });
});
