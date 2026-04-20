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

  if (config.oracle.onchainAddress && config.oracle.onchainMaxStaleness == null) {
    startupNoticeLog.warn(
      {
        event: 'oracle_staleness_check_disabled',
        onchainAddress: config.oracle.onchainAddress,
        onchainPrimary: config.oracle.onchainPrimary,
      },
      'onchain oracle staleness checking is disabled via explicit config override',
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
