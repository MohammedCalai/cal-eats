import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { closeDatabase, migrateDatabase, openDatabase } from "./db/index.js";
import { closeServer, createServer, listen } from "./server.js";
import { runOperationsCycle } from "./operations.js";
import { runMarketplaceWorker } from "./marketplace.js";
import { runGovernanceReminders } from "./admin-governance.js";
import { runProviderEventReconciliation } from "./payments/provider-events.js";
import { assertHostedPreviewSafe } from "./seed.js";

const config = loadConfig();
const db = openDatabase(config.dbPath);
migrateDatabase(db);
assertHostedPreviewSafe(db, config);
let workerRunning = false;
let currentWorker = Promise.resolve();
async function runWorkers() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    runOperationsCycle(db, config);
    runMarketplaceWorker(db, config);
    runGovernanceReminders(db, config);
    await runProviderEventReconciliation(db, config);
  } catch (error) {
    console.error("Background worker cycle failed", error instanceof Error ? error.message : "unknown error");
  } finally {
    workerRunning = false;
  }
}
function triggerWorkers() {
  if (!workerRunning) currentWorker = runWorkers();
  return currentWorker;
}

await triggerWorkers();
const server = createServer(createApp({ db, config }));
await listen(server, config);
console.log(`Cal-Eats API listening at ${config.origin}`);
const worker = setInterval(() => { void triggerWorkers(); }, 60_000);
worker.unref();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true; clearInterval(worker);
  const result = await closeServer(server, { graceMs: 5_000 });
  if (!result.drained) process.exit(1);
  const workerDrained = await Promise.race([currentWorker.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5_000))]);
  if (!workerDrained) process.exit(1);
  closeDatabase(db);
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
