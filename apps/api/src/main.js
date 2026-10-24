import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { closeDatabase, migrateDatabase, openDatabase } from "./db/index.js";
import { closeServer, createServer, listen } from "./server.js";
import { runOperationsCycle } from "./operations.js";

const config = loadConfig();
const db = openDatabase(config.dbPath);
migrateDatabase(db);
runOperationsCycle(db, config);
const server = createServer(createApp({ db, config }));
await listen(server, config);
console.log(`Calai Eats API listening at ${config.origin}`);
const worker = setInterval(() => { runOperationsCycle(db, config); }, 60_000);
worker.unref();

async function shutdown() { clearInterval(worker); await closeServer(server); closeDatabase(db); }
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
