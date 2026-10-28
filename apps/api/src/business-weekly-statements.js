import path from "node:path";
import { randomUUID } from "node:crypto";
import { withTransaction } from "./db/index.js";
import { requireRestaurantOwner } from "./auth/authorization.js";
import { exactObject, HttpError, readJson, sendJson } from "./http.js";
import { parseLondonDateRange } from "./marketplace-reporting.js";
import { createOrderAlertEmailAdapter, orderAlertEmailTransportReadiness } from "./order-alert-email.js";

const ZONE = "Europe/London", DAY = 86400000, workers = new WeakMap();
const validEmail = value => typeof value === "string" && /^[^\s<>@,;\r\n]+@[^\s<>@,;\r\n]+\.[A-Za-z]{2,}$/.test(value) && value.length <= 254;
const demoEmail = value => /(?:\.(?:invalid|local|test)|@example\.(?:com|net|org))$/i.test(value);
const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clean = value => String(value ?? "").replace(/[\r\n\0]+/g, " ").slice(0, 150);
const money = value => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(value / 100);
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
function londonDate(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function shiftDate(value, days) { return new Date(Date.parse(`${value}T00:00:00.000Z`) + days * DAY).toISOString().slice(0, 10); }
function mondayNine(value) {
  const range = parseLondonDateRange(new URL(`http://localhost/?from=${value}&to=${value}`));
  return new Date(Date.parse(range.from) + 9 * 3600000).toISOString();
}
export function nextWeeklyStatementAt(now) {
  const date = londonDate(now), weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  if (weekday === 1 && Date.parse(mondayNine(date)) > now.getTime()) return mondayNine(date);
  return mondayNine(shiftDate(date, ((8 - weekday) % 7) || 7));
}
export function weeklyStatementPeriod(due) {
  const monday = londonDate(new Date(due)), fromDate = shiftDate(monday, -7), toDate = shiftDate(monday, -1);
  return { fromDate, toDate, ...parseLondonDateRange(new URL(`http://localhost/?from=${fromDate}&to=${toDate}`)), timeZone: ZONE };
}
const deliveryMode = config => config.businessStatements?.sendEnabled ? config.orderAlertEmail.mode : "local";
function deliverySettings(config) { return { ...config.orderAlertEmail, mode: deliveryMode(config), localDirectory: path.join(config.orderAlertEmail.localDirectory, "business-statements") }; }
export function initializeBusinessWeeklyStatements(db, config) {
  const now = config.now().toISOString();
  db.prepare("INSERT OR IGNORE INTO business_statement_preferences(restaurant_id,user_id,enabled,activated_at,next_due_at,updated_at) SELECT m.restaurant_id,m.user_id,1,?,?,? FROM restaurant_memberships m JOIN users u ON u.id=m.user_id WHERE m.permission='owner' AND u.role='restaurant' AND u.account_enabled=1").run(now, nextWeeklyStatementAt(config.now()), now);
}

function csvCell(value) { let text = String(value ?? ""); if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; }
export function buildWeeklyStatementSnapshot(db, restaurantId, period, config) {
  const { from, toExclusive } = period;
  const restaurant = db.prepare("SELECT name FROM restaurants WHERE id=?").get(restaurantId);
  if (!restaurant) throw new Error("Restaurant unavailable");
  const activityCount = db.prepare("SELECT (SELECT COUNT(*) FROM orders WHERE restaurant_id=? AND created_at>=? AND created_at<?)+(SELECT COUNT(*) FROM marketplace_operations WHERE restaurant_id=? AND created_at>=? AND created_at<?)+(SELECT COUNT(*) FROM order_events e JOIN orders o ON o.id=e.order_id WHERE o.restaurant_id=? AND e.created_at>=? AND e.created_at<?)+(SELECT COUNT(*) FROM refunds r JOIN orders o ON o.id=r.order_id WHERE o.restaurant_id=? AND r.created_at>=? AND r.created_at<?) n").get(restaurantId,from,toExclusive,restaurantId,from,toExclusive,restaurantId,from,toExclusive,restaurantId,from,toExclusive).n;
  const movementCount = db.prepare("SELECT COUNT(*) n FROM journal_postings WHERE restaurant_id=? AND source_type IN ('merchant_transfer','transfer_reversal') AND direction='debit' AND created_at>=? AND created_at<?").get(restaurantId,from,toExclusive).n;
  const payoutCount = db.prepare("SELECT COUNT(*) n FROM payout_batches WHERE restaurant_id=? AND updated_at>=? AND updated_at<?").get(restaurantId,from,toExclusive).n + db.prepare("SELECT COUNT(*) n FROM stripe_connected_payouts WHERE restaurant_id=? AND ((updated_at>=? AND updated_at<?) OR (arrival_at>=? AND arrival_at<?))").get(restaurantId,from,toExclusive,from,toExclusive).n;
  if (activityCount + movementCount + payoutCount > 50000) throw new Error("WEEKLY_STATEMENT_TOO_LARGE");
  const orders = db.prepare("SELECT id,status,payment_method,payment_status,total_minor,commission_minor,created_at FROM orders WHERE restaurant_id=? AND created_at>=? AND created_at<? ORDER BY created_at,id").all(restaurantId, from, toExclusive);
  const operations = db.prepare("SELECT m.*,o.payment_method FROM marketplace_operations m LEFT JOIN orders o ON o.id=m.order_id WHERE m.restaurant_id=? AND m.created_at>=? AND m.created_at<? ORDER BY m.created_at,m.id").all(restaurantId, from, toExclusive);
  const movements = db.prepare("SELECT * FROM journal_postings WHERE restaurant_id=? AND source_type IN ('merchant_transfer','transfer_reversal') AND direction='debit' AND created_at>=? AND created_at<? ORDER BY created_at,id").all(restaurantId,from,toExclusive);
  const refunds = db.prepare("SELECT r.* FROM refunds r JOIN orders o ON o.id=r.order_id WHERE o.restaurant_id=? AND r.created_at>=? AND r.created_at<? ORDER BY r.created_at,r.id").all(restaurantId, from, toExclusive);
  const events = db.prepare("SELECT e.id,e.order_id,e.from_status,e.to_status,e.kind,e.created_at FROM order_events e JOIN orders o ON o.id=e.order_id WHERE o.restaurant_id=? AND e.created_at>=? AND e.created_at<? ORDER BY e.created_at,e.id").all(restaurantId, from, toExclusive);
  const payouts = db.prepare("SELECT * FROM payout_batches WHERE restaurant_id=? AND updated_at>=? AND updated_at<? ORDER BY updated_at,id").all(restaurantId, from, toExclusive);
  const bank = db.prepare("SELECT p.*,a.provider_mode FROM stripe_connected_payouts p LEFT JOIN provider_accounts a ON a.restaurant_id=p.restaurant_id AND a.provider_reference=p.provider_account_id WHERE p.restaurant_id=? AND ((p.updated_at>=? AND p.updated_at<?) OR (p.arrival_at>=? AND p.arrival_at<?)) ORDER BY p.updated_at,p.id").all(restaurantId, from, toExclusive, from, toExclusive);
  const confirmed = operations.filter(row => row.status === "confirmed"), sum = (rows, key = "amount_minor") => rows.reduce((total, row) => total + row[key], 0);
  const sales = confirmed.filter(row => ["payment_capture", "cash_order_accepted"].includes(row.kind));
  // Historical accepted orders without capture operations retain the existing report fallback.
  const legacy = orders.filter(row => ["accepted", "preparing", "ready", "out_for_delivery", "completed"].includes(row.status) && (row.payment_method !== "card" || ["stripe_captured", "stripe_partially_refunded", "stripe_refunded"].includes(row.payment_status)) && !db.prepare("SELECT 1 FROM marketplace_operations WHERE order_id=? AND kind IN ('payment_capture','cash_order_accepted')").get(row.id));
  const grossSalesMinor = sum(sales) + sum(legacy, "total_minor"), refundsMinor = refunds.reduce((total, row) => total + row.food_amount_minor + row.delivery_amount_minor, 0);
  const commissionMinor = sum(confirmed.filter(row => ["commission", "cash_commission_receivable"].includes(row.kind))) + sum(legacy, "commission_minor") - sum(refunds, "commission_reversal_minor");
  const providerModes = [...new Set([...operations,...movements,...payouts,...bank].map(row=>row.provider_mode).filter(Boolean))];
  if (orders.some(row=>row.payment_method==="mock_card") && !providerModes.includes("local_simulator")) providerModes.push("local_simulator");
  const summary = {
    restaurantName: clean(restaurant.name), currency: "GBP", timeZone: ZONE, fromDate: period.fromDate, toDate: period.toDate,
    simulation: config.paymentProviderMode !== "stripe_live" || providerModes.some(mode=>mode!=="stripe_live"), providerModes, basis: "Sales/commission use recorded confirmation activity; refunds include any order refunded in the week. Connected-balance transfers use immutable journal confirmation dates. Paid bank payout totals use the provider's arrival date, not the last refresh time. Exported payout record updates are not additional cashflow.",
    ordersPlaced: orders.length, completedUpdates: events.filter(row => row.to_status === "completed").length,
    messagesExchanged: db.prepare("SELECT COUNT(*) n FROM order_messages m JOIN orders o ON o.id=m.order_id WHERE o.restaurant_id=? AND m.created_at>=? AND m.created_at<?").get(restaurantId,from,toExclusive).n + db.prepare("SELECT COUNT(*) n FROM restaurant_customer_messages m JOIN restaurant_customer_threads t ON t.id=m.thread_id WHERE t.restaurant_id=? AND m.created_at>=? AND m.created_at<?").get(restaurantId,from,toExclusive).n,
    offersCreated: db.prepare("SELECT COUNT(*) n FROM offer_campaigns WHERE restaurant_id=? AND created_at>=? AND created_at<?").get(restaurantId,from,toExclusive).n,
    refundCasesOpened: db.prepare("SELECT COUNT(*) n FROM refund_cases WHERE restaurant_id=? AND created_at>=? AND created_at<?").get(restaurantId,from,toExclusive).n,
    grossSalesMinor, refundsMinor, commissionMinor, netEarningsMinor: grossSalesMinor - refundsMinor - commissionMinor,
    cashSalesMinor: sum(sales.filter(row => row.payment_method === "cash")) + sum(legacy.filter(row => row.payment_method === "cash"), "total_minor"),
    cardSalesMinor: sum(sales.filter(row => row.payment_method !== "cash")) + sum(legacy.filter(row => row.payment_method !== "cash"), "total_minor"),
    cashCollectedMinor: sum(operations.filter(row => row.kind === "cash_sale_recorded" && row.status === "held")),
    connectedBalanceTransfersMinor: sum(movements.filter(row => row.source_type === "merchant_transfer")) - sum(movements.filter(row => row.source_type === "transfer_reversal")),
    bankPayoutRecordedMinor: sum(bank.filter(row => row.status === "paid" && row.arrival_at >= from && row.arrival_at < toExclusive)),
    bankPayoutRecordsWithoutArrival: bank.filter(row => row.status === "paid" && !row.arrival_at).length,
    bankPendingRecordedMinor: sum(bank.filter(row => ["pending", "in_transit"].includes(row.status))),
    simulatedPayoutRecordedMinor: sum(payouts.filter(row => row.status === "paid" && row.provider_mode === "local_simulator"))
  };
  const rows = [["activity", "reference", "orderId", "status", "amountMinor", "commissionReversalMinor", "currency", "providerMode", "occurredAt"]];
  for (const row of orders) rows.push(["order_placed", row.id, row.id, row.status, row.total_minor, "", "GBP", row.payment_method === "mock_card" ? "local_simulator" : row.payment_method, row.created_at]);
  for (const row of events) rows.push([`order_${row.kind}`, row.id, row.order_id, row.to_status, "", "", "GBP", "", row.created_at]);
  for (const row of operations) rows.push([row.kind, row.id, row.order_id, row.status, row.amount_minor, "", row.currency, row.provider_mode, row.created_at]);
  for (const row of movements) rows.push([`${row.source_type}_confirmed`, row.id, row.order_id, "journal_recorded", row.amount_minor, "", row.currency, row.provider_mode, row.created_at]);
  for (const row of refunds) rows.push(["refund_recorded", row.id, row.order_id, "refunded", row.food_amount_minor + row.delivery_amount_minor, row.commission_reversal_minor, "GBP", "", row.created_at]);
  for (const row of payouts) rows.push(["payout_record_update", row.id, "", row.status, row.amount_minor, "", "GBP", row.provider_mode, row.updated_at]);
  for (const row of bank) rows.push(["bank_payout_record_update", row.id, "", row.status, row.amount_minor, "", "GBP", row.provider_mode || "not_verified", row.updated_at]);
  const csv = rows.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  if (Buffer.byteLength(csv) > 10 * 1024 * 1024) throw new Error("WEEKLY_STATEMENT_TOO_LARGE");
  return { summary, csv };
}

function settingsDto(db, restaurantId, userId, config) {
  const preference = db.prepare("SELECT * FROM business_statement_preferences WHERE restaurant_id=? AND user_id=?").get(restaurantId, userId), user = db.prepare("SELECT email FROM users WHERE id=?").get(userId);
  const email = orderAlertEmailTransportReadiness(deliverySettings(config));
  return { enabled: Boolean(preference.enabled), recipient: user.email, schedule: { day: "monday", hour: 9, timeZone: ZONE, description: "Monday at 09:00 UK time, covering the previous Monday–Sunday" }, nextScheduledAt: preference.enabled ? preference.next_due_at : null, email: { mode: email.mode, configured: email.configured, realDeliveryEnabled: Boolean(config.businessStatements?.sendEnabled && email.realDeliveryEnabled), note: config.businessStatements?.sendEnabled ? email.note : "Weekly statements are saved as private email previews. Hosted sending must be explicitly connected and enabled." } };
}
function currentSource(db, row, config) {
  const owner = db.prepare("SELECT u.email,p.enabled FROM users u JOIN restaurant_memberships m ON m.user_id=u.id AND m.restaurant_id=? AND m.permission='owner' JOIN business_statement_preferences p ON p.user_id=u.id AND p.restaurant_id=m.restaurant_id WHERE u.id=? AND u.account_enabled=1 AND u.role='restaurant'").get(row.restaurant_id, row.user_id);
  if (!owner || !owner.enabled || !validEmail(owner.email) || owner.email.toLowerCase() !== row.recipient.toLowerCase()) return "STATEMENT_OWNER_OR_EMAIL_CHANGED";
  if (deliveryMode(config) !== row.mode) return "STATEMENT_DELIVERY_MODE_CHANGED";
  if (row.mode !== "local" && (!config.businessStatements?.sendEnabled || demoEmail(row.recipient))) return "STATEMENT_EXTERNAL_SEND_DISABLED";
  return null;
}
export function buildBusinessStatementEmail(row, config) {
  const summary = parse(row.summary); if (!summary) throw new Error("Statement summary is invalid");
  const download = new URL(`/api/restaurant/restaurants/${row.restaurant_id}/weekly-statements/${row.id}.csv`, config.origin).href;
  const title = `Cal-Eats weekly statement | ${row.week_from} to ${row.week_to}`;
  const metrics = [["Orders placed", summary.ordersPlaced], ["Sales confirmed", money(summary.grossSalesMinor)], ["Refunds recorded", money(summary.refundsMinor)], ["Commission after reversals", money(summary.commissionMinor)], ["Net earnings activity", money(summary.netEarningsMinor)], ["Cash sales accepted", money(summary.cashSalesMinor)], ["Cash collected directly", money(summary.cashCollectedMinor)], ["Card / test card sales", money(summary.cardSalesMinor)], ["Transfers to connected balance", money(summary.connectedBalanceTransfersMinor)], ["Paid bank payout records with arrival dates this week", money(summary.bankPayoutRecordedMinor)], ["Paid payout records without a known arrival date", summary.bankPayoutRecordsWithoutArrival], ["Messages exchanged", summary.messagesExchanged], ["Offers created", summary.offersCreated], ["Refund cases opened", summary.refundCasesOpened]];
  const note = "Cash is handled directly by the restaurant. A transfer to a connected Stripe balance is not a bank payout. Rows show recorded events, not a promise of settlement; order, refund and financial events must not be added together as duplicate sales.";
  const warning = summary.simulation ? "TEST / PREVIEW OR MIXED HISTORY — test records may be included. Combined totals must not be treated as live-only payments or payouts." : "";
  const text = [`${summary.restaurantName} | ${title}`, warning, `Recorded provider modes: ${summary.providerModes?.join(", ") || "no financial activity"}`, ...metrics.map(([key, value]) => `${key}: ${value}`), summary.basis, note, `Download the complete activity CSV (owner sign-in required): ${download}`].filter(Boolean).join("\n\n");
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#121212;color:#fff;padding:24px"><h1 style="color:#33cfff">Cal-Eats</h1><h2>Weekly statement</h2><p>${escape(summary.restaurantName)} · ${row.week_from} to ${row.week_to} · UK time</p>${warning ? `<p><strong>${escape(warning)}</strong></p>` : ""}<p>Recorded provider modes: ${escape(summary.providerModes?.join(", ") || "no financial activity")}</p><table role="presentation" style="width:100%;max-width:600px">${metrics.map(([key, value]) => `<tr><td style="padding:10px;border-bottom:1px solid #444">${escape(key)}</td><td style="padding:10px;border-bottom:1px solid #444;text-align:right">${escape(value)}</td></tr>`).join("")}</table><p>${escape(summary.basis)}</p><p>${escape(note)}</p><p><a style="color:#33cfff" href="${escape(download)}">Download complete activity CSV</a> (owner sign-in required)</p></body></html>`;
  return { id: row.id, to: row.recipient, from: config.orderAlertEmail.from, subject: title, text, html, messageId: row.message_id, ...(Buffer.byteLength(row.csv) <= 1024 * 1024 ? { attachments: [{ filename: `Cal-Eats-weekly-${row.week_from}.csv`, contentType: "text/csv", contentBase64: Buffer.from(row.csv).toString("base64") }] } : {}) };
}

function queueDueStatements(db, config, limit) {
  initializeBusinessWeeklyStatements(db, config);
  let queued = 0;
  for (let index = 0; index < limit; index++) {
    const stamp = config.now().toISOString();
    const preference = db.prepare("SELECT p.*,u.email FROM business_statement_preferences p JOIN users u ON u.id=p.user_id JOIN restaurant_memberships m ON m.user_id=p.user_id AND m.restaurant_id=p.restaurant_id AND m.permission='owner' WHERE p.enabled=1 AND p.next_due_at<=? AND u.account_enabled=1 AND u.role='restaurant' ORDER BY p.next_due_at,p.restaurant_id,p.user_id LIMIT 1").get(stamp);
    if (!preference) break;
    const period = weeklyStatementPeriod(preference.next_due_at), id = randomUUID();
    let snapshot, failure = null;
    try { snapshot = buildWeeklyStatementSnapshot(db, preference.restaurant_id, period, config); } catch (error) { snapshot = { summary: {}, csv: "" }; failure = error.message === "WEEKLY_STATEMENT_TOO_LARGE" ? error.message : "STATEMENT_SNAPSHOT_FAILED"; }
    if (!validEmail(preference.email)) failure = "STATEMENT_RECIPIENT_INVALID";
    withTransaction(db, () => {
      const inserted = db.prepare("INSERT OR IGNORE INTO business_weekly_statement_outbox(id,restaurant_id,user_id,recipient,week_from,week_to,summary,csv,message_id,mode,status,last_error,queued_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, preference.restaurant_id, preference.user_id, preference.email, period.fromDate, period.toDate, JSON.stringify(snapshot.summary), snapshot.csv, `<cal-eats-business-statement-${id}@calai.info>`, deliveryMode(config), failure ? "failed" : "pending", failure, stamp, stamp);
      queued += Number(inserted.changes);
      db.prepare("UPDATE business_statement_preferences SET next_due_at=?,updated_at=? WHERE restaurant_id=? AND user_id=? AND next_due_at=?").run(mondayNine(shiftDate(londonDate(new Date(preference.next_due_at)), 7)), stamp, preference.restaurant_id, preference.user_id, preference.next_due_at);
    });
  }
  return queued;
}
async function run(db, config, { workerId = randomUUID(), limit = 25, adapter, beforeDispatch } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Weekly statement limit must be between 1 and 100");
  const result = { queued: queueDueStatements(db, config, limit), sent: 0, localSaved: 0, failed: 0, unknown: 0, cancelled: 0 }, stamp = config.now().toISOString();
  withTransaction(db, () => {
    db.prepare("UPDATE business_weekly_statement_outbox SET status=CASE WHEN dispatch_started_at IS NULL THEN 'pending' ELSE 'unknown' END,last_error=CASE WHEN dispatch_started_at IS NULL THEN 'STATEMENT_LEASE_RECOVERED' ELSE 'STATEMENT_DISPATCH_OUTCOME_UNKNOWN' END,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE status='claimed' AND lease_expires_at<=?").run(stamp, stamp);
  });
  const sender = adapter ?? createOrderAlertEmailAdapter(deliverySettings(config));
  for (let index = 0; index < limit; index++) {
    const row = withTransaction(db, () => {
      const candidate = db.prepare("SELECT * FROM business_weekly_statement_outbox WHERE status='pending' ORDER BY queued_at,rowid LIMIT 1").get();
      if (!candidate) return null;
      const now = config.now().toISOString();
      return db.prepare("UPDATE business_weekly_statement_outbox SET status='claimed',lease_owner=?,lease_expires_at=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='pending'").run(workerId, new Date(Date.parse(now) + 120000).toISOString(), now, candidate.id).changes ? candidate : null;
    });
    if (!row) break;
    const owned = () => Boolean(db.prepare("SELECT 1 FROM business_weekly_statement_outbox WHERE id=? AND status='claimed' AND lease_owner=? AND lease_expires_at>?").get(row.id, workerId, config.now().toISOString()));
    const cancel = code => db.prepare("UPDATE business_weekly_statement_outbox SET status='cancelled',last_error=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='claimed' AND lease_owner=? AND dispatch_started_at IS NULL").run(code, config.now().toISOString(), row.id, workerId);
    const beforeSend = () => withTransaction(db, () => {
      if (!owned()) return false;
      const invalid = currentSource(db, row, config); if (invalid) { cancel(invalid); return false; }
      const now = config.now().toISOString();
      return db.prepare("UPDATE business_weekly_statement_outbox SET dispatch_started_at=COALESCE(dispatch_started_at,?),updated_at=? WHERE id=? AND status='claimed' AND lease_owner=? AND lease_expires_at>?").run(now, now, row.id, workerId, now).changes === 1;
    });
    let outcome;
    try {
      await beforeDispatch?.(row);
      if (!owned()) continue;
      const invalid = currentSource(db, row, config); if (invalid) { cancel(invalid); result.cancelled++; continue; }
      outcome = await sender(buildBusinessStatementEmail(row, config), { beforeSend });
    } catch { outcome = { status: db.prepare("SELECT dispatch_started_at FROM business_weekly_statement_outbox WHERE id=?").get(row.id)?.dispatch_started_at ? "unknown" : "failed", errorCode: "STATEMENT_ADAPTER_ERROR" }; }
    const status = ["sent", "local_saved", "failed", "unknown", "cancelled"].includes(outcome?.status) ? outcome.status : "unknown", now = config.now().toISOString();
    const code = /^[A-Z0-9_]{1,80}$/.test(outcome?.errorCode ?? "") ? outcome.errorCode : status === "unknown" ? "STATEMENT_OUTCOME_UNKNOWN" : null;
    const saved = db.prepare("UPDATE business_weekly_statement_outbox SET status=?,last_error=?,sent_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='claimed' AND lease_owner=? AND lease_expires_at>?").run(status, code, ["sent", "local_saved"].includes(status) ? now : null, now, row.id, workerId, now);
    if (saved.changes) result[status === "local_saved" ? "localSaved" : status]++;
  }
  return result;
}
export function runBusinessWeeklyStatements(db, config, options) {
  if (workers.has(db)) return workers.get(db);
  const work = run(db, config, options).finally(() => workers.delete(db)); workers.set(db, work); return work;
}

export async function handleBusinessStatementRoutes({ req, res, url, db, config, session }) {
  const match = url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/weekly-statements(?:\/(settings|([A-Za-z0-9-]+)\.csv))?$/);
  if (!match) return false;
  const user = requireRestaurantOwner(db, session, match[1]);
  initializeBusinessWeeklyStatements(db, config);
  if (match[2] === "settings" && ["GET", "PATCH"].includes(req.method)) {
    if (req.method === "PATCH") {
      const body = await readJson(req, config.bodyLimit); exactObject(body, ["enabled"]);
      if (typeof body.enabled !== "boolean") throw new HttpError(400, "VALIDATION_ERROR", "Weekly email preference is invalid");
      const existing = db.prepare("SELECT enabled FROM business_statement_preferences WHERE restaurant_id=? AND user_id=?").get(match[1], user.id), now = config.now().toISOString();
      db.prepare("UPDATE business_statement_preferences SET enabled=?,next_due_at=CASE WHEN enabled=0 AND ?=1 THEN ? ELSE next_due_at END,updated_at=? WHERE restaurant_id=? AND user_id=?").run(Number(body.enabled), Number(body.enabled), nextWeeklyStatementAt(config.now()), now, match[1], user.id);
      if (!body.enabled && existing.enabled) db.prepare("UPDATE business_weekly_statement_outbox SET status='cancelled',last_error='STATEMENT_PREFERENCE_PAUSED',updated_at=? WHERE restaurant_id=? AND user_id=? AND status='pending'").run(now, match[1], user.id);
    }
    return sendJson(res, 200, { data: settingsDto(db, match[1], user.id, config) });
  }
  if (req.method === "GET" && match[3]) {
    const row = db.prepare("SELECT csv FROM business_weekly_statement_outbox WHERE id=? AND restaurant_id=? AND user_id=?").get(match[3], match[1], user.id);
    if (!row || !row.csv) throw new HttpError(404, "NOT_FOUND", "Statement unavailable");
    res.setHeader("Content-Type", "text/csv; charset=utf-8"); res.setHeader("Content-Disposition", `attachment; filename="Cal-Eats-weekly-${match[3]}.csv"`); res.end(row.csv); return true;
  }
  if (req.method === "GET" && !match[2]) {
    const page = Number(url.searchParams.get("page") ?? 1), pageSize = Number(url.searchParams.get("pageSize") ?? 20);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new HttpError(400, "VALIDATION_ERROR", "Statement pagination is invalid");
    const total = db.prepare("SELECT COUNT(*) n FROM business_weekly_statement_outbox WHERE restaurant_id=? AND user_id=?").get(match[1], user.id).n;
    const rows = db.prepare("SELECT id,week_from,week_to,status,mode,queued_at,sent_at,last_error FROM business_weekly_statement_outbox WHERE restaurant_id=? AND user_id=? ORDER BY week_from DESC,id DESC LIMIT ? OFFSET ?").all(match[1], user.id, pageSize, (page - 1) * pageSize);
    return sendJson(res, 200, { data: { items: rows.map(row => ({ id: row.id, weekFrom: row.week_from, weekTo: row.week_to, status: row.status, mode: row.mode, queuedAt: row.queued_at, sentAt: row.sent_at, errorCode: row.last_error, downloadUrl: `/api/restaurant/restaurants/${match[1]}/weekly-statements/${row.id}.csv` })), pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize), hasNext: page * pageSize < total, hasPrevious: page > 1 } } });
  }
  return false;
}
