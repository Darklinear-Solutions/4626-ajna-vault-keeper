import 'dotenv/config';
import { setUpCrashHandlers } from './utils/logger';
import { logStartupWarnings } from './utils/startupWarnings';
import { initClient } from './utils/client';
import { startScheduler } from './utils/scheduler';

setUpCrashHandlers();
logStartupWarnings();
await initClient();
startScheduler();
