import { createHash, randomUUID } from "node:crypto";
import { HttpError, sendJson } from "../http.js";
import { withTransaction } from "../db/index.js";
import { parseStripeWebhook, StripeTestConfigurationError } from "./stripe-test.js";

export const PROVIDER_EVENT_WEBHOOK_PATH = "/api/provider-events/stripe-test";
const PROVIDER = "stripe_test";
const DEFAULT_BODY_LIMIT = 256 * 1024;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_LEASE_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const REFERENCE = /^(acct|pi|ch|tr|re|po|seti|mandate)_[A-Za-z0-9_]+$/;

export async function routeProviderEventWebhook({ req, res, url, db, config }) {
  if (url.pathname !== PROVIDER_EVENT_WEBHOOK_PATH) return false;
  if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
  if (config.paymentProviderMode !== PROVIDER || !config.paymentProvider) throw new HttpError(404, "PROVIDER_WEBHOOK_DISABLED", "Test provider webhook is disabled");
  if (typeof config.paymentProviderWebhookSecret !== "string" || !config.paymentProviderWebhookSecret.startsWith("whsec_")) throw new HttpError(503, "PROVIDER_WEBHOOK_NOT_CONFIGURED", "Test provider webhook is not configured");
  if (req.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");

  const rawBody = await readRawBody(req, boundedInteger(config.providerWebhookBodyLimit ?? DEFAULT_BODY_LIMIT, 1024, 1024 * 1024, "providerWebhookBodyLimit"));
  const now = currentDate(config);
  let event;
  try {
    event = parseStripeWebhook({
      rawBody,
      signatureHeader: req.headers["stripe-signature"],
      secret: config.paymentProviderWebhookSecret,
      nowSeconds: Math.floor(now.getTime() / 1000),
      toleranceSeconds: 300
    });
  } catch (error) {
    if (error instanceof StripeTestConfigurationError && /Live Stripe/.test(error.message)) throw new HttpError(400, "LIVE_PROVIDER_EVENT_REJECTED", "Live provider events are rejected");
    if (/signature/i.test(String(error?.message))) throw new HttpError(400, "INVALID_PROVIDER_SIGNATURE", "Provider signature is missing, invalid, or stale");
    throw new HttpError(400, "INVALID_PROVIDER_EVENT", "Provider event is malformed");
  }

  let normalized;
  try { normalized = normalizeEvent(event); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "INVALID_PROVIDER_EVENT", "Provider event is malformed");
  }
  const fingerprint = createHash("sha256").update(rawBody).digest("hex");
  const accepted = withTransaction(db, () => persistEvent(db, normalized, fingerprint, now.toISOString()));
  sendJson(res, 200, { data: { received: true, eventId: normalized.eventId, status: accepted.status, replayed: accepted.replayed } });
  return true;
}

