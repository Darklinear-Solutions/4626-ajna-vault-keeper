import { readFileSync } from 'fs';
import { join } from 'path';
import type { Address } from 'viem';

// TODO: vaultAddress and vaultAuthAddress need to be scoped to ark objects in arks array
// TODO: optimalBucketDiff needs to be scoped to ark objects but also remain globally; scoped values, if they exist, take precedence for given ark

// ============= Raw JSON Types =============

type ArkConfig = {
  address: Address;
  allocation: {
    min: number;
    max: number;
  };
  optimalBucketDiff?: number;
};

type RawConfig = {
  chainId: number;
  quoteTokenAddress: string;
  vaultAddress?: string;
  vaultAuthAddress?: string;
  metavaultAddress?: string;

  keeper: {
    intervalMs: number;
    logLevel?: string;
    exitOnSubgraphFailure?: boolean;
    haltIfLupBelowHtp: boolean;
  };

  oracle: {
    apiUrl?: string;
    onchainPrimary: boolean;
    onchainAddress?: string;
    onchainMaxStaleness: number | null;
    fixedPrice: number | null;
    futureSkewTolerance?: number;
  };

  pool: {
    optimalBucketDiff: number;
    bufferPadding?: string;
    minMoveAmount?: string;
    minTimeSinceBankruptcy?: number;
    maxAuctionAge?: number;
  };

  transaction: {
    gasBuffer?: number;
    defaultGas?: number;
    confirmations: number;
  };

  arks: ArkConfig[];
  buffer: {
    address: Address;
    allocation: number;
  };
  minRateDiff: number;
};

// ============= Parse & Validate =============

const raw: RawConfig = JSON.parse(readFileSync(join(process.cwd(), 'config.json'), 'utf-8'));

for (const [i, ark] of raw.arks.entries()) {
  if (ark.allocation.max === 0)
    throw new Error(`config.json: arks[${i}].allocation.max must not be 0`);
  if (ark.allocation.min > ark.allocation.max)
    throw new Error(
      `config.json: arks[${i}].allocation.min (${ark.allocation.min}) must not exceed max (${ark.allocation.max})`,
    );
}

if (raw.arks.length > 0 && raw.buffer.allocation > 0) {
  const maxSum = raw.arks.reduce((sum, ark) => sum + ark.allocation.max, 0);
  if (maxSum + raw.buffer.allocation !== 100) {
    throw new Error(
      `config.json: sum of ark max allocations (${maxSum}) + buffer allocation (${raw.buffer.allocation}) must equal 100`,
    );
  }
}

if (!raw.oracle.onchainPrimary && !raw.oracle.fixedPrice) {
  if (!raw.oracle.apiUrl) throw new Error('config.json: oracle.apiUrl is required when onchainPrimary is false and fixedPrice is not set');
}

if (raw.oracle.onchainPrimary && !raw.oracle.onchainAddress) {
  throw new Error('config.json: oracle.onchainAddress is required when onchainPrimary is true');
}

// Apply defaults for optional fields
raw.keeper.exitOnSubgraphFailure ??= false;
raw.oracle.futureSkewTolerance ??= 120;
raw.pool.bufferPadding ??= '100000000000000';
raw.pool.minMoveAmount ??= '1000001';
raw.pool.minTimeSinceBankruptcy ??= 259200;
raw.pool.maxAuctionAge ??= 259200;
raw.transaction.gasBuffer = !raw.transaction.gasBuffer || BigInt(raw.transaction.gasBuffer) === 0n
  ? 50
  : raw.transaction.gasBuffer;
raw.transaction.defaultGas ??= 3000000;

if (!raw.minRateDiff) raw.minRateDiff = 10;
if (!raw.quoteTokenAddress) throw new Error('config.json: quoteTokenAddress is required');

// ============= Export =============

export const config = {
  ...raw,
  keeper: raw.keeper as Required<RawConfig['keeper']>,
  oracle: raw.oracle as Required<RawConfig['oracle']>,
  pool: raw.pool as Required<RawConfig['pool']>,
  transaction: raw.transaction as Required<RawConfig['transaction']>,
  quoteTokenAddress: raw.quoteTokenAddress.toLowerCase() as Address,
  vaultAddress: (raw.vaultAddress || undefined) as Address | undefined,
  vaultAuthAddress: (raw.vaultAuthAddress || undefined) as Address | undefined,
  metavaultAddress: (raw.metavaultAddress || undefined) as Address | undefined,
  bufferPadding: BigInt(raw.pool.bufferPadding!),
  minMoveAmount: BigInt(raw.pool.minMoveAmount!),
  optimalBucketDiff: BigInt(raw.pool.optimalBucketDiff),
  minTimeSinceBankruptcy: BigInt(raw.pool.minTimeSinceBankruptcy!),
  defaultGas: BigInt(raw.transaction.defaultGas!),
  gasBuffer: BigInt(raw.transaction.gasBuffer!),
};
