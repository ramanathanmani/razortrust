/**
 * Public surface of the API package.
 *
 * Exported so the demo and the console can drive a real server in-process
 * rather than against a mock — what a judge watches is the same code path a
 * deployment would run.
 */
export { buildServer } from './server.js';
export { loadConfig, type Config } from './config.js';
export { hashApiKey, KEY_PREFIX } from './auth.js';
export {
  asFakeGateway,
  asFakeStructurer,
  buildGateway,
  getGateway,
  getStructurer,
  resetGateway,
} from './gateway.js';
export { runSweep, startSweeper } from './sweeper.js';
export { reconcileIntent } from './reconcile.js';
