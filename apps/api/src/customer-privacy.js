import { createHash, randomUUID } from "node:crypto";
import { withTransaction } from "./db/index.js";
import { exactObject, HttpError, sendJson } from "./http.js";

const defaults = Object.freeze({ chatDays: 30, allergyDays: 30, orderContactDays: 90, resolvedSupportMonths: 12, accountingYears: 6 });
const disabled = Object.freeze({ enabled: false, version: null, approvedAt: null, healthDataEnabled: false, retention: defaults, deletionTargetCalendarMonths: 1 });
const healthText = "I explicitly agree to Cal-Eats storing these optional allergy notes and sharing them with this restaurant to handle this order. I can order without entering allergy notes. To withdraw this consent, contact support@calai.info; the team will verify the request and explain any effect on an active order. Allergy notes are not used for marketing.";
export const orderHealthConsentNotice = Object.freeze({ version: "allergy-order-v1", sha256: createHash("sha256").update(healthText).digest("hex"), text: healthText });

// This policy has no implied approval and makes no changes until explicitly enabled.
export function loadCustomerPrivacyConfig(input) {
  if (input == null || input.enabled === false) return disabled;
  if (input.enabled !== true) throw new Error("Customer privacy enablement must be an explicit boolean");
  const approved = new Date(input.approvedAt);
  if (typeof input.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(input.version) || typeof input.approvedAt !== "string" || !Number.isFinite(approved.getTime()) || approved.toISOString() !== input.approvedAt || typeof input.approvalReference !== "string" || input.approvalReference.trim().length < 10 || input.approvalReference.length > 200) throw new Error("Customer privacy requires a version, operator approval reference and canonical UTC approval date");
  const retention = { ...defaults, ...input.retention };
  if (input.retention != null && (typeof input.retention !== "object" || Array.isArray(input.retention) || Object.keys(input.retention).some(key => !(key in defaults)))) throw new Error("Customer privacy retention fields are invalid");
  for (const [key, value] of Object.entries(defaults)) if (retention[key] !== value) throw new Error(`Customer privacy retention ${key} must match the reviewed policy`);
  if (input.deletionTargetCalendarMonths !== undefined && input.deletionTargetCalendarMonths !== 1) throw new Error("Customer privacy deletion target must be one calendar month");
  if (input.healthDataEnabled !== undefined && typeof input.healthDataEnabled !== "boolean") throw new Error("Health-data collection enablement must be an explicit boolean");
  const healthDataEnabled = input.healthDataEnabled === true;
  if (healthDataEnabled && (typeof input.healthDataApprovalReference !== "string" || input.healthDataApprovalReference.trim().length < 10 || input.healthDataApprovalReference.length > 200)) throw new Error("Health-data collection requires a separately verified provider-coverage approval reference");
  return Object.freeze({ enabled: true, version: input.version, approvedAt: approved.toISOString(), approvalReference: input.approvalReference.trim(), healthDataEnabled, ...(healthDataEnabled ? { healthDataApprovalReference: input.healthDataApprovalReference.trim() } : {}), retention: Object.freeze(retention), deletionTargetCalendarMonths: 1 });
}

export async function routeCustomerPrivacy({ req, res, url, config }) {
  if (url.pathname !== "/api/customer/privacy" || req.method !== "GET") return false;
  const enabled = config.customerPrivacy?.enabled === true;
  const healthDataEnabled = enabled && config.customerPrivacy.healthDataEnabled === true;
  return sendJson(res, 200, { data: { enabled, healthDataEnabled, healthConsent: healthDataEnabled ? orderHealthConsentNotice : null } });
}

