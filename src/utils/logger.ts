import pino from 'pino';
import { config } from './config.ts';

const redact = [
  'env.PRIVATE_KEY',
  'env.ORACLE_API_KEY',
  'env.REMOTE_SIGNER_URL',
  'env.REMOTE_SIGNER_AUTH_TOKEN',
  'env.REMOTE_SIGNER_TLS_CLIENT_KEY_PASSWORD',
  'env.RPC_URL',
];
const destination = pino.destination({ sync: true });

export const log = pino(
  {
    level: config.keeper.logLevel ?? 'info',
    redact,
  },
  destination,
);

// Startup safety notices should remain visible even when the main logger is configured more strictly.
export const startupNoticeLog = pino(
  {
    level: 'warn',
    redact,
  },
  destination,
);

export function setUpCrashHandlers() {
  process.on('uncaughtException', (err) => {
    log.fatal({ event: 'uncaught_exception', err }, 'uncaughtException, process exiting');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    log.fatal(
      {
        event: 'unhandled_rejection',
        err: reason instanceof Error ? reason : new Error(String(reason)),
      },
      'unhandledRejection, process exiting',
    );
    process.exit(1);
  });
}
