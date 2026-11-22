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
import {runBusinessAdjustmentCredits} from "./payments/business-adjustment-worker.js";
import { runOrderConfirmationAlerts } from "./order-confirmation.js";
import { initializeCustomerEmailDelivery, runCustomerTransactionalEmails } from "./customer-emails.js";
import { initializeBusinessWeeklyStatements, runBusinessWeeklyStatements } from "./business-weekly-statements.js";
import {runRestaurantCommissionEmails} from "./restaurant-commission-emails.js";
import {runBusinessReportEmails} from "./business-report-emails.js";
import {runAccountAccessEmails} from "./account-access-email.js";
import {runCustomerPush} from "./customer-push.js";
import {runOrderLiveActivities} from "./order-live-activities.js";
import {runCustomerPrivacyRetention} from "./customer-privacy.js";
import {runCustomerErasureConfirmations} from "./customer-erasure.js";
import {initializeCustomerLegal} from "./customer-legal.js";
import {initializeMerchantCommercial} from "./merchant-commercial.js";
import {runMediaObjectCleanup} from "./media-object-store.js";
import {evaluateSurfaceMonitoring,getSurfaceSettings} from './surface-monitoring.js';
import {runBusinessMonitoringPush} from './business-monitoring-push.js';
import {runBusinessMonitoringRetention} from './business-monitoring-retention.js';