export async function runProviderEventReconciliation(db, config, options = {}) {
  const limit = boundedInteger(options.limit ?? 25, 1, 100, "limit");
  const maxAttempts = boundedInteger(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 1, 10, "maxAttempts");
  const leaseMs = boundedInteger(options.leaseMs ?? DEFAULT_LEASE_MS, 1000, 5 * 60_000, "leaseMs");
  const baseBackoffMs = boundedInteger(options.baseBackoffMs ?? 1000, 1, 60_000, "baseBackoffMs");
  const workerId = boundedText(options.workerId ?? randomUUID(), 1, 100, "workerId");
  const summary = { claimed: 0, completed: 0, delayed: 0, failed: 0, unmatched: 0, ignored: 0 };
  if (config.paymentProviderMode !== PROVIDER || !config.paymentProvider) return { ...summary, skipped: "provider_disabled" };

  for (let count = 0; count < limit; count += 1) {
    const now = currentDate(config);
    const event = withTransaction(db, () => claimNext(db, workerId, now, leaseMs, maxAttempts));
    if (!event) break;
    summary.claimed += 1;
    if (event.terminalExpired) { summary.failed += 1; continue; }

    const normalized = safeJson(event.normalized_payload, null);
    if (!normalized) {
      finalizeFailure(db, event, workerId, now, "MALFORMED_NORMALIZED_EVENT");
      summary.failed += 1;
      continue;
    }
    const mapping = resolveMapping(db, normalized);
    if (mapping.state === "conflict") {
      finalizeFailure(db, event, workerId, now, "TENANT_MAPPING_CONFLICT");
      summary.failed += 1;
      continue;
    }
    if (mapping.state === "unmatched") {
      const terminal = event.attempts >= maxAttempts;
      finalizeRetry(db, event, workerId, now, terminal, "PROVIDER_OBJECT_UNMATCHED", baseBackoffMs);
      summary[terminal ? "unmatched" : "delayed"] += 1;
      continue;
    }
    const chronology = appliedChronology(db, event, mapping.restaurantId);
    if (chronology === "conflict") {
      finalizeFailure(db, event, workerId, now, "PROVIDER_OBJECT_TENANT_CONFLICT");
      summary.failed += 1;
      continue;
    }
    if (chronology === "stale") {
      finalizeCompleted(db, event, workerId, now, "STALE_EVENT_IGNORED");
      summary.ignored += 1;
      continue;
    }

    let result;
    try {
      result = await retrieveCurrentProviderState(config.paymentProvider, normalized, mapping);
    } catch (error) {
      const permanent = error instanceof StripeTestConfigurationError || error instanceof TypeError;
      finalizeRetry(db, event, workerId, currentDate(config), permanent || event.attempts >= maxAttempts, permanent ? "PROVIDER_CONFIGURATION_REJECTED" : "PROVIDER_RETRIEVAL_FAILED", baseBackoffMs);
      summary[permanent || event.attempts >= maxAttempts ? "failed" : "delayed"] += 1;
      continue;
    }

    const finishedAt = currentDate(config);
    if (!result || result.status === "unknown" || (result.ok === false && result.status !== "failed")) {
      const terminal = event.attempts >= maxAttempts;
      finalizeRetry(db, event, workerId, finishedAt, terminal, safeCode(result?.errorCode, "PROVIDER_STATE_UNKNOWN"), baseBackoffMs);
      summary[terminal ? "failed" : "delayed"] += 1;
      continue;
    }

    const outcome = withTransaction(db, () => finalizeReconciliation(db, event, workerId, normalized, mapping, result, finishedAt.toISOString()));
    summary[outcome] += 1;
  }
  return summary;
}

function persistEvent(db, event, fingerprint, now) {
  const existing = db.prepare("SELECT payload_fingerprint,status FROM provider_events WHERE provider=? AND provider_event_id=?").get(PROVIDER, event.eventId);
  if (existing) {
    if (existing.payload_fingerprint !== fingerprint) throw new HttpError(409, "PROVIDER_EVENT_CONFLICT", "Provider event ID was reused with a different payload");
    return { status: existing.status, replayed: true };
  }
  const mapping = event.kind === "unsupported" ? { state: "ignored" } : resolveMapping(db, event);
  const status = mapping.state === "ignored" ? "ignored" : mapping.state === "conflict" ? "failed" : mapping.state === "mapped" ? "queued" : "delayed";
  const error = mapping.state === "ignored" ? "UNSUPPORTED_EVENT_TYPE" : mapping.state === "conflict" ? "TENANT_MAPPING_CONFLICT" : mapping.state === "unmatched" ? "PROVIDER_OBJECT_UNMATCHED" : null;
  db.prepare(`INSERT INTO provider_events(
    id,provider,provider_event_id,event_type,object_type,object_id,provider_account_reference,restaurant_id,
    payload_fingerprint,normalized_payload,provider_created_at,status,attempts,available_at,lease_owner,lease_expires_at,error,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?,NULL,NULL,?,?,?)`).run(
    randomUUID(), PROVIDER, event.eventId, event.eventType, event.objectType, event.objectId, event.providerAccountReference,
    mapping.restaurantId ?? null, fingerprint, JSON.stringify(event), event.providerCreatedAt, status, now, error, now, now
  );
  return { status, replayed: false };
}

