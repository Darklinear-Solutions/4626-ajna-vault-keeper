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

// Oracle prices are always compared against WAD-scaled Ajna bucket prices,
// so we always scale to 18 decimals regardless of the quote token's decimals.
export function toAsset(rawValue: number): bigint {
  return BigInt(Math.round(rawValue * 1e18));
}