const config = loadConfig();
const db = openDatabase(config.dbPath);
try { prepareDatabase(db, config); }
catch (error) { closeDatabase(db); throw error; }
assertHostedPreviewSafe(db, config);
// Validate immutable legal metadata before any policy-driven minimisation runs.
initializeCustomerLegal(db,config);
initializeMerchantCommercial(db,config);
initializeCustomerEmailDelivery(db,config);
initializeBusinessWeeklyStatements(db,config);
let workerRunning = false;
let currentWorker = Promise.resolve();
let alertRunning = false;
let currentAlertWorker = Promise.resolve();
let commissionRunning = false;
let currentCommissionWorker = Promise.resolve();
let accountEmailRunning=false,currentAccountEmailWorker=Promise.resolve();
let reportEmailRunning=false,currentReportEmailWorker=Promise.resolve();
function triggerReportEmails(){
  if(reportEmailRunning)return currentReportEmailWorker;
  reportEmailRunning=true;
  currentReportEmailWorker=runBusinessReportEmails(db,config,{limit:5}).catch(()=>{console.error("Requested business report email worker failed");}).finally(()=>{reportEmailRunning=false;});
  return currentReportEmailWorker;
}
let customerPushRunning=false,currentCustomerPushWorker=Promise.resolve();
let liveActivityRunning=false,currentLiveActivityWorker=Promise.resolve();
let mediaCleanupRunning=false,currentMediaCleanup=Promise.resolve();
let surfaceRunning=false,currentSurfaceWorker=Promise.resolve(),surfaceLastStarted=0;
let businessPushRunning=false,currentBusinessPushWorker=Promise.resolve();
function triggerSurfaceMonitoring(){if(surfaceRunning)return currentSurfaceWorker;surfaceRunning=true;surfaceLastStarted=config.now().getTime();currentSurfaceWorker=evaluateSurfaceMonitoring(db,config).catch(()=>{console.error('Business tablet monitoring cycle failed');}).finally(()=>{surfaceRunning=false;});return currentSurfaceWorker;}
function triggerBusinessMonitoringPush(){if(businessPushRunning)return currentBusinessPushWorker;businessPushRunning=true;currentBusinessPushWorker=runBusinessMonitoringPush(db,config).catch(()=>{console.error('Business device notification cycle failed');}).finally(()=>{businessPushRunning=false;});return currentBusinessPushWorker;}
function triggerMediaCleanup(){
  if(mediaCleanupRunning)return currentMediaCleanup;
  mediaCleanupRunning=true;
  currentMediaCleanup=runMediaObjectCleanup(db,config).catch(()=>{console.error("Image cleanup worker failed");}).finally(()=>{mediaCleanupRunning=false;});
  return currentMediaCleanup;
}
function triggerLiveActivities(){
  if(liveActivityRunning)return currentLiveActivityWorker;
  liveActivityRunning=true;
  currentLiveActivityWorker=runOrderLiveActivities(db,config).catch(()=>{console.error("Live order tracking worker failed");}).finally(()=>{liveActivityRunning=false;});
  return currentLiveActivityWorker;
}
function triggerCustomerPush(){
  if(customerPushRunning)return currentCustomerPushWorker;
  customerPushRunning=true;
  currentCustomerPushWorker=runCustomerPush(db,config).catch(error=>{console.error("Customer notification worker failed",error instanceof Error?error.name:"unknown error");}).finally(()=>{customerPushRunning=false;});
  return currentCustomerPushWorker;
}
function triggerAccountEmails(){
  if(accountEmailRunning)return currentAccountEmailWorker;
  accountEmailRunning=true;
  currentAccountEmailWorker=Promise.allSettled([runAccountAccessEmails(db,config),runCustomerErasureConfirmations(db,config)]).then(results=>{for(const result of results)if(result.status==="rejected")console.error("Account email worker failed",result.reason instanceof Error?result.reason.name:"unknown error");}).finally(()=>{accountEmailRunning=false;});
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
    runCustomerPrivacyRetention(db,config);
    runBusinessMonitoringRetention(db,config);
    await runProviderEventReconciliation(db, config);
    await runStripeConnectWorker(db, config);
    await runBusinessAdjustmentCredits(db,config);
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
void triggerReportEmails();
void triggerAccountEmails();
void triggerCustomerPush();
void triggerLiveActivities();
void triggerMediaCleanup();
void triggerSurfaceMonitoring();
void triggerBusinessMonitoringPush();
const worker = setInterval(() => { void triggerWorkers(); }, 60_000);
worker.unref();
const alertWorker=setInterval(()=>{void triggerOrderAlerts();},5000);
alertWorker.unref();
const commissionWorker=setInterval(()=>{void triggerCommissionEmails();},5000);
commissionWorker.unref();
const reportEmailWorker=setInterval(()=>{void triggerReportEmails();},5000);
reportEmailWorker.unref();
const accountEmailWorker=setInterval(()=>{void triggerAccountEmails();},5000);
accountEmailWorker.unref();
const customerPushWorker=setInterval(()=>{void triggerCustomerPush();},5000);
customerPushWorker.unref();
const liveActivityWorker=setInterval(()=>{void triggerLiveActivities();},5000);
liveActivityWorker.unref();
const mediaCleanupWorker=setInterval(()=>{void triggerMediaCleanup();},60000);
mediaCleanupWorker.unref();
const surfaceMonitoringWorker=setInterval(()=>{try{if(config.now().getTime()-surfaceLastStarted>=getSurfaceSettings(db).evaluationSeconds*1000)void triggerSurfaceMonitoring();}catch{console.error('Business tablet monitoring settings unavailable');}},5000);
surfaceMonitoringWorker.unref();
const businessMonitoringPushWorker=setInterval(()=>{void triggerBusinessMonitoringPush();},15000);
businessMonitoringPushWorker.unref();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true; clearInterval(worker);clearInterval(alertWorker);clearInterval(commissionWorker);clearInterval(accountEmailWorker);clearInterval(customerPushWorker);clearInterval(liveActivityWorker);clearInterval(mediaCleanupWorker);
  clearInterval(reportEmailWorker);
  clearInterval(surfaceMonitoringWorker);clearInterval(businessMonitoringPushWorker);
  notificationStreamHub(db).close();
  const result = await closeServer(server, { graceMs: 5_000 });
  if (!result.drained) process.exit(1);
  const workerDrained = await Promise.race([Promise.all([currentWorker,currentAlertWorker,currentCommissionWorker,currentAccountEmailWorker,currentReportEmailWorker,currentCustomerPushWorker,currentLiveActivityWorker,currentMediaCleanup,currentSurfaceWorker,currentBusinessPushWorker]).then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5_000))]);
  if (!workerDrained) process.exit(1);
  closeDatabase(db);
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
