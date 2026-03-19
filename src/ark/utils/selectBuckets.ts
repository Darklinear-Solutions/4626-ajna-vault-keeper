import { type createVault } from '../vault';

export type BucketMove = {
  bucket: bigint;
  amount: bigint;
};

export async function selectBuckets(
  vault: ReturnType<typeof createVault>,
  amount: bigint,
): Promise<BucketMove[]> {
  const buckets = await vault.getBuckets();
  const dustThreshold = await vault.getDustThreshold();

  const bucketData = await Promise.all(
    (buckets as bigint[]).map(async (bucket: bigint) => ({
      bucket,
      value: await vault.lpToValue(bucket),
      lps: await vault.getBucketLps(bucket),
      price: await vault.getIndexToPrice(bucket),
    })),
  );

  const nonEmpty = bucketData.filter((b) => b.value > 0n);
  const sufficient = nonEmpty.filter((b) => b.value >= amount);

  if (sufficient.length === 1) {
    const b = sufficient[0]!;
    const moveAmount = _wouldLeaveDust(amount, b.value, b.lps, dustThreshold) ? b.value : amount;
    return [{ bucket: b.bucket, amount: moveAmount }];
  }

  if (sufficient.length > 1) {
    sufficient.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
    const b = sufficient[0]!;
    const moveAmount = _wouldLeaveDust(amount, b.value, b.lps, dustThreshold) ? b.value : amount;
    return [{ bucket: b.bucket, amount: moveAmount }];
  }

  nonEmpty.sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0));

  const moves: BucketMove[] = [];
  let remaining = amount;

  for (const b of nonEmpty) {
    if (remaining <= 0n) break;

    if (b.value >= remaining) {
      const moveAmount = _wouldLeaveDust(remaining, b.value, b.lps, dustThreshold)
        ? b.value
        : remaining;
      moves.push({ bucket: b.bucket, amount: moveAmount });
      remaining -= moveAmount;
    } else {
      moves.push({ bucket: b.bucket, amount: b.value });
      remaining -= b.value;
    }
  }

  return moves;
}

function _wouldLeaveDust(
  amount: bigint,
  bucketValue: bigint,
  bucketLps: bigint,
  dustThreshold: bigint,
): boolean {
  if (amount >= bucketValue) return false;
  const lpsRemoved = (bucketLps * amount) / bucketValue;
  const remainingLps = bucketLps - lpsRemoved;
  return remainingLps > 0n && remainingLps < dustThreshold;
}
