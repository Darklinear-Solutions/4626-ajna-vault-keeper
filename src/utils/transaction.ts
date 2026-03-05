import { log } from './logger';
import { client } from './client';
import { env } from './env';
import { getAddress, type contracts } from './address';
import { getAbi, type ContractAbiKey } from './abi';
import { haltKeeper } from '../keepers/arkKeeper';
import { parseEventLogs, decodeErrorResult, type TransactionReceipt, type Address } from 'viem';

/* eslint-disable @typescript-eslint/no-explicit-any */

type Hash = `0x${string}`;
export type TransactionData = {
  status: boolean;
  assets: bigint;
};
type ContractKey = keyof typeof contracts;

const confirmations = Number(env.CONFIRMATIONS ?? 1);

export async function wait(txHash: Hash): Promise<TransactionReceipt> {
  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    confirmations,
  });

  if (receipt.status !== 'success') {
    const tx = await client.getTransaction({ hash: txHash });

    try {
      await client.call({
        to: tx.to!,
        account: tx.from,
        data: tx.input,
      });
    } catch (err: any) {
      const data = err?.cause?.cause?.data ?? err?.cause?.data ?? err?.data;

      if (isLupBelowHtp(err)) {
        if (env.HALT_KEEPER_IF_LUP_BELOW_HTP) haltKeeper();
        throw Object.assign(
          new Error(
            'LUPBelowHTP. Vault funds have been lent out by the pool and cannot be moved. Consider running the AJNA Keeper to check for necessary liquidations.',
          ),
        );
      } else if (data) {
        let decoded;
        try {
          decoded = decodeErrorResult({ abi: getAbi('metavault'), data });
        } catch {
          try {
            decoded = decodeErrorResult({ abi: getAbi('vault'), data });
          } catch {
            decoded = { errorName: 'UnknownRevert', sig: data.slice(0, 10), data };
          }
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

    if (context && context?.action !== 'reallocate') {
      const action = context.action as string;
      const amount = getAmountMoved(receipt, action);
      assets = amount ?? (context.amount as bigint);
    }

    if (assets === 0n) {
      log.info(
        {
          event: 'tx_success',
          hash,
          block: receipt.blockNumber,
          ...context,
        },
        `transaction confirmed`,
      );
    } else {
      log.info(
        {
          event: 'tx_success',
          hash,
          block: receipt.blockNumber,
          assetsMoved: assets,
          ...context,
        },
        `transaction confirmed`,
      );
    }
  } catch (err) {
    const receipt = (err as any)?.receipt as TransactionReceipt | undefined;
    const phase = receipt ? 'revert' : hash ? 'fail' : 'send';

    if (phase === 'fail' && hash) {
      const isInsufficientFunds = await _checkInsufficientFunds(hash);
      if (isInsufficientFunds) {
        log.error(
          {
            event: 'tx_failed',
            phase: 'insufficient_funds',
            hash,
            reason: 'Account does not have enough ETH to cover gas costs',
            ...context,
          },
          'transaction failed: insufficient funds',
        );
        return { status, assets };
      }
    }

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
      `transaction failed`,
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

  if (action === 'move' || action === 'moveToBuffer') {
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
    data: e?.cause?.cause?.data ?? e?.cause?.data ?? e?.data ?? e?.decoded?.data,
    stack: e?.stack,
  };
}

export async function getGasWithBuffer(
  contract: ContractKey | ContractAbiKey,
  functionName: string,
  args: readonly unknown[],
  address?: Address,
): Promise<bigint> {
  const defaultGas = env.DEFAULT_GAS;
  const resolvedAddress = address ?? (await getAddress(contract as ContractKey));
  const abi = getAbi(contract as ContractAbiKey);

  try {
    const fees = await client.estimateFeesPerGas();
    const estimated = await client.estimateContractGas({
      address: resolvedAddress,
      abi,
      functionName,
      args,
      ...fees,
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

async function _checkInsufficientFunds(hash: Hash): Promise<boolean> {
  try {
    const tx = await client.getTransaction({ hash }).catch(() => null);

    if (!tx) return true;

    const balance = await client.getBalance({ address: tx.from });
    const maxGasCost = tx.gas * (tx.maxFeePerGas || tx.gasPrice || 0n);

    if (balance < maxGasCost) return true;

    return false;
  } catch {
    return false;
  }
}

function isLupBelowHtp(err: any) {
  const data = err?.cause?.cause?.data;
  return data === '0x444507e1';
}
