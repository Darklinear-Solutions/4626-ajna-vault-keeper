export function toWad(rawValue: bigint, assetDecimals: number): bigint {
  const decimals = BigInt(assetDecimals);

  if (decimals === 18n) {
    return rawValue;
  } else if (decimals < 18n) {
    return rawValue * 10n ** (18n - decimals);
  } else {
    return rawValue / 10n ** (decimals - 18n);
  }
}

export function toAsset(rawValue: number, assetDecimals: number): bigint {
  return BigInt(rawValue * 10 ** assetDecimals);
}
