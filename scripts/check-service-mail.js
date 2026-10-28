import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../apps/api/src/config.js";
import { createOrderAlertEmailAdapter } from "../apps/api/src/order-alert-email.js";

const config = loadConfig(), settings = config.orderAlertEmail;
if (!settings.recipient) throw new Error("Set the approved administrator alert recipient first");
const journal = path.join(path.dirname(settings.graph.cacheFile), "mail-connection-check.private.json");
if (!process.argv.includes("--send-confirmed-owner")) {
  console.log(JSON.stringify({ sendsEmail: false, from: settings.from, recipient: settings.recipient, purpose: "Cal-Eats mail connection check", existingCheck: fs.existsSync(journal) ? JSON.parse(fs.readFileSync(journal)).status : null }));
} else {
  const existing = fs.existsSync(journal) ? JSON.parse(fs.readFileSync(journal)) : null;
  if (existing && !(existing.status === "failed" && process.argv.includes("--retry-definite-failure"))) throw new Error("A connection check already exists. Never automatically resend a dispatched, accepted or uncertain message.");
  const record = { id: randomUUID(), status: "prepared", from: settings.from, recipient: settings.recipient, createdAt: new Date().toISOString() };
  const save = () => fs.writeFileSync(journal, JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.mkdirSync(path.dirname(journal), { recursive: true }); save();
  const sender = createOrderAlertEmailAdapter({ ...settings, mode: "graph", graph: { ...settings.graph, enabled: true } });
  const result = await sender({ id: record.id, from: settings.from, to: settings.recipient, subject: "Cal-Eats support mailbox — connection check", messageId: `<cal-eats-order-alert-${record.id}@calai.info>`, text: `The Cal-Eats support mailbox is connected.\n\nSender: ${settings.from}\n\nThis is one connection check for your approved administrator alert address. The order-confirmation, customer-update and message email features are built locally. The hosted preview has not yet been updated. No payment was taken and no restaurant was contacted.`, html: `<html><body style="font-family:Arial;background:#f3f5f8;padding:24px"><div style="max-width:560px;margin:auto;background:white;border-radius:14px;overflow:hidden"><div style="background:#121316;padding:24px"><img src="https://eats.calai.info/assets/cal-eats-logo.png" width="210" alt="Cal-Eats"></div><div style="padding:24px;border-top:4px solid #2865e9"><h1>Support mailbox connected</h1><p>This is a single connection check for your approved administrator alert address.</p><p>Cal-Eats will use <strong>${settings.from}</strong> for order alerts and customer updates when the new version is deployed and email delivery is enabled.</p><p>The current hosted preview has not been updated. No payment was taken and no restaurant was contacted.</p></div></div></body></html>` }, { beforeSend: () => { record.status = "dispatched"; record.dispatchedAt = new Date().toISOString(); save(); return true; } });
  record.status = result.status; record.errorCode = result.errorCode || null; record.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: record.status, errorCode: record.errorCode, acceptedByProvider: record.status === "sent", inboxDeliveryConfirmed: false, automaticWorkersEnabled: false }));
}
