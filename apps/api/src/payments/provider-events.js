import { createHash, randomUUID } from "node:crypto";
import { HttpError, sendJson } from "../http.js";
import { withTransaction } from "../db/index.js";
import { parseStripeWebhook, StripeTestConfigurationError } from "./stripe-test.js";
import { notifyNewOrder } from "../offers.js";

export const PROVIDER_EVENT_WEBHOOK_PATH = "/api/provider-events/stripe-test";
const DEFAULT_BODY_LIMIT = 256 * 1024;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_LEASE_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const REFERENCE = /^(acct|pi|ch|tr|re|po|seti|mandate|cs)_[A-Za-z0-9_]+$/;

export async function routeProviderEventWebhook({ req, res, url, db, config }) {
  const path=url.pathname.match(/^\/api\/provider-events\/(stripe-test|stripe-live)(\/connect)?$/);if(!path)return false;const provider=path[1].replace("-","_"),connect=Boolean(path[2]),mode=provider==="stripe_live"?"live":"test";
  if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
  if (config.paymentProviderMode !== provider || !config.paymentProvider) throw new HttpError(404, "PROVIDER_WEBHOOK_DISABLED", "Provider webhook is disabled");
  const webhookSecret=connect?config.paymentProviderConnectWebhookSecret:config.paymentProviderWebhookSecret;if(typeof webhookSecret!=="string"||!webhookSecret.startsWith("whsec_"))throw new HttpError(503,"PROVIDER_WEBHOOK_NOT_CONFIGURED","Provider webhook is not configured");
  if (req.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");

  const rawBody = await readRawBody(req, boundedInteger(config.providerWebhookBodyLimit ?? DEFAULT_BODY_LIMIT, 1024, 1024 * 1024, "providerWebhookBodyLimit"));
  const now = currentDate(config);
  let event;
  try {
    event = parseStripeWebhook({
      rawBody,
      signatureHeader: req.headers["stripe-signature"],
      secret: webhookSecret,mode,
      nowSeconds: Math.floor(now.getTime() / 1000),
      toleranceSeconds: 300
    });
  } catch (error) {
    if (error instanceof StripeTestConfigurationError && /mode/i.test(error.message)) throw new HttpError(400, mode==="test"?"LIVE_PROVIDER_EVENT_REJECTED":"PROVIDER_EVENT_MODE_MISMATCH", "Provider event mode does not match this endpoint");
    if (/signature/i.test(String(error?.message))) throw new HttpError(400, "INVALID_PROVIDER_SIGNATURE", "Provider signature is missing, invalid, or stale");
    throw new HttpError(400, "INVALID_PROVIDER_EVENT", "Provider event is malformed");
  }

  let normalized;
  try { normalized = {...normalizeEvent(event),provider}; }
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
  const provider=config.paymentProviderMode;if(!["stripe_test","stripe_live"].includes(provider)||!config.paymentProvider)return{...summary,skipped:"provider_disabled"};

  for (let count = 0; count < limit; count += 1) {
    const now = currentDate(config);
    const event = withTransaction(db, () => claimNext(db, provider, workerId, now, leaseMs, maxAttempts));
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
  const existing = db.prepare("SELECT payload_fingerprint,status FROM provider_events WHERE provider=? AND provider_event_id=?").get(event.provider, event.eventId);
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
    randomUUID(), event.provider, event.eventId, event.eventType, event.objectType, event.objectId, event.providerAccountReference,
    mapping.restaurantId ?? null, fingerprint, JSON.stringify(event), event.providerCreatedAt, status, now, error, now, now
  );
  return { status, replayed: false };
}

function claimNext(db, provider, workerId, nowDate, leaseMs, maxAttempts) {
  const now = nowDate.toISOString();
  const row = db.prepare(`SELECT * FROM provider_events
    WHERE provider=? AND (((status IN ('queued','delayed')) AND available_at<=? AND attempts<?) OR (status='claimed' AND lease_expires_at<=?))
      ORDER BY available_at,created_at LIMIT 1`).get(provider,now, maxAttempts, now);
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
      updated_at=excluded.updated_at`).run(normalized.provider, normalized.objectId, normalized.objectType, mapping.restaurantId, event.provider_created_at, event.provider_event_id, state, now);
  db.prepare("UPDATE provider_events SET status='completed',restaurant_id=?,error=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?").run(mapping.restaurantId, now, event.id);
  return "completed";
}

function applyProviderResult(db, event, mapping, result, now) {
  if (event.kind === "account") {
    if(result.providerReference!==event.objectId)return{ok:false,error:"ACCOUNT_REFERENCE_MISMATCH"};
    if(typeof result.chargesEnabled!=="boolean"||typeof result.payoutsEnabled!=="boolean")return{ok:false,error:"ACCOUNT_READINESS_INVALID"};
    const status = result.status === "confirmed" ? "enabled" : result.status === "failed" ? "restricted" : "pending";
    db.prepare("UPDATE provider_accounts SET status=?,capabilities=?,requirements=?,updated_at=? WHERE id=? AND provider_mode=?")
      .run(status, JSON.stringify(arrayOfText(result.capabilities)), JSON.stringify(arrayOfText(result.requirements)), now, mapping.row.id,event.provider);
    if (tableExists(db, "stripe_account_readiness")) {
      db.prepare(`INSERT INTO stripe_account_readiness(restaurant_id,provider_mode,provider_account_id,charges_enabled,payouts_enabled,verified_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(restaurant_id,provider_mode) DO UPDATE SET
        provider_account_id=excluded.provider_account_id,charges_enabled=excluded.charges_enabled,
        payouts_enabled=excluded.payouts_enabled,verified_at=excluded.verified_at`)
        .run(mapping.restaurantId,event.provider,event.objectId,result.chargesEnabled===true?1:0,result.payoutsEnabled===true?1:0,now);
    }
    return { ok: true };
  }
  if (event.kind === "payment") {
    if (mapping.source === "order_payment") return applyOrderPaymentResult(db,event,mapping,result,now);
    const metadata = safeJson(mapping.row.metadata, {});
    if (metadata.paymentState === "captured" && result.paymentState !== "captured") return { ok: true };
    const status = result.paymentState === "captured" ? "confirmed" : ["cancelled", "requires_payment_method"].includes(result.paymentState) || result.status === "failed" ? "failed" : "pending";
    const nextMetadata = { ...metadata, paymentState: safeCode(result.paymentState, result.status), reconciledFromProviderEvent: true };
    if (typeof result.latestChargeId === "string") nextMetadata.latestChargeId = result.latestChargeId;
    if (typeof result.availableOn === "string") nextMetadata.availableOn = result.availableOn;
    if (Number.isSafeInteger(result.providerCostMinor) && result.providerCostMinor >= 0) nextMetadata.providerCostMinorObserved = result.providerCostMinor;
    db.prepare("UPDATE marketplace_operations SET status=?,error=?,metadata=?,updated_at=? WHERE id=? AND provider_mode=?")
      .run(status, status === "failed" ? safeCode(result.errorCode, "PROVIDER_PAYMENT_FAILED") : null, JSON.stringify(nextMetadata), now, mapping.row.id,event.provider);
    return { ok: true };
  }
  if(event.kind==="checkout"){
    const order=db.prepare("SELECT * FROM orders WHERE id=?").get(mapping.row.order_id),payable=["authorized","captured"].includes(result.paymentState);if(!order||result.amountMinor!==order.total_minor||String(result.currency||"").toUpperCase()!==String(order.currency).toUpperCase()||result.orderId!==order.id||result.restaurantId!==order.restaurant_id||(payable&&(!result.paymentIntentId||result.captureMethod!=="manual"))||(mapping.row.payment_intent_id&&result.paymentIntentId!==mapping.row.payment_intent_id))return{ok:false,error:"CHECKOUT_PAYMENT_BINDING_MISMATCH"};
    if(mapping.row.status==="captured"&&result.paymentState!=="captured")return{ok:true};
    const status=result.paymentState==="authorized"?"authorized":result.paymentState==="captured"?"captured":["cancelled","expired","requires_payment_method"].includes(result.paymentState)||result.status==="failed"?"failed":"pending";
    db.prepare("UPDATE stripe_order_payments SET payment_intent_id=COALESCE(?,payment_intent_id),latest_charge_id=COALESCE(?,latest_charge_id),status=?,provider_cost_minor=COALESCE(?,provider_cost_minor),available_on=COALESCE(?,available_on),error=?,updated_at=? WHERE checkout_session_id=? AND provider_mode=?").run(result.paymentIntentId??null,result.latestChargeId??null,status,Number.isSafeInteger(result.providerCostMinor)?result.providerCostMinor:null,result.availableOn??null,status==="failed"?safeCode(result.errorCode,"PROVIDER_CHECKOUT_FAILED"):null,now,event.objectId,event.provider);
    const firstPayable=["authorized","captured"].includes(status)&&!["stripe_authorized","stripe_captured","stripe_partially_refunded","stripe_refunded"].includes(order.payment_status);
    if(["authorized","captured"].includes(status)&&!["stripe_partially_refunded","stripe_refunded"].includes(order.payment_status))db.prepare("UPDATE orders SET payment_status=?,updated_at=? WHERE id=?").run(`stripe_${status}`,now,order.id);
    if(firstPayable&&order.status==="placed")notifyNewOrder(db,{...order,payment_status:`stripe_${status}`},now);
    return{ok:true};
  }
  if (event.kind === "transfer") {
    if(result.providerReference!==event.objectId||result.amountMinor!==mapping.row.amount_minor||String(result.currency||"").toUpperCase()!==String(mapping.row.currency||"").toUpperCase())return{ok:false,error:"TRANSFER_FINANCIAL_BINDING_MISMATCH"};
    const metadata=safeJson(mapping.row.metadata,{});
    if(mapping.row.kind==="merchant_transfer"){
      const order=mapping.row.order_id&&db.prepare("SELECT id,restaurant_id FROM orders WHERE id=?").get(mapping.row.order_id);
      const payment=order&&db.prepare("SELECT payment_intent_id,latest_charge_id,provider_mode FROM stripe_order_payments WHERE order_id=?").get(order.id);
      const account=order&&db.prepare("SELECT provider_reference,provider_mode FROM provider_accounts WHERE restaurant_id=?").get(order.restaurant_id);
      if(!order||!payment||!account||metadata.orderId!==order.id||metadata.restaurantId!==order.restaurant_id||metadata.amountMinor!==mapping.row.amount_minor||metadata.providerMode!==event.provider||metadata.paymentIntentId!==payment.payment_intent_id||metadata.sourceCharge!==payment.latest_charge_id||metadata.accountId!==account.provider_reference||payment.provider_mode!==event.provider||account.provider_mode!==event.provider||result.destinationAccountId!==metadata.accountId||result.sourceTransactionId!==metadata.sourceCharge||result.transferGroup!==`order:${order.id}`)return{ok:false,error:"TRANSFER_SETTLEMENT_BINDING_MISMATCH"};
    }else if((metadata.transferGroup&&result.transferGroup!==metadata.transferGroup)||(metadata.accountId&&result.destinationAccountId!==metadata.accountId)||(metadata.sourceCharge&&result.sourceTransactionId!==metadata.sourceCharge))return{ok:false,error:"TRANSFER_METADATA_BINDING_MISMATCH"};
    if (mapping.row.status === "confirmed" && result.status !== "confirmed") return { ok: true };
    const status = result.status === "confirmed" ? "confirmed" : result.status === "failed" ? "failed" : "delayed";
    db.prepare("UPDATE marketplace_operations SET status=?,error=?,updated_at=? WHERE id=? AND provider_mode=?")
      .run(status, status === "failed" ? safeCode(result.errorCode, "PROVIDER_TRANSFER_FAILED") : null, now, mapping.row.id,event.provider);
    return { ok: true };
  }
  if (event.kind === "payout") {
    if(result.providerReference!==event.objectId)return{ok:false,error:"PAYOUT_REFERENCE_MISMATCH"};
    if (!Number.isSafeInteger(result.amountMinor) || result.amountMinor < 0) return { ok: false, error: "PAYOUT_AMOUNT_INVALID" };
    if (mapping.row.amount_minor != null && result.amountMinor !== mapping.row.amount_minor) return { ok: false, error: "PAYOUT_AMOUNT_MISMATCH" };
    const paymentState=safeCode(result.paymentState,"unknown");
    const status=paymentState==="paid"?"paid":paymentState==="failed"||paymentState==="canceled"||result.status==="failed"?"failed":paymentState==="pending"?"pending":"in_transit";
    const failure=status==="failed"?safeCode(result.errorCode,"PROVIDER_PAYOUT_FAILED"):null;
    if (mapping.source === "legacy") {
      if (mapping.row.status === "paid" && paymentState !== "paid") return { ok: true };
      db.prepare("UPDATE payout_batches SET status=?,failure=?,updated_at=? WHERE id=? AND provider_mode=?")
        .run(status,failure,now,mapping.row.id,event.provider);
    }
    if (tableExists(db,"stripe_connected_payouts")) {
      db.prepare(`INSERT INTO stripe_connected_payouts(id,restaurant_id,provider_account_id,amount_minor,status,arrival_at,failure,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        restaurant_id=excluded.restaurant_id,provider_account_id=excluded.provider_account_id,amount_minor=excluded.amount_minor,
        status=excluded.status,arrival_at=excluded.arrival_at,failure=excluded.failure,updated_at=excluded.updated_at`)
        .run(event.objectId,mapping.restaurantId,mapping.providerAccount.provider_reference,result.amountMinor,status,result.arrivalAt??null,failure,now,now);
    }
    return { ok: true };
  }
  if (event.kind === "setup" || event.kind === "mandate") {
    const status = result.status === "confirmed" ? "authorised" : result.status === "failed" ? "failed" : "created";
    const reference = typeof result.mandateId === "string" ? result.mandateId : mapping.row.provider_reference;
    db.prepare("UPDATE cash_mandates SET status=?,provider_reference=?,updated_at=? WHERE id=? AND provider_mode=?")
      .run(status, reference, now, mapping.row.id,event.provider);
    return { ok: true };
  }
  return { ok: false, error: "UNSUPPORTED_RECONCILIATION_KIND" };
}

function applyOrderPaymentResult(db,event,mapping,result,now) {
  const payment=mapping.row,order=db.prepare("SELECT * FROM orders WHERE id=? AND restaurant_id=?").get(payment.order_id,mapping.restaurantId);
  if(!order||result.providerReference!==event.objectId||result.paymentIntentId!==payment.payment_intent_id||result.amountMinor!==order.total_minor||String(result.currency||"").toUpperCase()!==order.currency||result.orderId!==order.id||result.restaurantId!==order.restaurant_id||result.captureMethod!=="manual") return {ok:false,error:"PAYMENT_ORDER_BINDING_MISMATCH"};
  if(payment.status==="captured"&&result.paymentState!=="captured")return{ok:true};
  const state=result.paymentState==="authorized"?"authorized":result.paymentState==="captured"?"captured":result.paymentState==="cancelled"?"cancelled":result.paymentState==="requires_payment_method"||result.status==="failed"?"failed":"pending";
  db.prepare("UPDATE stripe_order_payments SET status=?,latest_charge_id=COALESCE(?,latest_charge_id),provider_cost_minor=COALESCE(?,provider_cost_minor),available_on=COALESCE(?,available_on),error=?,updated_at=? WHERE order_id=? AND provider_mode=? AND payment_intent_id=?").run(state,result.latestChargeId??null,Number.isSafeInteger(result.providerCostMinor)&&result.providerCostMinor>=0?result.providerCostMinor:null,result.availableOn??null,state==="failed"?safeCode(result.errorCode,"PROVIDER_PAYMENT_FAILED"):null,now,order.id,event.provider,event.objectId);
  const firstPayable=["authorized","captured"].includes(state)&&!["stripe_authorized","stripe_captured","stripe_partially_refunded","stripe_refunded"].includes(order.payment_status);
  if(["authorized","captured"].includes(state)&&!["stripe_partially_refunded","stripe_refunded"].includes(order.payment_status))db.prepare("UPDATE orders SET payment_status=?,updated_at=? WHERE id=?").run(`stripe_${state}`,now,order.id);
  if(firstPayable&&order.status==="placed")notifyNewOrder(db,{...order,payment_status:`stripe_${state}`},now);
  return{ok:true};
}

function resolveMapping(db, event) {
  if (event.kind === "unsupported") return { state: "ignored" };
  let rows = [];
  if (event.kind === "account") rows = db.prepare("SELECT * FROM provider_accounts WHERE provider_mode=? AND provider_reference=?").all(event.provider,event.objectId);
  else if(event.kind==="checkout")rows=db.prepare("SELECT * FROM stripe_order_payments WHERE provider_mode=? AND checkout_session_id=?").all(event.provider,event.objectId);
  else if (event.kind === "payment") {
    const legacy=db.prepare("SELECT * FROM marketplace_operations WHERE provider_mode=? AND provider_reference=?").all(event.provider,event.objectId);
    const payments=tableExists(db,"stripe_order_payments")?db.prepare("SELECT p.*,o.restaurant_id,'order_payment' AS mapping_source FROM stripe_order_payments p JOIN orders o ON o.id=p.order_id WHERE p.provider_mode=? AND p.payment_intent_id=?").all(event.provider,event.objectId):[];
    rows=payments.length?payments:legacy;
    if(payments.length&&legacy.some(row=>row.restaurant_id!==payments[0].restaurant_id||(row.order_id&&row.order_id!==payments[0].order_id)))return{state:"conflict"};
  }
  else if (event.kind === "transfer") rows = db.prepare("SELECT * FROM marketplace_operations WHERE provider_mode=? AND provider_reference=?").all(event.provider,event.objectId);
  else if (event.kind === "payout") {
    if(tableExists(db,"stripe_connected_payouts")) rows=db.prepare("SELECT *, 'connected' AS mapping_source FROM stripe_connected_payouts WHERE id=?").all(event.objectId);
    if(!rows.length)rows=db.prepare("SELECT *, 'legacy' AS mapping_source FROM payout_batches WHERE provider_mode=? AND provider_reference=?").all(event.provider,event.objectId);
    if(!rows.length&&event.providerAccountReference){const account=db.prepare("SELECT * FROM provider_accounts WHERE provider_mode=? AND provider_reference=?").get(event.provider,event.providerAccountReference);if(account)rows=[{id:event.objectId,restaurant_id:account.restaurant_id,amount_minor:null,mapping_source:"account"}];}
  }
  else if (["setup", "mandate"].includes(event.kind)) rows = db.prepare("SELECT * FROM cash_mandates WHERE provider_mode=? AND provider_reference=?").all(event.provider,event.objectId);
  if (!rows.length) return { state: "unmatched" };
  const tenants = new Set(rows.map((row) => row.restaurant_id));
  if (tenants.size !== 1 || rows.length !== 1) return { state: "conflict" };
  const restaurantId = rows[0].restaurant_id;
  if (event.kind === "account" && event.providerAccountReference && event.providerAccountReference !== event.objectId) return { state: "conflict" };
  let account = null;
  if (event.kind !== "account") account = db.prepare("SELECT * FROM provider_accounts WHERE restaurant_id=? AND provider_mode=?").get(restaurantId,event.provider);
  if (event.kind !== "account" && event.providerAccountReference && (!account || account.provider_reference !== event.providerAccountReference)) return { state: "conflict" };
  if (event.kind === "payout" && !account?.provider_reference) return { state: "unmatched" };
  return { state: "mapped", restaurantId, row: rows[0], source: rows[0].mapping_source, providerAccount: account };
}

async function retrieveCurrentProviderState(adapter, event, mapping) {
  if (event.kind === "account") return adapter.refreshConnectedAccount({ accountId: event.objectId });
  if(event.kind==="checkout")return adapter.retrieveCheckoutSession({sessionId:event.objectId});
  if (event.kind === "payment") return adapter.retrievePayment({ paymentIntentId: event.objectId });
  if (event.kind === "transfer") return adapter.retrieveTransfer({ transferId: event.objectId });
  if (event.kind === "payout") return adapter.retrievePayout({ payoutId: event.objectId, accountId: mapping.providerAccount.provider_reference });
  if (event.kind === "setup") return adapter.retrieveSetupIntent({ setupIntentId: event.objectId });
  if (event.kind === "mandate") return adapter.retrieveMandate({ mandateId: event.objectId });
  throw new TypeError("Unsupported reconciliation kind");
}

export async function retrieveAuthoritativeProviderState(adapter,{kind,providerReference,accountId,transferId}){
  if(kind==="checkout")return adapter.retrieveCheckoutSession({sessionId:providerReference});
  if(kind==="payment")return adapter.retrievePayment({paymentIntentId:providerReference});
  if(kind==="refund")return adapter.retrieveRefund({refundId:providerReference});
  if(kind==="transfer")return adapter.retrieveTransfer({transferId:providerReference});
  if(kind==="transfer_reversal")return adapter.retrieveTransferReversal({transferId,reversalId:providerReference});
  if(kind==="payout")return adapter.retrievePayout({payoutId:providerReference,accountId});
  throw new TypeError("Unsupported authoritative provider state kind");
}

function appliedChronology(db, event, restaurantId) {
  const state = db.prepare("SELECT * FROM provider_event_object_state WHERE provider=? AND object_id=?").get(event.provider, event.object_id);
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
  else if(eventType.startsWith("checkout.session.")){kind="checkout";objectId=requiredReference(object.id,"cs");}
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
function tableExists(db,name){return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));}
