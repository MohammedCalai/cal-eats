import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { closeDatabase, migrateDatabase, openDatabase } from "./db/index.js";
import { closeServer, createServer, listen } from "./server.js";
import { runOperationsCycle } from "./operations.js";
import { runMarketplaceWorker } from "./marketplace.js";
import { runGovernanceReminders } from "./admin-governance.js";
import { runProviderEventReconciliation } from "./payments/provider-events.js";
import { assertHostedPreviewSafe } from "./seed.js";
import { runMessageRetention } from "./order-messaging.js";
import { runCustomerMessageRetention } from "./customer-relationships.js";
import { runPromotionMaintenance } from "./loyalty.js";
import { notificationStreamHub } from "./notification-stream.js";
import { runStripeConnectWorker } from "./payments/stripe-connect.js";
import { runOrderConfirmationAlerts } from "./order-confirmation.js";
import { initializeCustomerEmailDelivery, runCustomerTransactionalEmails } from "./customer-emails.js";
import { initializeBusinessWeeklyStatements, runBusinessWeeklyStatements } from "./business-weekly-statements.js";

const config = loadConfig();
const db = openDatabase(config.dbPath);
migrateDatabase(db);
assertHostedPreviewSafe(db, config);
initializeCustomerEmailDelivery(db,config);
initializeBusinessWeeklyStatements(db,config);
let workerRunning = false;
let currentWorker = Promise.resolve();
let alertRunning = false;
let currentAlertWorker = Promise.resolve();
function triggerOrderAlerts() {
  if(alertRunning)return currentAlertWorker;
  alertRunning=true;
  currentAlertWorker=Promise.allSettled([runOrderConfirmationAlerts(db,config),runCustomerTransactionalEmails(db,config)]).then(results=>{for(const result of results)if(result.status==="rejected")console.error("Transactional email worker failed",result.reason instanceof Error?result.reason.name:"unknown error");}).finally(()=>{alertRunning=false;});
  return currentAlertWorker;
}
async function runWorkers() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    runOperationsCycle(db, config);
    runMarketplaceWorker(db, config);
    runGovernanceReminders(db, config);
    runMessageRetention(db, config);
    runCustomerMessageRetention(db, config);
    runPromotionMaintenance(db, config);
    await runProviderEventReconciliation(db, config);
    await runStripeConnectWorker(db, config);
    await runBusinessWeeklyStatements(db, config);
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
await triggerOrderAlerts();
const server = createServer(createApp({ db, config }));
await listen(server, config);
console.log(`Cal-Eats API listening at ${config.origin}`);
const worker = setInterval(() => { void triggerWorkers(); }, 60_000);
worker.unref();
const alertWorker=setInterval(()=>{void triggerOrderAlerts();},5000);
alertWorker.unref();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true; clearInterval(worker);clearInterval(alertWorker);
  notificationStreamHub(db).close();
  const result = await closeServer(server, { graceMs: 5_000 });
  if (!result.drained) process.exit(1);
  const workerDrained = await Promise.race([Promise.all([currentWorker,currentAlertWorker]).then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5_000))]);
  if (!workerDrained) process.exit(1);
  closeDatabase(db);
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
