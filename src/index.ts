import { setUpCrashHandlers } from './utils/logger';
import { initClient } from './utils/client';
import { startScheduler } from './utils/scheduler';

setUpCrashHandlers();
await initClient();
startScheduler();