function claimNext(db, workerId, nowDate, leaseMs, maxAttempts) {
  const now = nowDate.toISOString();
  const row = db.prepare(`SELECT * FROM provider_events
    WHERE (((status IN ('queued','delayed')) AND available_at<=? AND attempts<?) OR (status='claimed' AND lease_expires_at<=?))
      ORDER BY available_at,created_at LIMIT 1`).get(now, maxAttempts, now);
  if (!row) return null;
  if (row.status === "claimed" && row.attempts >= maxAttempts) {
    db.prepare("UPDATE provider_events SET status='failed',error='LEASE_EXPIRED_AFTER_MAX_ATTEMPTS',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='claimed' AND lease_expires_at<=?")
      .run(now, row.id, now);
    return { ...row, terminalExpired: true };
  }
  const lease = new Date(nowDate.getTime() + leaseMs).toISOString();
  const changed = db.prepare(`UPDATE provider_events SET status='claimed',lease_owner=?,lease_expires_at=?,attempts=attempts+1,updated_at=?
    WHERE id=? AND (((status IN ('queued','delayed')) AND available_at<=? AND attempts<?) OR (status='claimed' AND lease_expires_at<=? AND attempts<?))`)
    .run(workerId, lease, now, row.id, now, maxAttempts, now, maxAttempts).changes;
  return changed ? db.prepare("SELECT * FROM provider_events WHERE id=?").get(row.id) : null;
}

function finalizeReconciliation(db, event, workerId, normalized, originalMapping, result, now) {
  const current = db.prepare("SELECT * FROM provider_events WHERE id=? AND status='claimed' AND lease_owner=?").get(event.id, workerId);
  if (!current) return "ignored";
  const mapping = resolveMapping(db, normalized);
  if (mapping.state !== "mapped" || mapping.restaurantId !== originalMapping.restaurantId) {
    db.prepare("UPDATE provider_events SET status='failed',error='TENANT_MAPPING_CHANGED',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?").run(now, event.id);
    return "failed";
  }
  const chronology = appliedChronology(db, current, mapping.restaurantId);
  if (chronology === "conflict") {
    db.prepare("UPDATE provider_events SET status='failed',error='PROVIDER_OBJECT_TENANT_CONFLICT',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?").run(now, event.id);
    return "failed";
  }
  if (chronology === "stale") {
    db.prepare("UPDATE provider_events SET status='completed',error='STALE_EVENT_IGNORED',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?").run(now, event.id);
    return "ignored";
  }
  const applied = applyProviderResult(db, normalized, mapping, result, now);
  if (!applied.ok) {
    db.prepare("UPDATE provider_events SET status='failed',error=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?").run(applied.error, now, event.id);
    return "failed";
  }
  const state = JSON.stringify(sanitizedResult(result));
  db.prepare(`INSERT INTO provider_event_object_state(provider,object_id,object_type,restaurant_id,last_event_created_at,last_event_id,last_result,updated_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(provider,object_id) DO UPDATE SET
      object_type=excluded.object_type,restaurant_id=excluded.restaurant_id,
      last_event_created_at=CASE WHEN excluded.last_event_created_at>=provider_event_object_state.last_event_created_at THEN excluded.last_event_created_at ELSE provider_event_object_state.last_event_created_at END,
      last_event_id=CASE WHEN excluded.last_event_created_at>=provider_event_object_state.last_event_created_at THEN excluded.last_event_id ELSE provider_event_object_state.last_event_id END,
      last_result=CASE WHEN excluded.last_event_created_at>=provider_event_object_state.last_event_created_at THEN excluded.last_result ELSE provider_event_object_state.last_result END,
      updated_at=excluded.updated_at`).run(PROVIDER, normalized.objectId, normalized.objectType, mapping.restaurantId, event.provider_created_at, event.provider_event_id, state, now);
  db.prepare("UPDATE provider_events SET status='completed',restaurant_id=?,error=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?").run(mapping.restaurantId, now, event.id);
  return "completed";
}

