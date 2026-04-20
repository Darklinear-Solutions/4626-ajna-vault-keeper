import 'dotenv/config';
import { setUpCrashHandlers } from './utils/logger.ts';
import { logStartupWarnings } from './utils/startupWarnings.ts';
import { initClient } from './utils/client.ts';
import { startScheduler } from './utils/scheduler.ts';

setUpCrashHandlers();
logStartupWarnings();
await initClient();
startScheduler();
