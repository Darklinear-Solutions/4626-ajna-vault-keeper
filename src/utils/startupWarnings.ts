import { config } from './config';
import { log } from './logger';

export function logStartupWarnings(): void {
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
