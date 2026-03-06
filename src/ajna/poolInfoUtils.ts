import type { Address } from 'viem';
import { contract } from '../utils/contract';

export function createPoolInfoUtils(address: Address, poolAddress: Address) {
  const poolInfoUtils = contract('poolInfoUtils', address);

  return {
    getPriceToIndex: (price: bigint) => poolInfoUtils().read.priceToIndex([price]),
    getIndexToPrice: (index: bigint) => poolInfoUtils().read.indexToPrice([index]),
    getHtp: () => poolInfoUtils().read.htp([poolAddress]),
    getLup: () => poolInfoUtils().read.lup([poolAddress]),
    getAuctionStatus: (borrower: Address) =>
      poolInfoUtils().read.auctionStatus(poolAddress, borrower),
    getBorrowFeeRate: (poolAddress: Address) => poolInfoUtils().read.borrowFeeRate(poolAddress),
  };
}
