import { poolErrors } from '../../abi/PoolErrors';
import { decodeErrorResult, type Address } from 'viem';

export const decodeAjnaError = (errorCode: string) => {
  return decodeErrorResult({
    abi: poolErrors,
    data: errorCode as Address,
  });
};
