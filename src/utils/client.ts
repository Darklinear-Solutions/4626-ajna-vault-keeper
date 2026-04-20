import {
  createWalletClient,
  createPublicClient,
  http,
  publicActions,
  type Account,
  type Chain,
} from 'viem';
import * as allChains from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { credentialMode, env } from './env.ts';
import { config } from './config.ts';
import { log } from './logger.ts';
import { loadPrivateKeyFromKeystore } from './keystore.ts';
import { createRemoteSignerAccount } from './remoteSigner.ts';

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

function buildClients(account: Account) {
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

function setClients(account: Account): void {
  const built = buildClients(account);
  client = built.walletClient;
  readOnlyClient = built.publicClient;
}

function createImmediateAccount(): Account | null {
  if (credentialMode === 'privateKey') {
    return privateKeyToAccount(env.PRIVATE_KEY as `0x${string}`);
  }

  if (credentialMode === 'remoteSigner') {
    return createRemoteSignerAccount({
      address: env.REMOTE_SIGNER_ADDRESS as `0x${string}`,
      url: env.REMOTE_SIGNER_URL!,
    });
  }

  return null;
}

async function loadAccount(): Promise<Account> {
  const immediateAccount = createImmediateAccount();
  if (immediateAccount) return immediateAccount;

  if (credentialMode === 'keystore') {
    log.info(
      { event: 'keystore_load', path: env.KEYSTORE_PATH },
      'Loading private key from keystore',
    );
    const privateKey = await loadPrivateKeyFromKeystore(env.KEYSTORE_PATH!);
    const account = privateKeyToAccount(privateKey);
    log.info(
      { event: 'keystore_decrypted', address: account.address },
      'Keystore decrypted successfully',
    );
    return account;
  }

  throw new Error(`Unsupported credential mode: ${credentialMode}`);
}

const immediateAccount = createImmediateAccount();

if (immediateAccount) {
  setClients(immediateAccount);
}

export async function initClient(): Promise<void> {
  if (client) return;

  setClients(await loadAccount());
}
