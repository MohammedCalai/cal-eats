import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { closeDatabase, migrateDatabase, openDatabase } from "./db/index.js";
import { closeServer, createServer, listen } from "./server.js";
import { runOperationsCycle } from "./operations.js";
import { assertHostedPreviewSafe } from "./seed.js";

const config = loadConfig();
const db = openDatabase(config.dbPath);
migrateDatabase(db);
assertHostedPreviewSafe(db, config);
runOperationsCycle(db, config);
const server = createServer(createApp({ db, config }));
await listen(server, config);
console.log(`Cal-Eats API listening at ${config.origin}`);
const worker = setInterval(() => { runOperationsCycle(db, config); }, 60_000);
worker.unref();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true; clearInterval(worker);
  const result = await closeServer(server, { graceMs: 5_000 });
  if (!result.drained) process.exit(1);
  closeDatabase(db);
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
