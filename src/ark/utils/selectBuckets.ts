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

  const bucketData = await Promise.all(
    (buckets as bigint[]).map(async (bucket: bigint) => ({
      bucket,
      value: await vault.lpToValue(bucket),
      price: await vault.getIndexToPrice(bucket),
    })),
  );

  const nonEmpty = bucketData.filter((b) => b.value > 0n);
  const sufficient = nonEmpty.filter((b) => b.value >= amount);

  if (sufficient.length === 1) {
    return [{ bucket: sufficient[0]!.bucket, amount }];
  }

  if (sufficient.length > 1) {
    sufficient.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
    return [{ bucket: sufficient[0]!.bucket, amount }];
  }

  nonEmpty.sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0));

  const moves: BucketMove[] = [];
  let remaining = amount;

  for (const b of nonEmpty) {
    if (remaining <= 0n) break;
    const moveAmount = b.value >= remaining ? remaining : b.value;
    moves.push({ bucket: b.bucket, amount: moveAmount });
    remaining -= moveAmount;
  }

  return moves;
}
