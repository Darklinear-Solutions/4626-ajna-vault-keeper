import { config } from '../utils/config';
import { createVault } from '../ark/vault';
import { evaluateRates, type ArkEvaluation } from '../metavault/utils/evaluateRates';

export type Ark = {
  vault: ReturnType<typeof createVault>;
  min: number | undefined;
  max: number | undefined;
  rate: bigint;
};

type Buffer = {
  address: string;
  allocation: number;
};

export type KeeperRunData = {
  arks: Ark[];
  buffer: Buffer;
  minRateDiff: number;
  arkRateEvaluations: ArkEvaluation[];
};

export async function run() {
  const data = await _getKeeperData();
  _isRateReallocationRequired(data.arkRateEvaluations);
}

export function _isRateReallocationRequired(evaluations: ArkEvaluation[]): boolean {
  return evaluations.some((e) => e.targets.length > 0);
}

async function _getKeeperData(): Promise<KeeperRunData> {
  let arks = [];
  for (let i = 0; i < config.arks.length; i++) {
    const vault = createVault(config?.arks[i]?.address);
    arks[i] = {
      vault,
      min: config?.arks[i]?.allocation?.min,
      max: config?.arks[i]?.allocation?.min,
      rate: await vault.getBorrowFeeRate(),
    };
  }

  const buffer = {
    address: config?.buffer?.address,
    allocation: config?.buffer?.allocation,
  };

  const arkRateEvaluations = evaluateRates(arks);

  return {
    arks,
    buffer,
    minRateDiff: config?.minRateDiff,
    arkRateEvaluations,
  };
}
