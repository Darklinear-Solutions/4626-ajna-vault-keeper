import { log } from './logger';
import { client } from './client';
import { env } from './env';
import { getAddress } from './address';
import { getAbi } from './abi';
import { parseEventLogs, decodeErrorResult, type TransactionReceipt } from 'viem';

/* eslint-disable @typescript-eslint/no-explicit-any */

type Hash = `0x${string}`;
export type TransactionData = {
  status: boolean;
  assets: bigint;
};

const confirmations = Number(env.CONFIRMATIONS ?? 1);

export async function wait(txHash: Hash): Promise<TransactionReceipt> {
  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    confirmations: confirmations,
  });

  if (receipt.status !== 'success') {
    const tx = await client.getTransaction({ hash: txHash });

    try {
      await client.call({
        to: tx.to!,
        account: tx.from,
        data: tx.input,
        blockNumber: receipt.blockNumber,
      });
    } catch (err: any) {
      const data = err.data;
      if (data) {
        let decoded;
        try {
          decoded = decodeErrorResult({ abi: getAbi('vault'), data });
        } catch {
          decoded = { errorName: 'UnknownRevert', sig: data.slice(0, 10), data };
        }
        throw Object.assign(new Error(String(decoded.errorName)), { receipt, decoded, cause: err });
      }
    }

    throw Object.assign(new Error(`Transaction ${txHash} reverted`), { receipt });
  }

  return receipt;
}

export async function handleTransaction(
  tx: Promise<Hash>,
  context?: Record<string, unknown>,
): Promise<TransactionData> {
  let hash: Hash | undefined;
  let assets = 0n;
  let status = false;

  try {
    hash = await tx;
    const receipt = await wait(hash);
    status = true;

    if (context) {
      const action = context.action as string;
      const amount = getAmountMoved(receipt, action);
      assets = amount ?? (context.amount as bigint);
    }

    log.info(
      { event: 'tx_success', hash, block: receipt.blockNumber, assetsMoved: assets, ...context },
      `move confirmed`,
    );
  } catch (err) {
    const receipt = (err as any)?.receipt as TransactionReceipt | undefined;
    const phase = receipt ? 'revert' : hash ? 'fail' : 'send';

    log.error(
      {
        event: 'tx_failed',
        phase,
        hash,
        block: receipt?.blockNumber,
        receipt,
        err: abridgedViemError(err),
        ...context,
      },
      `move failed`,
    );
  }

  return {
    status,
    assets,
  };
}

function getAmountMoved(receipt: any, action: string) {
  const vaultAbi = getAbi('vault');
  let amount;

  if (action === 'Move' || action === 'MoveToBuffer') {
    const logs = parseEventLogs({
      abi: vaultAbi,
      eventName: action,
      logs: receipt.logs,
    }) as unknown as Array<{ args: { amount: bigint } }>;
    amount = logs[0]?.args.amount as bigint;
  } else {
    amount = null;
  }

  return amount;
}

function abridgedViemError(err: unknown) {
  const e = err as any;

  return {
    shortMessage: e?.shortMessage,
    errorName: e?.decoded?.errorName ?? e?.cause?.errorName ?? e?.errorName,
    decoded: e?.decoded,
    contractAddress: e?.contractAddress,
    functionName: e?.functionName,
    args: e?.args,
    sender: e?.sender,
    data: e?.data ?? e?.decoded?.data,
    stack: e?.stack,
  };
}

export async function getGasWithBuffer(
  functionName: string,
  args: readonly unknown[],
): Promise<bigint> {
  const defaultGas = 1500000n;
  const address = await getAddress('vault');
  const abi = getAbi('vault');

  try {
    const estimated = await client.estimateContractGas({
      address,
      abi,
      functionName,
      args,
    });
    return estimated + (estimated * env.GAS_BUFFER) / 100n;
  } catch (err) {
    log.warn(
      {
        event: 'gas_estimation_failed',
        error: abridgedViemError(err),
        defaultGas,
      },
      `gas estimation failed, falling back to default value: ${defaultGas}`,
    );

    return defaultGas;
  }
}