// Shape normalization precedes replay lookup; current notice validation happens
// only for a new order, so an old successful request remains safely replayable.
export function normalizeOrderHealthConsent(value, allergyNotes) {
  if (value === undefined) return null;
  exactObject(value, ["accepted", "version", "sha256"]);
  if (!allergyNotes || value.accepted !== true || typeof value.version !== "string" || value.version.length > 80 || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new HttpError(400, "VALIDATION_ERROR", "Allergy consent is invalid");
  return { accepted: true, version: value.version, sha256: value.sha256 };
}
export function requireOrderHealthConsent(config, allergyNotes, consent) {
  if (!allergyNotes) return;
  if (config.runMode === "hosted-preview" && (!config.customerPrivacy?.enabled || config.customerPrivacy.healthDataEnabled !== true)) throw new HttpError(409, "ALLERGY_COLLECTION_UNAVAILABLE", "Allergy-note collection is unavailable. Contact the restaurant directly about allergies before ordering, and remove the optional notes from this checkout.");
  if (!config.customerPrivacy?.enabled) return;
  if (config.customerPrivacy.healthDataEnabled !== true) throw new HttpError(409, "ALLERGY_COLLECTION_UNAVAILABLE", "Allergy-note collection is unavailable. Contact the restaurant directly about allergies before ordering, and remove the optional notes from this checkout.");
  if (!consent) throw new HttpError(428, "ALLERGY_CONSENT_REQUIRED", "Please explicitly agree to sharing your allergy notes with the restaurant, or clear the optional notes before ordering.");
  if (consent.version !== orderHealthConsentNotice.version || consent.sha256 !== orderHealthConsentNotice.sha256) throw new HttpError(409, "ALLERGY_NOTICE_CHANGED", "Please review the current allergy-note consent before ordering.");
}
export function recordOrderHealthConsent(db, config, { orderId, userId, allergyNotes, consent, source, now }) {
  requireOrderHealthConsent(config, allergyNotes, consent);
  if (!config.customerPrivacy?.enabled || !allergyNotes) return;
  db.prepare("INSERT INTO order_health_consents(order_id,user_id,policy_version,notice_version,notice_sha256,consented_at,source) VALUES(?,?,?,?,?,?,?)").run(orderId, userId, config.customerPrivacy.version, consent.version, consent.sha256, now, source);
}

export function subtractCalendarMonths(date, months) {
  const result = new Date(date), day = result.getUTCDate();
  result.setUTCDate(1); result.setUTCMonth(result.getUTCMonth() - months);
  const last = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, last)); return result;
}
const tableExists = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
function held(db, userId, stamp) {
  return tableExists(db, "customer_erasure_holds") && Boolean(db.prepare("SELECT 1 FROM customer_erasure_holds WHERE user_id=? AND released_at IS NULL AND (expires_at IS NULL OR expires_at>?) LIMIT 1").get(userId, stamp));
}
function unresolvedOrder(db, orderId) {
  return Boolean(db.prepare("SELECT 1 FROM support_cases WHERE order_id=? AND status='open' LIMIT 1").get(orderId))
    || Boolean(db.prepare("SELECT 1 FROM refund_cases WHERE order_id=? AND resolved_at IS NULL AND status NOT IN ('rejected','refunded') LIMIT 1").get(orderId))
    || Boolean(db.prepare("SELECT 1 FROM marketplace_operations WHERE order_id=? AND status IN ('pending','delayed','held') LIMIT 1").get(orderId))
    || Boolean(db.prepare("SELECT 1 FROM stripe_order_payments WHERE order_id=? AND status IN ('pending','authorized','unknown') LIMIT 1").get(orderId))
    || Boolean(db.prepare("SELECT 1 FROM device_print_jobs WHERE order_id=? AND status IN ('queued','claimed','uncertain') LIMIT 1").get(orderId))
    || Boolean(db.prepare("SELECT 1 FROM customer_transactional_email_outbox WHERE order_id=? AND status IN ('claimed','unknown') LIMIT 1").get(orderId));
}
function minimizePrintCopies(db, orderId, removeHealth, removeContacts) {
  let count = 0;
  for (const job of db.prepare("SELECT id,receipt FROM device_print_jobs WHERE order_id=? AND status IN ('printed','failed')").all(orderId)) {
    const receipt = JSON.parse(job.receipt);
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || receipt.format !== "cal-eats-receipt-v1") throw new Error("A print snapshot requires review before privacy minimization");
    if (removeHealth) delete receipt.allergyNotes;
    if (removeContacts) { receipt.customerName = ""; delete receipt.customerPhone; delete receipt.deliveryAddress; delete receipt.orderNotes; }
    const minimized = JSON.stringify(receipt);
    if (minimized !== job.receipt) count += db.prepare("UPDATE device_print_jobs SET receipt=? WHERE id=?").run(minimized, job.id).changes;
  }
  return count;
}
function batch(db, scope, query, ...args) {
  const cursor = db.prepare("SELECT after_id FROM privacy_retention_cursors WHERE scope=?").get(scope)?.after_id ?? "";
  let rows = db.prepare(query).all(...args, cursor);
  if (!rows.length && cursor) rows = db.prepare(query).all(...args, "");
  db.prepare("UPDATE privacy_retention_cursors SET after_id=? WHERE scope=?").run(rows.at(-1)?.id ?? "", scope);
  return rows;
}

