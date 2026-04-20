import { config } from './config.ts';
import { log } from './logger.ts';

export function logStartupWarnings(): void {
  if (!config.keeper.exitOnSubgraphFailure) {
    log.warn(
      {
        event: 'subgraph_fail_open_enabled',
      },
      'subgraph failure handling is fail-open: query failures will be treated as no auctions',
    );
  }

  if (config.oracle.onchainPrimary && config.oracle.onchainMaxStaleness == null) {
    log.warn(
      {
        event: 'oracle_staleness_check_disabled',
        onchainPrimary: config.oracle.onchainPrimary,
      },
      'onchain oracle staleness checking is disabled via explicit config override',
    );
  }

  if (config.oracle.fixedPrice != null) {
    log.warn(
      {
        event: 'oracle_fixed_price_enabled',
        rawPrice: config.oracle.fixedPrice,
      },
      'fixed-price mode is enabled: live oracle queries and validation are bypassed',
    );
  }
}
