import { createHash, randomUUID } from "node:crypto";
import { calculateCommissionAtRate, VALIDATION } from "../../../packages/contracts/src/index.js";
import { requireRole, requireRestaurantOwner, requireUser } from "./auth/authorization.js";
import { withTransaction } from "./db/index.js";
import { HttpError, exactObject, readJson, sendJson } from "./http.js";
import { authorizedOrder, ledgerDto, orderDto } from "./journey.js";
import { notifyOrderStatus, releaseOfferForOrder } from "./offers.js";

const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const fingerprint = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const safeText = (value, min, max, label) => { const result = typeof value === "string" ? value.trim() : ""; if (result.length < min || result.length > max) throw new HttpError(400, "VALIDATION_ERROR", `${label} is invalid`); return result; };
const safeMoney = (value, allowZero, label) => { if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > VALIDATION.priceMaxMinor) throw new HttpError(400, "VALIDATION_ERROR", `${label} is invalid`); return value; };
const contractDto = (row) => ({ id: row.id, restaurantId: row.restaurant_id, rateBasisPoints: row.rate_bps, durationMonths: row.duration_months, policyVersion: row.policy_version, demoOnly: Boolean(row.demo_only), acceptedAt: row.accepted_at, acceptedByUserId: row.accepted_by_user_id, createdAt: row.created_at });
const refundDto = (row) => ({ id: row.id, orderId: row.order_id, foodAmountMinor: row.food_amount_minor, deliveryAmountMinor: row.delivery_amount_minor, totalMinor: row.food_amount_minor + row.delivery_amount_minor, reason: row.reason, mode: row.mode, commissionReversalMinor: row.commission_reversal_minor, createdAt: row.created_at });
const settlementDto = (row) => ({ id: row.id, restaurantId: row.restaurant_id, amountMinor: row.amount_minor, reference: row.reference, createdAt: row.created_at });
const printJobDto = (row) => ({ id: row.id, orderId: row.order_id, status: row.status, receiptUrl: `/api/orders/${row.order_id}/receipt?printJobId=${encodeURIComponent(row.id)}`, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at });

function statement(db, restaurantId) {
  const entries = db.prepare("SELECT * FROM ledger_entries WHERE restaurant_id=? ORDER BY created_at,rowid").all(restaurantId).map(ledgerDto);
  const sum = (...kinds) => entries.filter((entry) => kinds.includes(entry.kind)).reduce((total, entry) => total + entry.amountMinor, 0);
  const commissionMockMinor = sum("commission_mock", "commission_mock_refund");
  const cashReceivableMinor = sum("commission_cash_receivable", "commission_cash_refund");
  const cashSettledMinor = sum("cash_settlement");
  return { restaurantId, commissionMockMinor, cashReceivableMinor, cashSettledMinor, cashOutstandingMinor: cashReceivableMinor - cashSettledMinor, entries };
}