function applyProviderResult(db, event, mapping, result, now) {
  if (event.kind === "account") {
    const status = result.status === "confirmed" ? "enabled" : result.status === "failed" ? "restricted" : "pending";
    db.prepare("UPDATE provider_accounts SET status=?,capabilities=?,requirements=?,updated_at=? WHERE id=? AND provider_mode='stripe_test'")
      .run(status, JSON.stringify(arrayOfText(result.capabilities)), JSON.stringify(arrayOfText(result.requirements)), now, mapping.row.id);
    return { ok: true };
  }
  if (event.kind === "payment") {
    const metadata = safeJson(mapping.row.metadata, {});
    if (metadata.paymentState === "captured" && result.paymentState !== "captured") return { ok: true };
    const status = result.paymentState === "captured" ? "confirmed" : ["cancelled", "requires_payment_method"].includes(result.paymentState) || result.status === "failed" ? "failed" : "pending";
    const nextMetadata = { ...metadata, paymentState: safeCode(result.paymentState, result.status), reconciledFromProviderEvent: true };
    if (typeof result.latestChargeId === "string") nextMetadata.latestChargeId = result.latestChargeId;
    if (typeof result.availableOn === "string") nextMetadata.availableOn = result.availableOn;
    if (Number.isSafeInteger(result.providerCostMinor) && result.providerCostMinor >= 0) nextMetadata.providerCostMinorObserved = result.providerCostMinor;
    db.prepare("UPDATE marketplace_operations SET status=?,error=?,metadata=?,updated_at=? WHERE id=? AND provider_mode='stripe_test'")
      .run(status, status === "failed" ? safeCode(result.errorCode, "PROVIDER_PAYMENT_FAILED") : null, JSON.stringify(nextMetadata), now, mapping.row.id);
    return { ok: true };
  }
  if (event.kind === "transfer") {
    if (mapping.row.status === "confirmed" && result.status !== "confirmed") return { ok: true };
    const status = result.status === "confirmed" ? "confirmed" : result.status === "failed" ? "failed" : "delayed";
    db.prepare("UPDATE marketplace_operations SET status=?,error=?,updated_at=? WHERE id=? AND provider_mode='stripe_test'")
      .run(status, status === "failed" ? safeCode(result.errorCode, "PROVIDER_TRANSFER_FAILED") : null, now, mapping.row.id);
    return { ok: true };
  }
  if (event.kind === "payout") {
    if (Number.isSafeInteger(result.amountMinor) && result.amountMinor !== mapping.row.amount_minor) return { ok: false, error: "PAYOUT_AMOUNT_MISMATCH" };
    if (mapping.row.status === "paid" && result.paymentState !== "paid") return { ok: true };
    const status = result.paymentState === "paid" ? "paid" : ["failed", "canceled"].includes(result.paymentState) || result.status === "failed" ? "failed" : "in_transit";
    db.prepare("UPDATE payout_batches SET status=?,failure=?,updated_at=? WHERE id=? AND provider_mode='stripe_test'")
      .run(status, status === "failed" ? safeCode(result.errorCode, "PROVIDER_PAYOUT_FAILED") : null, now, mapping.row.id);
    return { ok: true };
  }
  if (event.kind === "setup" || event.kind === "mandate") {
    const status = result.status === "confirmed" ? "authorised" : result.status === "failed" ? "failed" : "created";
    const reference = typeof result.mandateId === "string" ? result.mandateId : mapping.row.provider_reference;
    db.prepare("UPDATE cash_mandates SET status=?,provider_reference=?,updated_at=? WHERE id=? AND provider_mode='stripe_test'")
      .run(status, reference, now, mapping.row.id);
    return { ok: true };
  }
  return { ok: false, error: "UNSUPPORTED_RECONCILIATION_KIND" };
}

