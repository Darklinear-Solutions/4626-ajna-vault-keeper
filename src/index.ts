import { setUpCrashHandlers } from './utils/logger';
import { startScheduler } from './utils/scheduler';
import { run } from './keepers/arkKeeper';

setUpCrashHandlers();
startScheduler(run);
