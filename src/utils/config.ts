import { readFileSync } from 'fs';
import { join } from 'path';
import type { Address } from 'viem';

type ArkConfig = {
  address: Address;
  allocation: {
    min: number;
    max: number;
  };
};

type Config = {
  arks: ArkConfig[];
  buffer: {
    address: Address;
    allocation: number;
  };
  minRateDiff: number;
};

const raw: Config = JSON.parse(readFileSync(join(process.cwd(), 'config.json'), 'utf-8'));

if (raw.arks.length === 0) {
  throw new Error('config.json: arks must not be empty');
}

for (const [i, ark] of raw.arks.entries()) {
  if (!ark.address) throw new Error(`config.json: arks[${i}] missing address`);
  if (ark.allocation.max === 0)
    throw new Error(`config.json: arks[${i}].allocation.max must not be 0`);
  if (ark.allocation.min > ark.allocation.max)
    throw new Error(
      `config.json: arks[${i}].allocation.min (${ark.allocation.min}) must not exceed max (${ark.allocation.max})`,
    );
}

if (!raw.buffer.address) throw new Error('config.json: buffer missing address');
if (raw.buffer.allocation === 0) throw new Error('config.json: buffer.allocation must not be 0');

const maxSum = raw.arks.reduce((sum, ark) => sum + ark.allocation.max, 0);
if (maxSum + raw.buffer.allocation !== 100) {
  throw new Error(
    `config.json: sum of ark max allocations (${maxSum}) + buffer allocation (${raw.buffer.allocation}) must equal 100`,
  );
}

if (!raw.minRateDiff) raw.minRateDiff = 10;

export const config = raw;