function resolveMapping(db, event) {
  if (event.kind === "unsupported") return { state: "ignored" };
  let rows = [];
  if (event.kind === "account") rows = db.prepare("SELECT * FROM provider_accounts WHERE provider_mode='stripe_test' AND provider_reference=?").all(event.objectId);
  else if (["payment", "transfer"].includes(event.kind)) rows = db.prepare("SELECT * FROM marketplace_operations WHERE provider_mode='stripe_test' AND provider_reference=?").all(event.objectId);
  else if (event.kind === "payout") rows = db.prepare("SELECT * FROM payout_batches WHERE provider_mode='stripe_test' AND provider_reference=?").all(event.objectId);
  else if (["setup", "mandate"].includes(event.kind)) rows = db.prepare("SELECT * FROM cash_mandates WHERE provider_mode='stripe_test' AND provider_reference=?").all(event.objectId);
  if (!rows.length) return { state: "unmatched" };
  const tenants = new Set(rows.map((row) => row.restaurant_id));
  if (tenants.size !== 1 || rows.length !== 1) return { state: "conflict" };
  const restaurantId = rows[0].restaurant_id;
  if (event.kind === "account" && event.providerAccountReference && event.providerAccountReference !== event.objectId) return { state: "conflict" };
  let account = null;
  if (event.kind !== "account") account = db.prepare("SELECT * FROM provider_accounts WHERE restaurant_id=? AND provider_mode='stripe_test'").get(restaurantId);
  if (event.providerAccountReference && (!account || account.provider_reference !== event.providerAccountReference)) return { state: "conflict" };
  if (event.kind === "payout" && !account?.provider_reference) return { state: "unmatched" };
  return { state: "mapped", restaurantId, row: rows[0], providerAccount: account };
}

async function retrieveCurrentProviderState(adapter, event, mapping) {
  if (event.kind === "account") return adapter.refreshConnectedAccount({ accountId: event.objectId });
  if (event.kind === "payment") return adapter.retrievePayment({ paymentIntentId: event.objectId });
  if (event.kind === "transfer") return adapter.retrieveTransfer({ transferId: event.objectId });
  if (event.kind === "payout") return adapter.retrievePayout({ payoutId: event.objectId, accountId: mapping.providerAccount.provider_reference });
  if (event.kind === "setup") return adapter.retrieveSetupIntent({ setupIntentId: event.objectId });
  if (event.kind === "mandate") return adapter.retrieveMandate({ mandateId: event.objectId });
  throw new TypeError("Unsupported reconciliation kind");
}

function appliedChronology(db, event, restaurantId) {
  const state = db.prepare("SELECT * FROM provider_event_object_state WHERE provider=? AND object_id=?").get(PROVIDER, event.object_id);
  if (!state) return "current";
  if (state.restaurant_id !== restaurantId) return "conflict";
  return event.provider_created_at < state.last_event_created_at ? "stale" : "current";
}

function finalizeCompleted(db, event, workerId, nowDate, error) {
  db.prepare("UPDATE provider_events SET status='completed',error=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_owner=?")
    .run(error, nowDate.toISOString(), event.id, workerId);
}

function finalizeFailure(db, event, workerId, nowDate, error) {
  db.prepare("UPDATE provider_events SET status='failed',error=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_owner=?")
    .run(error, nowDate.toISOString(), event.id, workerId);
}

function finalizeRetry(db, event, workerId, nowDate, terminal, error, baseBackoffMs) {
  const now = nowDate.toISOString();
  const status = terminal ? (error === "PROVIDER_OBJECT_UNMATCHED" ? "unmatched" : "failed") : "delayed";
  const available = terminal ? now : new Date(nowDate.getTime() + retryDelay(event.provider_event_id, event.attempts, baseBackoffMs)).toISOString();
  db.prepare("UPDATE provider_events SET status=?,error=?,available_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_owner=?")
    .run(status, error, available, now, event.id, workerId);
}

