import { config, resolveArkSettings } from './config';
import { log } from './logger';
import { setTimeout as sleep } from 'node:timers/promises';
import { metavaultRun } from '../keepers/metavaultKeeper';
import { arkRun } from '../keepers/arkKeeper';

/* eslint-disable @typescript-eslint/no-explicit-any */

async function run() {
  if (config.metavaultAddress) {
    await metavaultRun();
  }

  for (const ark of config.arks) {
    const settings = resolveArkSettings(ark);
    await arkRun(ark.vaultAddress, ark.vaultAuthAddress, settings);
  }
}

export function startScheduler() {
  const interval = config.keeper.intervalMs;

  const ac = new AbortController();
  const { signal } = ac;

  const stop = () => {
    log.info({ event: 'keeper_stopping' }, 'keeper stopping');
    ac.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  (async () => {
    while (!signal.aborted) {
      try {
        await run();
      } catch (e) {
        log.error(
          { event: 'keeper_run_failed', err: e },
          `keeper run failed, attempting again in ${interval} ms`,
        );
      }

      try {
        await sleep(interval, undefined, { signal });
      } catch (err: any) {
        if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') break;
        throw err;
      }
    }
  })();
}
