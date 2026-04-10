import { createWalletClient, createPublicClient, http, publicActions, type Chain } from 'viem';
import * as allChains from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { env } from './env';
import { config } from './config';
import { log } from './logger';
import { loadPrivateKeyFromKeystore } from './keystore';

const transport = process.env.TEST_ENV === 'true' ? 'http://127.0.0.1:8545' : env.RPC_URL;

function getChain(chainId: number): Chain {
  for (const chain of Object.values(allChains)) {
    if ('id' in chain && chain.id === chainId) {
      return chain as Chain;
    }
  }

  log.warn(
    { event: 'unknown_chain_id', chainId: chainId },
    `Unknown Chain ID ${chainId}, using custom configuration.`,
  );

  return {
    id: chainId,
    name: 'Custom Chain',
    nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
    rpcUrls: {
      default: { http: [env.RPC_URL as string] },
      public: { http: [env.RPC_URL as string] },
    },
  } as Chain;
}

const targetChain = getChain(config.chainId);

function buildClients(privateKey: `0x${string}`) {
  const account = privateKeyToAccount(privateKey);

  const walletClient = createWalletClient({
    account,
    chain: targetChain,
    transport: http(transport),
  }).extend(publicActions);

  const publicClient = createPublicClient({
    chain: targetChain,
    transport: http(transport),
  });

  return { walletClient, publicClient } as const;
}

type Clients = ReturnType<typeof buildClients>;

export let client: Clients['walletClient'];
export let readOnlyClient: Clients['publicClient'];

if (env.PRIVATE_KEY) {
  const built = buildClients(env.PRIVATE_KEY as `0x${string}`);
  client = built.walletClient;
  readOnlyClient = built.publicClient;
}

export async function initClient(): Promise<void> {
  if (client) return;

  if (env.KEYSTORE_PATH) {
    const privateKey = await loadPrivateKeyFromKeystore(env.KEYSTORE_PATH);
    const built = buildClients(privateKey);
    client = built.walletClient;
    readOnlyClient = built.publicClient;
  } else {
    throw new Error('Either PRIVATE_KEY or KEYSTORE_PATH must be specified');
  }
}