function audit(db, actorId, entityType, entityId, action, details, now) {
  db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(), actorId, entityType, entityId, action, JSON.stringify(details), now);
}
function outbox(db, eventType, entityId, payload, now) {
  db.prepare("INSERT OR IGNORE INTO notification_outbox VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), eventType, entityId, JSON.stringify(payload), "pending", 0, null, now, now);
}

export async function routeOperations({ req, res, url, db, config, session }) {
  if (req.method === "GET" && url.pathname === "/api/admin/contracts") {
    requireRole(session, "admin");
    return sendJson(res, 200, { data: db.prepare("SELECT * FROM contracts ORDER BY created_at").all().map(contractDto) });
  }
  let match = url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/contract$/);
  if (match && req.method === "GET") {
    requireRestaurantOwner(db, session, match[1]);
    const row = db.prepare("SELECT * FROM contracts WHERE restaurant_id=?").get(match[1]);
    if (!row) throw new HttpError(404, "NOT_FOUND", "Resource not found");
    return sendJson(res, 200, { data: contractDto(row) });
  }
  match = url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/contract\/accept$/);
  if (match && req.method === "POST") {
    const user = requireRestaurantOwner(db, session, match[1]);
    const body = await readJson(req, config.bodyLimit); exactObject(body, []);
    const now = config.now().toISOString();
    withTransaction(db, () => {
      const row = db.prepare("SELECT * FROM contracts WHERE restaurant_id=?").get(match[1]);
      if (!row) throw new HttpError(404, "NOT_FOUND", "Resource not found");
      if (!row.accepted_at) {
        db.prepare("UPDATE contracts SET accepted_at=?,accepted_by_user_id=? WHERE id=?").run(now, user.id, row.id);
        audit(db, user.id, "contract", row.id, "demo_contract_accepted", { policyVersion: row.policy_version, demoOnly: true }, now);
      }
    });
    return sendJson(res, 200, { data: contractDto(db.prepare("SELECT * FROM contracts WHERE restaurant_id=?").get(match[1])) });
  }
  match = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/refunds$/);
  if (match && req.method === "POST") return createRefund({ req, res, db, config, session, orderId: match[1] });
  match = url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/statement$/);
  if (match && req.method === "GET") {
    requireRestaurantOwner(db, session, match[1]);
    return sendJson(res, 200, { data: statement(db, match[1]) });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/statements") {
    requireRole(session, "admin");
    return sendJson(res, 200, { data: db.prepare("SELECT id FROM restaurants ORDER BY created_at").all().map(({ id }) => statement(db, id)) });
  }
  match = url.pathname.match(/^\/api\/admin\/restaurants\/([^/]+)\/cash-settlements$/);
  if (match && req.method === "POST") return createSettlement({ req, res, db, config, session, restaurantId: match[1] });
  if (req.method === "GET" && url.pathname === "/api/admin/audit") {
    requireRole(session, "admin");
    return sendJson(res, 200, { data: db.prepare("SELECT * FROM audit_events ORDER BY created_at DESC,rowid DESC").all().map((row) => ({ id: row.id, actorUserId: row.actor_user_id, entityType: row.entity_type, entityId: row.entity_id, action: row.action, details: JSON.parse(row.details), createdAt: row.created_at })) });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/jobs") {
    requireRole(session, "admin");
    const jobs = db.prepare("SELECT * FROM operational_jobs ORDER BY created_at DESC,rowid DESC").all().map((row) => ({ id: row.id, kind: row.kind, entityId: row.entity_id, status: row.status, attempts: row.attempts, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at }));
    const outboxRows = db.prepare("SELECT * FROM notification_outbox ORDER BY created_at DESC,rowid DESC").all().map((row) => ({ id: row.id, kind: "notification_outbox", entityId: row.entity_id, eventType: row.event_type, status: row.status, attempts: row.attempts, error: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at }));
    const printRows = db.prepare("SELECT * FROM print_jobs ORDER BY created_at DESC,rowid DESC").all().map((row) => ({ id: row.id, kind: "print_job", entityId: row.order_id, status: row.status, attempts: 1, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at }));
    return sendJson(res, 200, { data: [...jobs, ...outboxRows, ...printRows] });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/integrations") {
    requireRole(session, "admin");
    return sendJson(res, 200, { data: db.prepare("SELECT * FROM integration_status ORDER BY name").all().map((row) => ({ id: row.id, name: row.name, mode: row.mode, enabled: Boolean(row.enabled), detail: row.detail, updatedAt: row.updated_at })) });
  }
  match = url.pathname.match(/^\/api\/orders\/([^/]+)\/print-jobs$/);
  if (match && req.method === "POST") {
    const access = authorizedOrder(db, session, match[1]);
    const body = await readJson(req, config.bodyLimit); exactObject(body, []);
    const now = config.now().toISOString(); const id = randomUUID();
    db.prepare("INSERT INTO print_jobs VALUES(?,?,?,?,?,?,?)").run(id, access.row.id, access.user.id, "requested", null, now, now);
    return sendJson(res, 201, { data: printJobDto(db.prepare("SELECT * FROM print_jobs WHERE id=?").get(id)) });
  }
  match = url.pathname.match(/^\/api\/print-jobs\/([^/]+)$/);
  if (match && req.method === "PATCH") {
    const user = requireUser(session);
    const body = await readJson(req, config.bodyLimit); exactObject(body, ["status", "error"]);
    if (!["browser_opened", "failed"].includes(body.status) || (body.status === "failed" && typeof body.error !== "string")) throw new HttpError(400, "VALIDATION_ERROR", "Print job status is invalid");
    const row = db.prepare("SELECT * FROM print_jobs WHERE id=?").get(match[1]);
    if (!row) throw new HttpError(404, "NOT_FOUND", "Resource not found");
    authorizedOrder(db, session, row.order_id);
    const error = body.status === "failed" ? safeText(body.error, 1, 300, "Print error") : null;
    db.prepare("UPDATE print_jobs SET status=?,error=?,updated_at=? WHERE id=?").run(body.status, error, config.now().toISOString(), row.id);
    return sendJson(res, 200, { data: printJobDto(db.prepare("SELECT * FROM print_jobs WHERE id=?").get(row.id)) });
  }
  if (req.method === "GET" && ["/api/admin/reports/orders.csv", "/api/admin/reports/ledger.csv"].includes(url.pathname)) {
    requireRole(session, "admin");
    return sendCsv(res, url.pathname.endsWith("orders.csv") ? orderCsv(db) : ledgerCsv(db));
  }
  return false;
}

