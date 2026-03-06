import { config } from '../utils/config';
import { createVault } from '../ark/vault';

export async function run() {
  await _getKeeperData();
}

async function _getKeeperData() {
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

  return {
    arks,
    buffer,
    minRateDiff: config?.minRateDiff,
  };
}
