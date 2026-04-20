import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { keccak256 as viemKeccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const KEYSTORE_VERSION = 3;
const CIPHER = 'aes-128-ctr';
const KDF = 'scrypt';
const SCRYPT_N = 262144;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const DKLEN = 32;

interface KeystoreV3 {
  version: 3;
  id: string;
  address: string;
  crypto: {
    cipher: string;
    ciphertext: string;
    cipherparams: { iv: string };
    kdf: string;
    kdfparams: {
      dklen: number;
      salt: string;
      n: number;
      r: number;
      p: number;
    };
    mac: string;
  };
}

function mac(derivedKey: Buffer, ciphertext: Buffer): string {
  const macBody = Buffer.concat([derivedKey.subarray(16, 32), ciphertext]);
  const hex = viemKeccak256(macBody) as string;
  return hex.slice(2);
}

function uuidv4(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export function encryptKeystore(privateKey: string, password: string): KeystoreV3 {
  const key = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
  const keyBuf = Buffer.from(key, 'hex');

  const address = privateKeyToAccount(`0x${key}` as `0x${string}`)
    .address.toLowerCase()
    .slice(2);

  const salt = randomBytes(32);
  const iv = randomBytes(16);

  const derivedKey = scryptSync(Buffer.from(password, 'utf-8'), salt, DKLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 256 * SCRYPT_N * SCRYPT_R,
  });

  const cipher = createCipheriv(CIPHER, derivedKey.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(keyBuf), cipher.final()]);

  return {
    version: KEYSTORE_VERSION,
    id: uuidv4(),
    address,
    crypto: {
      cipher: CIPHER,
      ciphertext: ciphertext.toString('hex'),
      cipherparams: { iv: iv.toString('hex') },
      kdf: KDF,
      kdfparams: {
        dklen: DKLEN,
        salt: salt.toString('hex'),
        n: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
      },
      mac: mac(derivedKey as Buffer, ciphertext),
    },
  };
}

export function decryptKeystore(keystore: KeystoreV3, password: string): `0x${string}` {
  const { crypto: c } = keystore;

  if (c.kdf !== KDF) {
    throw new Error(`Unsupported KDF: ${c.kdf}`);
  }

  const salt = Buffer.from(c.kdfparams.salt, 'hex');
  const iv = Buffer.from(c.cipherparams.iv, 'hex');
  const ciphertext = Buffer.from(c.ciphertext, 'hex');

  const derivedKey = scryptSync(Buffer.from(password, 'utf-8'), salt, c.kdfparams.dklen, {
    N: c.kdfparams.n,
    r: c.kdfparams.r,
    p: c.kdfparams.p,
    maxmem: 256 * c.kdfparams.n * c.kdfparams.r,
  });

  const computedMac = mac(derivedKey as Buffer, ciphertext);
  if (computedMac !== c.mac) {
    throw new Error('Incorrect password: MAC mismatch');
  }

  const decipher = createDecipheriv(c.cipher, derivedKey.subarray(0, 16), iv);
  const privateKey = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return `0x${privateKey.toString('hex')}`;
}

export async function readKeystoreFile(path: string): Promise<KeystoreV3> {
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content) as KeystoreV3;
}

export async function writeKeystoreFile(path: string, keystore: KeystoreV3): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(keystore, null, 2) + '\n', { mode: 0o600 });
}

export async function promptPassword(message: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });

  try {
    process.stderr.write(message);

    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((_chunk: string | Uint8Array) => true) as typeof process.stderr.write;

    const password = await rl.question('');

    process.stderr.write = originalWrite;
    process.stderr.write('\n');

    return password;
  } finally {
    rl.close();
  }
}

export async function loadPrivateKeyFromKeystore(keystorePath: string): Promise<`0x${string}`> {
  const keystore = await readKeystoreFile(keystorePath);
  const password = await promptPassword('Enter keystore password: ');
  return decryptKeystore(keystore, password);
}
