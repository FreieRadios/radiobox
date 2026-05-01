import 'dotenv/config';
import process from 'node:process';
import { Autopilot } from './classes/autopilot';

const autopilot = new Autopilot();

// Only auto-run when this file is executed directly (e.g. `node dist/autopilot`).
// During Jest test runs the module is imported, in which case we skip the
// bootstrap to keep the autopilot helpers testable in isolation.
const isMainModule = require.main === module;
if (isMainModule) {
  process.on('SIGTERM', () => autopilot.gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => autopilot.gracefulShutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    autopilot.logError('autopilot', 'uncaughtException', err);
    autopilot.gracefulShutdown('uncaughtException', 1);
  });

  autopilot.log('autopilot', '... starting ...');
  autopilot.run()
    .then(() => {
      autopilot.log('autopilot', 'startup completed');
    })
    .catch((err) => {
      autopilot.logError('autopilot', 'startup failed', err);
      autopilot.gracefulShutdown('startup-failed', 1);
    });
}

// Re-export core parts for testing if needed (the test might need to be updated)
export const log = autopilot.log.bind(autopilot);
export const logError = autopilot.logError.bind(autopilot);
export const run = autopilot.run.bind(autopilot);
export const createFinishedHandler = autopilot.createFinishedHandler.bind(autopilot);
