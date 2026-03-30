import { setUpCrashHandlers } from './utils/logger';
import { startScheduler } from './utils/scheduler';

setUpCrashHandlers();
startScheduler();
