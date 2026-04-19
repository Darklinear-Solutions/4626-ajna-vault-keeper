import 'dotenv/config';

const REQUIRED = ['RPC_URL', 'SUBGRAPH_URL'] as const;

function readOptionalEnv(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

export type CredentialMode = 'privateKey' | 'keystore' | 'remoteSigner';

for (const key of REQUIRED) {
  if (!process.env[key]) {
    throw new Error(`${key} must be specified`);
  }
}

const PRIVATE_KEY = readOptionalEnv('PRIVATE_KEY');
const KEYSTORE_PATH = readOptionalEnv('KEYSTORE_PATH');
const REMOTE_SIGNER_URL = readOptionalEnv('REMOTE_SIGNER_URL');
const REMOTE_SIGNER_ADDRESS = readOptionalEnv('REMOTE_SIGNER_ADDRESS');

if (Boolean(REMOTE_SIGNER_URL) !== Boolean(REMOTE_SIGNER_ADDRESS)) {
  throw new Error('REMOTE_SIGNER_URL and REMOTE_SIGNER_ADDRESS must both be specified together');
}

const credentialModes = [
  PRIVATE_KEY ? 'privateKey' : null,
  KEYSTORE_PATH ? 'keystore' : null,
  REMOTE_SIGNER_URL ? 'remoteSigner' : null,
].filter((mode): mode is CredentialMode => mode !== null);

if (credentialModes.length !== 1) {
  throw new Error(
    'Configure exactly one credential mode: PRIVATE_KEY, KEYSTORE_PATH, or REMOTE_SIGNER_URL with REMOTE_SIGNER_ADDRESS',
  );
}

if (process.env.ORACLE_API_KEY && !process.env.ORACLE_API_TIER) {
  throw new Error('API key tier must be specified');
}

export const credentialMode = credentialModes[0]!;

export const env = {
  RPC_URL: process.env.RPC_URL!,
  PRIVATE_KEY,
  KEYSTORE_PATH,
  REMOTE_SIGNER_URL,
  REMOTE_SIGNER_ADDRESS,
  SUBGRAPH_URL: process.env.SUBGRAPH_URL!,
  ORACLE_API_KEY: process.env.ORACLE_API_KEY,
  ORACLE_API_TIER: process.env.ORACLE_API_TIER,
};
