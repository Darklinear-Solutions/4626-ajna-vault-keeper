import {
  bytesToHex,
  getTransactionType,
  isAddressEqual,
  parseSignature,
  recoverMessageAddress,
  recoverTransactionAddress,
  serializeTransaction,
  stringToHex,
  toHex,
  type Address,
  type Hex,
  type SignableMessage,
  type TransactionSerializable,
  type TypedData,
  type TypedDataDefinition,
} from 'viem';
import { toAccount } from 'viem/accounts';

type RemoteSignerConfig = {
  address: Address;
  url: string;
};

type JsonRpcSuccess<T> = {
  id: number;
  jsonrpc: '2.0';
  result: T;
};

type JsonRpcFailure = {
  error: {
    code: number;
    data?: unknown;
    message: string;
  };
  id: number;
  jsonrpc: '2.0';
};

type JsonRpcResponse<T> = JsonRpcFailure | JsonRpcSuccess<T>;

let requestId = 0;
const REMOTE_SIGNER_IDENTITY_MESSAGE = '4626-ajna-vault-keeper remote signer identity check';

function toSignableHex(message: SignableMessage): Hex {
  if (typeof message === 'string') return stringToHex(message);
  if (typeof message.raw === 'string') return message.raw;
  return bytesToHex(message.raw);
}

function getRemoteSignerTransactionType(transaction: TransactionSerializable) {
  const type = getTransactionType(transaction);

  if (type === 'legacy' || type === 'eip1559' || type === 'eip2930') {
    return type;
  }

  throw new Error(`Remote signer does not support ${type} transactions in this keeper`);
}

function toRemoteSignerType(type: 'legacy' | 'eip1559' | 'eip2930'): Hex | undefined {
  if (type === 'eip1559') return '0x2';
  if (type === 'eip2930') return '0x1';
  return undefined;
}

function toRemoteSignerTransaction(address: Address, transaction: TransactionSerializable) {
  const type = getRemoteSignerTransactionType(transaction);

  return {
    accessList: transaction.accessList,
    chainId: transaction.chainId != null ? toHex(transaction.chainId) : undefined,
    data: transaction.data,
    from: address,
    gas: transaction.gas != null ? toHex(transaction.gas) : undefined,
    gasPrice: transaction.gasPrice != null ? toHex(transaction.gasPrice) : undefined,
    maxFeePerGas: transaction.maxFeePerGas != null ? toHex(transaction.maxFeePerGas) : undefined,
    maxPriorityFeePerGas:
      transaction.maxPriorityFeePerGas != null
        ? toHex(transaction.maxPriorityFeePerGas)
        : undefined,
    nonce: transaction.nonce != null ? toHex(transaction.nonce) : undefined,
    to: transaction.to ?? null,
    type: toRemoteSignerType(type),
    value: transaction.value != null ? toHex(transaction.value) : undefined,
  };
}

async function requestRemoteSigner<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    body: JSON.stringify({
      id: ++requestId,
      jsonrpc: '2.0',
      method,
      params,
    }),
    headers: {
      'content-type': 'application/json',
    },
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error(
      `Remote signer request failed (${method}): HTTP ${response.status} ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as JsonRpcResponse<T>;

  if ('error' in payload) {
    throw new Error(`Remote signer request failed (${method}): ${payload.error.message}`);
  }

  return payload.result;
}

function assertRecoveredAddressMatchesExpected(
  expectedAddress: Address,
  recoveredAddress: Address,
  scope: 'message' | 'transaction',
) {
  if (!isAddressEqual(recoveredAddress, expectedAddress)) {
    throw new Error(
      `Remote signer ${scope} signature recovered ${recoveredAddress}, expected ${expectedAddress}`,
    );
  }
}

async function requestVerifiedMessageSignature(
  { address, url }: RemoteSignerConfig,
  message: SignableMessage,
): Promise<Hex> {
  const signature = await requestRemoteSigner<Hex>(url, 'eth_sign', [
    address,
    toSignableHex(message),
  ]);
  const recoveredAddress = await recoverMessageAddress({ message, signature });

  assertRecoveredAddressMatchesExpected(address, recoveredAddress, 'message');
  return signature;
}

export async function verifyRemoteSignerIdentity(config: RemoteSignerConfig): Promise<void> {
  await requestVerifiedMessageSignature(config, REMOTE_SIGNER_IDENTITY_MESSAGE);
}

export function createRemoteSignerAccount({ address, url }: RemoteSignerConfig) {
  return toAccount({
    address,
    async signMessage({ message }) {
      return requestVerifiedMessageSignature({ address, url }, message);
    },
    async signTransaction(transaction, { serializer } = {}) {
      const signatureHex = await requestRemoteSigner<Hex>(url, 'eth_signTransaction', [
        toRemoteSignerTransaction(address, transaction),
      ]);
      const signature = parseSignature(signatureHex);
      const signedTransaction = serializeTransaction(transaction, signature) as Parameters<
        typeof recoverTransactionAddress
      >[0]['serializedTransaction'];
      const recoveredAddress = await recoverTransactionAddress({
        serializedTransaction: signedTransaction,
      });

      assertRecoveredAddressMatchesExpected(address, recoveredAddress, 'transaction');
      return (serializer ?? serializeTransaction)(transaction, signature);
    },
    async signTypedData<
      const typedData extends TypedData | Record<string, unknown>,
      primaryType extends keyof typedData | 'EIP712Domain' = keyof typedData,
    >(_typedData: TypedDataDefinition<typedData, primaryType>) {
      throw new Error('Remote signer typed-data signing is not supported by this keeper');
    },
  });
}
