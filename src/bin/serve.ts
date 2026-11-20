import { loadConfig } from '../config.ts';
import { openDb } from '../db/db.ts';
import { buildApp, listen } from '../http/wiring.ts';
import { startWorker } from '../worker/runner.ts';

const args = new Set(process.argv.slice(2));
const webOnly = args.has('--web-only');
const workerOnly = args.has('--worker-only');

const config = loadConfig();
const db = openDb(config.dbPath);
const app = buildApp(db, config);

let stopWorker: (() => void) | null = null;
if (!webOnly) {
  stopWorker = startWorker(db, config, { intervalMs: config.workerPollMs });
}

let server: import('node:http').Server | null = null;
if (!workerOnly) {
  server = await listen(app, config.port);
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  console.log(`[deliverydesk] api listening on http://127.0.0.1:${port}`);
  console.log(`[deliverydesk] buyer console  http://127.0.0.1:${port}/`);
  console.log(`[deliverydesk] support console http://127.0.0.1:${port}/console`);
}
if (stopWorker) console.log(`[deliverydesk] worker polling every ${config.workerPollMs}ms`);

const shutdown = () => {
  stopWorker?.();
  server?.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