// Bounded, transactional minimization of terminal-order operational copies and
// old resolved support bodies. Accounting amounts, ledger rows, snapshots and
// customer/restaurant IDs are deliberately never modified or deleted here.
export function runCustomerPrivacyRetention(db, config) {
  const policy = config.customerPrivacy;
  if (!policy?.enabled) return { enabled: false, allergyNotes: 0, orderContacts: 0, printCopies: 0, supportCases: 0, supportMessages: 0, supportNotifications: 0, supportEmails: 0 };
  const clock = config.now(), stamp = clock.toISOString();
  if (policy.approvedAt > stamp) return { enabled: false, reason: "approval_not_effective" };
  const allergyCutoff = new Date(clock.getTime() - policy.retention.allergyDays * 86400000).toISOString();
  const contactCutoff = new Date(clock.getTime() - policy.retention.orderContactDays * 86400000).toISOString();
  const supportCutoff = subtractCalendarMonths(clock, policy.retention.resolvedSupportMonths).toISOString();
  return withTransaction(db, () => {
    const counts = { enabled: true, allergyNotes: 0, orderContacts: 0, printCopies: 0, supportCases: 0, supportMessages: 0, supportNotifications: 0, supportEmails: 0 };
    const rows = batch(db, "orders", `SELECT o.*,COALESCE((SELECT MAX(e.created_at) FROM order_events e WHERE e.order_id=o.id AND e.to_status IN ('completed','rejected')),o.updated_at) AS terminal_at FROM orders o WHERE o.status IN ('completed','rejected') AND (o.allergy_notes<>'' OR o.customer_name<>'' OR o.customer_email<>'' OR o.customer_phone<>'' OR o.delivery_instructions<>'' OR o.delivery_address IS NOT NULL OR EXISTS(SELECT 1 FROM device_print_jobs p WHERE p.order_id=o.id AND (p.receipt LIKE '%"allergyNotes":%' OR p.receipt LIKE '%"customerPhone":%' OR p.receipt LIKE '%"deliveryAddress":%' OR p.receipt LIKE '%"orderNotes":%'))) AND o.id>? ORDER BY o.id LIMIT 500`);
    for (const row of rows) {
      if (held(db, row.customer_id, stamp) || unresolvedOrder(db, row.id)) continue;
      if (row.terminal_at <= allergyCutoff && row.allergy_notes) counts.allergyNotes += db.prepare("UPDATE orders SET allergy_notes='' WHERE id=? AND allergy_notes<>''").run(row.id).changes;
      if (row.terminal_at <= contactCutoff && (row.customer_name || row.customer_email || row.customer_phone || row.delivery_instructions || row.delivery_address)) counts.orderContacts += db.prepare("UPDATE orders SET customer_name='',customer_email='',customer_phone='',delivery_instructions='',delivery_address=NULL WHERE id=?").run(row.id).changes;
      if (row.terminal_at <= allergyCutoff || row.terminal_at <= contactCutoff) counts.printCopies += minimizePrintCopies(db, row.id, row.terminal_at <= allergyCutoff, row.terminal_at <= contactCutoff);
    }
    const cases = batch(db, "support", "SELECT id,user_id FROM support_cases WHERE status='resolved' AND updated_at<=? AND (message<>'' OR subject NOT IN ('Support record retained','Account data removed') OR EXISTS(SELECT 1 FROM support_case_messages m WHERE m.case_id=support_cases.id)) AND id>? ORDER BY id LIMIT 500", supportCutoff);
    for (const item of cases) {
      if (held(db, item.user_id, stamp)) continue;
      if (db.prepare("SELECT 1 FROM customer_transactional_email_outbox WHERE support_case_id=? AND status IN ('claimed','unknown') LIMIT 1").get(item.id)) continue;
      counts.supportMessages += db.prepare("DELETE FROM support_case_messages WHERE case_id=?").run(item.id).changes;
      counts.supportEmails += db.prepare("UPDATE customer_transactional_email_outbox SET recipient='',payload='{}',source_message_id=NULL,last_error=NULL,status=CASE WHEN status IN ('pending','failed') THEN 'cancelled' ELSE status END WHERE support_case_id=? AND (recipient<>'' OR payload<>'{}')").run(item.id).changes;
      counts.supportNotifications += db.prepare("UPDATE user_notifications SET title='Support case update',message='This support record has reached its content retention period.' WHERE support_case_id=? AND (title<>'Support case update' OR message<>'This support record has reached its content retention period.')").run(item.id).changes;
      counts.supportCases += db.prepare("UPDATE support_cases SET subject='Support record retained',message='',idempotency_key='retained:'||id,request_hash='retained' WHERE id=?").run(item.id).changes;
    }
    if (Object.entries(counts).some(([key, value]) => key !== "enabled" && value > 0)) db.prepare("INSERT INTO privacy_retention_runs VALUES(?,?,?,?,?)").run(randomUUID(), policy.version, stamp, stamp, JSON.stringify(counts));
    return counts;
  });
}