async function createRefund({ req, res, db, config, session, orderId }) {
  const user = requireRole(session, "admin");
  const key = safeText(req.headers["idempotency-key"], 1, VALIDATION.idempotencyKeyMax, "Idempotency-Key");
  const body = await readJson(req, config.bodyLimit); exactObject(body, ["foodAmountMinor", "deliveryAmountMinor", "reason"]);
  const normalized = { foodAmountMinor: safeMoney(body.foodAmountMinor, true, "Food refund"), deliveryAmountMinor: safeMoney(body.deliveryAmountMinor, true, "Delivery refund"), reason: safeText(body.reason, 1, 300, "Refund reason") };
  if (normalized.foodAmountMinor + normalized.deliveryAmountMinor === 0) throw new HttpError(400, "VALIDATION_ERROR", "Refund amount must be positive");
  const hash = fingerprint({ orderId, ...normalized });
  const prior = db.prepare("SELECT * FROM refunds WHERE actor_user_id=? AND idempotency_key=?").get(user.id, key);
  if (prior) {
    if (prior.request_hash !== hash) throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used for another request");
    const order = db.prepare("SELECT * FROM orders WHERE id=?").get(prior.order_id);
    return sendJson(res, 200, { data: { refund: refundDto(prior), order: orderDto(db, order, true) } });
  }
  const result = withTransaction(db, () => {
    const order = db.prepare("SELECT * FROM orders WHERE id=?").get(orderId);
    if (!order) throw new HttpError(404, "NOT_FOUND", "Resource not found");
    const allowed = order.payment_method === "mock_card" ? ["mock_captured", "mock_partially_refunded"] : ["cash_collected", "cash_partially_refunded"];
    if (!allowed.includes(order.payment_status)) throw new HttpError(409, "REFUND_NOT_ALLOWED", "Payment is not eligible for refund");
    const sums = db.prepare("SELECT COALESCE(SUM(food_amount_minor),0) AS food,COALESCE(SUM(delivery_amount_minor),0) AS delivery FROM refunds WHERE order_id=?").get(order.id);
    if (sums.food + normalized.foodAmountMinor > order.subtotal_minor || sums.delivery + normalized.deliveryAmountMinor > order.delivery_fee_minor) throw new HttpError(409, "REFUND_EXCEEDS_PAYMENT", "Refund exceeds remaining amount");
    const reversal = calculateCommissionAtRate(order.subtotal_minor - sums.food, order.contract_rate_bps) - calculateCommissionAtRate(order.subtotal_minor - sums.food - normalized.foodAmountMinor, order.contract_rate_bps);
    const now = config.now().toISOString(); const id = randomUUID();
    const mode = order.payment_method === "mock_card" ? "simulated_card" : "manual_cash_return";
    db.prepare("INSERT INTO refunds VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id, order.id, user.id, key, hash, normalized.foodAmountMinor, normalized.deliveryAmountMinor, normalized.reason, mode, reversal, now);
    if (reversal) {
      const kind = order.payment_method === "mock_card" ? "commission_mock_refund" : "commission_cash_refund";
      db.prepare("INSERT INTO ledger_entries VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), order.id, order.restaurant_id, kind, -reversal, order.currency, "refund", id, now);
    }
    const full = sums.food + normalized.foodAmountMinor === order.subtotal_minor && sums.delivery + normalized.deliveryAmountMinor === order.delivery_fee_minor;
    const paymentStatus = order.payment_method === "mock_card" ? (full ? "mock_refunded" : "mock_partially_refunded") : (full ? "cash_refunded" : "cash_partially_refunded");
    db.prepare("UPDATE orders SET payment_status=?,updated_at=? WHERE id=?").run(paymentStatus, now, order.id);
    if (full && order.status !== "completed") releaseOfferForOrder(db, order, now);
    notifyOrderStatus(db, order, "refunded", now, "order_refund", `:${id}`);
    audit(db, user.id, "order", order.id, "demo_refund_recorded", { refundId: id, mode, ...normalized }, now);
    outbox(db, "order_refunded", id, { orderId: order.id, refundId: id }, now);
    return db.prepare("SELECT * FROM refunds WHERE id=?").get(id);
  });
  return sendJson(res, 201, { data: { refund: refundDto(result), order: orderDto(db, db.prepare("SELECT * FROM orders WHERE id=?").get(orderId), true) } });
}

async function createSettlement({ req, res, db, config, session, restaurantId }) {
  const user = requireRole(session, "admin");
  const key = safeText(req.headers["idempotency-key"], 1, VALIDATION.idempotencyKeyMax, "Idempotency-Key");
  const body = await readJson(req, config.bodyLimit); exactObject(body, ["amountMinor", "reference"]);
  const normalized = { amountMinor: safeMoney(body.amountMinor, false, "Settlement amount"), reference: safeText(body.reference, 1, 120, "Settlement reference") };
  const hash = fingerprint({ restaurantId, ...normalized });
  const prior = db.prepare("SELECT * FROM cash_settlements WHERE actor_user_id=? AND idempotency_key=?").get(user.id, key);
  if (prior) {
    if (prior.request_hash !== hash) throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used for another request");
    return sendJson(res, 200, { data: { settlement: settlementDto(prior), statement: statement(db, restaurantId) } });
  }
  const created = withTransaction(db, () => {
    if (!db.prepare("SELECT 1 FROM restaurants WHERE id=?").get(restaurantId)) throw new HttpError(404, "NOT_FOUND", "Resource not found");
    const current = statement(db, restaurantId);
    if (current.cashOutstandingMinor <= 0 || normalized.amountMinor > current.cashOutstandingMinor) throw new HttpError(409, "SETTLEMENT_EXCEEDS_OUTSTANDING", "Settlement exceeds cash commission outstanding");
    const now = config.now().toISOString(); const id = randomUUID();
    db.prepare("INSERT INTO cash_settlements VALUES(?,?,?,?,?,?,?,?)").run(id, restaurantId, user.id, key, hash, normalized.amountMinor, normalized.reference, now);
    db.prepare("INSERT INTO ledger_entries VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), null, restaurantId, "cash_settlement", normalized.amountMinor, "GBP", "cash_settlement", id, now);
    audit(db, user.id, "restaurant", restaurantId, "manual_cash_settlement_recorded", { settlementId: id, ...normalized }, now);
    return db.prepare("SELECT * FROM cash_settlements WHERE id=?").get(id);
  });
  return sendJson(res, 201, { data: { settlement: settlementDto(created), statement: statement(db, restaurantId) } });
}

export function runExpiryWorker(db, config) {
  const nowDate = config.now(); const now = nowDate.toISOString(); const cutoff = new Date(nowDate.getTime() - config.orderExpiryMinutes * 60_000).toISOString();
  return withTransaction(db, () => {
    const rows = db.prepare("SELECT * FROM orders WHERE status='placed' AND created_at<=? ORDER BY created_at").all(cutoff);
    for (const order of rows) {
      const payment = order.payment_method === "mock_card" ? "mock_cancelled" : "cash_cancelled";
      db.prepare("UPDATE orders SET status='rejected',payment_status=?,updated_at=? WHERE id=? AND status='placed'").run(payment, now, order.id);
      db.prepare("INSERT INTO order_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(), order.id, null, "expired", "placed", "rejected", now);
      releaseOfferForOrder(db, order, now);
      notifyOrderStatus(db, order, "rejected", now, "order_expired");
      outbox(db, "order_expired", order.id, { orderId: order.id }, now);
      db.prepare("INSERT OR IGNORE INTO operational_jobs VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(), "order_expiry", order.id, "completed", 1, null, now, now);
    }
    return rows.length;
  });
}

export function processLocalOutbox(db, config, sink = () => undefined) {
  const now = config.now().toISOString();
  return withTransaction(db, () => {
    const rows = db.prepare("SELECT * FROM notification_outbox WHERE status IN ('pending','failed') AND attempts<3 ORDER BY created_at").all();
    for (const row of rows) {
      try {
        const result = sink({ eventType: row.event_type, entityId: row.entity_id, payload: JSON.parse(row.payload) });
        if (result && typeof result.then === "function") throw new Error("Local outbox sink must be synchronous");
        db.prepare("INSERT OR IGNORE INTO local_notifications VALUES(?,?,?,?,?,?)").run(randomUUID(), row.id, row.event_type, row.entity_id, row.payload, now);
        db.prepare("UPDATE notification_outbox SET status='delivered',attempts=attempts+1,last_error=NULL,updated_at=? WHERE id=?").run(now, row.id);
      } catch {
        db.prepare("UPDATE notification_outbox SET status='failed',attempts=attempts+1,last_error='Local sink failed',updated_at=? WHERE id=?").run(now, row.id);
      }
    }
    return rows.length;
  });
}

export function runOperationsCycle(db, config, runners = {}) {
  const results = { expired: 0, delivered: 0, errors: [] };
  for (const [kind, key, fallback] of [["order_expiry", "expiry", runExpiryWorker], ["notification_outbox", "outbox", processLocalOutbox]]) {
    try { results[key === "expiry" ? "expired" : "delivered"] = (runners[key] ?? fallback)(db, config); }
    catch {
      results.errors.push(kind);
      try {
        const now = config.now().toISOString();
        db.prepare("INSERT INTO operational_jobs VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(), `${kind}_worker`, randomUUID(), "failed", 1, "Local worker failed", now, now);
      } catch { /* readiness will expose a database failure; interval remains alive */ }
    }
  }
  return results;
}

const csvCell = (value) => { let text = String(value ?? ""); if (/^[=+\-@]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
const csv = (headers, rows) => [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
function orderCsv(db) { return csv(["id", "restaurantId", "status", "subtotalMinor", "deliveryFeeMinor", "totalMinor", "refundedTotalMinor", "paymentMethod", "paymentStatus", "createdAt"], db.prepare("SELECT * FROM orders ORDER BY created_at").all().map((row) => { const sums = db.prepare("SELECT COALESCE(SUM(food_amount_minor+delivery_amount_minor),0) AS total FROM refunds WHERE order_id=?").get(row.id); return [row.id, row.restaurant_id, row.status, row.subtotal_minor, row.delivery_fee_minor, row.total_minor, sums.total, row.payment_method, row.payment_status, row.created_at]; })); }
function ledgerCsv(db) { return csv(["id", "orderId", "restaurantId", "kind", "amountMinor", "currency", "referenceType", "referenceId", "createdAt"], db.prepare("SELECT * FROM ledger_entries ORDER BY created_at").all().map((row) => [row.id, row.order_id, row.restaurant_id, row.kind, row.amount_minor, row.currency, row.reference_type, row.reference_id, row.created_at])); }
function sendCsv(res, body) { res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment", "Content-Length": Buffer.byteLength(body) }); res.end(body); }
