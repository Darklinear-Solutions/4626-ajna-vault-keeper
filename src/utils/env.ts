import 'dotenv/config';

const REQUIRED = ['RPC_URL', 'SUBGRAPH_URL'] as const;

for (const key of REQUIRED) {
  if (!process.env[key]) {
    throw new Error(`${key} must be specified`);
  }
}

if (!process.env.PRIVATE_KEY && !process.env.KEYSTORE_PATH) {
  throw new Error('Either PRIVATE_KEY or KEYSTORE_PATH must be specified');
}

if (process.env.ORACLE_API_KEY && !process.env.ORACLE_API_TIER) {
  throw new Error('API key tier must be specified');
}

export const env = {
  RPC_URL: process.env.RPC_URL!,
  PRIVATE_KEY: process.env.PRIVATE_KEY,
  KEYSTORE_PATH: process.env.KEYSTORE_PATH,
  SUBGRAPH_URL: process.env.SUBGRAPH_URL!,
  ORACLE_API_KEY: process.env.ORACLE_API_KEY,
  ORACLE_API_TIER: process.env.ORACLE_API_TIER,
};