function normalizeEvent(event) {
  const eventId = boundedText(event.id, 5, 255, "event.id");
  if (!/^evt_[A-Za-z0-9_]+$/.test(eventId)) throw new HttpError(400, "INVALID_PROVIDER_EVENT", "Provider event ID is invalid");
  const eventType = boundedText(event.type, 3, 160, "event.type");
  const object = event.data?.object;
  if (!object || typeof object !== "object" || Array.isArray(object)) throw new HttpError(400, "INVALID_PROVIDER_EVENT", "Provider event object is invalid");
  if (!Number.isSafeInteger(event.created) || event.created < 1) throw new HttpError(400, "INVALID_PROVIDER_EVENT", "Provider event time is invalid");
  const providerAccountReference = optionalReference(typeof event.account === "string" ? event.account : event.account?.id, "acct");
  const originalObjectId = optionalReference(object.id);
  let kind = "unsupported";
  let objectId = originalObjectId ?? "unsupported";
  if (eventType.startsWith("account.")) { kind = "account"; objectId = requiredReference(object.id, "acct"); }
  else if (eventType.startsWith("payment_intent.")) { kind = "payment"; objectId = requiredReference(object.id, "pi"); }
  else if (eventType.startsWith("charge.") || eventType.startsWith("refund.")) { kind = "payment"; objectId = requiredReference(typeof object.payment_intent === "string" ? object.payment_intent : object.payment_intent?.id, "pi"); }
  else if (eventType.startsWith("transfer.")) { kind = "transfer"; objectId = requiredReference(object.id, "tr"); }
  else if (eventType.startsWith("payout.")) { kind = "payout"; objectId = requiredReference(object.id, "po"); }
  else if (eventType.startsWith("setup_intent.")) { kind = "setup"; objectId = requiredReference(object.id, "seti"); }
  else if (eventType.startsWith("mandate.")) { kind = "mandate"; objectId = requiredReference(object.id, "mandate"); }
  const objectType = boundedText(String(object.object || kind), 1, 80, "object.type");
  return { eventId, eventType, objectType, objectId, providerAccountReference, providerCreatedAt: new Date(event.created * 1000).toISOString(), kind };
}

async function readRawBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) { req.resume(); throw new HttpError(413, "BODY_TOO_LARGE", "Request body is too large"); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function retryDelay(eventId, attempts, base) {
  const exponential = Math.min(MAX_BACKOFF_MS, base * (2 ** Math.max(0, attempts - 1)));
  const jitter = createHash("sha256").update(`${eventId}:${attempts}`).digest().readUInt16BE(0) / 65_535;
  return Math.min(MAX_BACKOFF_MS, Math.round(exponential * (0.75 + jitter * 0.5)));
}

function sanitizedResult(result) {
  const out = { ok: result.ok !== false, status: safeCode(result.status, "unknown") };
  for (const key of ["paymentState", "providerReference", "latestChargeId", "availableOn", "arrivalAt", "errorCode"]) if (typeof result[key] === "string") out[key] = result[key].slice(0, 255);
  for (const key of ["providerCostMinor", "amountMinor"]) if (Number.isSafeInteger(result[key])) out[key] = result[key];
  return out;
}

function arrayOfText(value) { return Array.isArray(value) ? value.filter((item) => typeof item === "string").slice(0, 100).map((item) => item.slice(0, 255)) : []; }
function safeJson(value, fallback) { try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback; } catch { return fallback; } }
function safeCode(value, fallback) { return typeof value === "string" && /^[A-Za-z0-9_:-]{1,100}$/.test(value) ? value : fallback; }
function requiredReference(value, prefix) { const ref = optionalReference(value, prefix); if (!ref) throw new HttpError(400, "INVALID_PROVIDER_EVENT", "Provider object reference is invalid"); return ref; }
function optionalReference(value, prefix) { if (value == null) return null; const ref = String(value); if (!REFERENCE.test(ref) || (prefix && !ref.startsWith(`${prefix}_`))) return null; return ref; }
function boundedText(value, min, max, name) { const text = String(value ?? ""); if (text.length < min || text.length > max || /[\r\n\0]/.test(text)) throw new TypeError(`${name} is invalid`); return text; }
function boundedInteger(value, min, max, name) { if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${name} is invalid`); return value; }
function currentDate(config) { const date = config.now(); if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new TypeError("config.now must return a valid Date"); return date; }
