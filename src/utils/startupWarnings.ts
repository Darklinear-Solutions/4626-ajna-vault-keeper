import { config } from './config.ts';
import { credentialMode, env } from './env.ts';
import { startupNoticeLog } from './logger.ts';

export function logStartupWarnings(): void {
  if (!config.keeper.exitOnSubgraphFailure) {
    startupNoticeLog.warn(
      {
        event: 'subgraph_fail_open_enabled',
      },
      'subgraph failure handling is fail-open: query failures will be treated as no auctions',
    );
  }

  if (
    config.oracle.onchainCollateralAddress &&
    config.oracle.onchainQuoteAddress &&
    config.oracle.onchainMaxStaleness == null
  ) {
    startupNoticeLog.warn(
      {
        event: 'oracle_staleness_check_disabled',
        onchainCollateralAddress: config.oracle.onchainCollateralAddress,
        onchainQuoteAddress: config.oracle.onchainQuoteAddress,
        onchainPrimary: config.oracle.onchainPrimary,
      },
      'onchain oracle staleness checking is disabled via explicit config override',
    );
  }

  const collateralToken = config.collateralTokenAddress?.toLowerCase();
  if (collateralToken && collateralToken === config.quoteTokenAddress.toLowerCase()) {
    startupNoticeLog.warn(
      { event: 'oracle_denomination_degenerate', source: 'offchain' },
      'collateralTokenAddress equals quoteTokenAddress: the offchain oracle will price every pair as a constant 1.0',
    );
  }

  const collateralFeed = config.oracle.onchainCollateralAddress?.toLowerCase();
  if (collateralFeed && collateralFeed === config.oracle.onchainQuoteAddress?.toLowerCase()) {
    startupNoticeLog.warn(
      { event: 'oracle_denomination_degenerate', source: 'onchain' },
      'oracle.onchainCollateralAddress equals oracle.onchainQuoteAddress: the onchain oracle will price every pair as a constant 1.0',
    );
  }

  if (config.oracle.fixedPrice != null) {
    startupNoticeLog.warn(
      {
        event: 'oracle_fixed_price_enabled',
        rawPrice: config.oracle.fixedPrice,
      },
      'fixed-price mode is enabled: live oracle queries and validation are bypassed',
    );
  }

  if (
    credentialMode === 'remoteSigner' &&
    env.REMOTE_SIGNER_URL != null &&
    new URL(env.REMOTE_SIGNER_URL).protocol === 'http:'
  ) {
    const tokenExposed = Boolean(env.REMOTE_SIGNER_AUTH_TOKEN);
    const message = tokenExposed
      ? 'REMOTE_SIGNER_ALLOW_INSECURE is set with REMOTE_SIGNER_AUTH_TOKEN: signer requests and the bearer token will be sent over plaintext http. Use https in production.'
      : 'REMOTE_SIGNER_ALLOW_INSECURE is set: signer requests will be sent over plaintext http. Use https in production.';
    startupNoticeLog.warn(
      {
        event: 'remote_signer_insecure_transport',
        tokenExposed,
      },
      message,
    );
  }
}
