import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { closeDatabase, prepareDatabase, openDatabase } from "./db/index.js";
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
import {runRestaurantCommissionEmails} from "./restaurant-commission-emails.js";
import {runAccountAccessEmails} from "./account-access-email.js";
import {runCustomerPush} from "./customer-push.js";

const config = loadConfig();
const db = openDatabase(config.dbPath);
try { prepareDatabase(db, config); }
catch (error) { closeDatabase(db); throw error; }
assertHostedPreviewSafe(db, config);
initializeCustomerEmailDelivery(db,config);
initializeBusinessWeeklyStatements(db,config);
let workerRunning = false;
let currentWorker = Promise.resolve();
let alertRunning = false;
let currentAlertWorker = Promise.resolve();
let commissionRunning = false;
let currentCommissionWorker = Promise.resolve();
let accountEmailRunning=false,currentAccountEmailWorker=Promise.resolve();
let customerPushRunning=false,currentCustomerPushWorker=Promise.resolve();
function triggerCustomerPush(){
  if(customerPushRunning)return currentCustomerPushWorker;
  customerPushRunning=true;
  currentCustomerPushWorker=runCustomerPush(db,config).catch(error=>{console.error("Customer notification worker failed",error instanceof Error?error.name:"unknown error");}).finally(()=>{customerPushRunning=false;});
  return currentCustomerPushWorker;
}
function triggerAccountEmails(){
  if(accountEmailRunning)return currentAccountEmailWorker;
  accountEmailRunning=true;
  currentAccountEmailWorker=runAccountAccessEmails(db,config).catch(error=>{console.error("Account recovery email worker failed",error instanceof Error?error.name:"unknown error");}).finally(()=>{accountEmailRunning=false;});
  return currentAccountEmailWorker;
}
function triggerCommissionEmails() {
  if(commissionRunning)return currentCommissionWorker;
  commissionRunning=true;
  currentCommissionWorker=runRestaurantCommissionEmails(db,config).catch(error=>{console.error("Commission email worker failed",error instanceof Error?error.name:"unknown error");}).finally(()=>{commissionRunning=false;});
  return currentCommissionWorker;
}
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
// Commission notices must not hold up HTTP startup or urgent order/customer notices.
void triggerCommissionEmails();
void triggerAccountEmails();
void triggerCustomerPush();
const worker = setInterval(() => { void triggerWorkers(); }, 60_000);
worker.unref();
const alertWorker=setInterval(()=>{void triggerOrderAlerts();},5000);
alertWorker.unref();
const commissionWorker=setInterval(()=>{void triggerCommissionEmails();},5000);
commissionWorker.unref();
const accountEmailWorker=setInterval(()=>{void triggerAccountEmails();},5000);
accountEmailWorker.unref();
const customerPushWorker=setInterval(()=>{void triggerCustomerPush();},5000);
customerPushWorker.unref();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true; clearInterval(worker);clearInterval(alertWorker);clearInterval(commissionWorker);clearInterval(accountEmailWorker);clearInterval(customerPushWorker);
  notificationStreamHub(db).close();
  const result = await closeServer(server, { graceMs: 5_000 });
  if (!result.drained) process.exit(1);
  const workerDrained = await Promise.race([Promise.all([currentWorker,currentAlertWorker,currentCommissionWorker,currentAccountEmailWorker,currentCustomerPushWorker]).then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5_000))]);
  if (!workerDrained) process.exit(1);
  closeDatabase(db);
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
