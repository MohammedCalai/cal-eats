import { randomUUID } from "node:crypto";
import { requireRestaurantOwner, requireRole } from "../auth/authorization.js";
import { withTransaction } from "../db/index.js";
import { HttpError, exactObject, readJson, sendJson } from "../http.js";
import { finalizeStripeRefund, queueStripeTransferReversal, recordMarketplaceAcceptance } from "../marketplace.js";
import { releaseOfferForOrder, notifyNewOrder, notifyOrderStatus } from "../offers.js";
import { retrieveAuthoritativeProviderState } from "./provider-events.js";
import { queueEligibleStripeTransfers } from "./stripe-settlement.js";

const stripeMode = config => ["stripe_test", "stripe_live"].includes(config.paymentProviderMode) ? config.paymentProviderMode : null;
const provider = config => config.stripeProvider ?? config.paymentProvider;
const now = config => config.now().toISOString();
const key = req => { const value = req.headers["idempotency-key"]; if (typeof value !== "string" || value.length < 8 || value.length > 255 || /[\r\n\0]/.test(value)) throw new HttpError(400,"VALIDATION_ERROR","Idempotency-Key is invalid"); return value; };
const schedule = { interval: "weekly", weeklyAnchor: "monday" };
const configured = config => Boolean(stripeMode(config) && provider(config) && config.stripePlatformAccountId && config.paymentProviderWebhookSecret && config.paymentProviderConnectWebhookSecret);
const paymentDto = (row, order) => ({ orderId: order.id, checkoutUrl: row?.checkout_url ?? null, providerMode: row?.provider_mode ?? "unconfigured", status: row?.status ?? "pending", checkoutAvailable: order.status === "placed" && ["pending", "unknown", "failed"].includes(row?.status ?? "pending") });
const verifiedAdapters = new WeakMap();

export async function ensureStripePlatform(config) {
  const adapter = provider(config), expected = config.stripePlatformAccountId;
  if (!configured(config) || typeof adapter.retrievePlatformAccount !== "function") throw new HttpError(503,"STRIPE_ACCOUNT_UNVERIFIED","Stripe account and payment updates are not fully configured");
  if (verifiedAdapters.get(adapter) === expected) return expected;
  const result = await adapter.retrievePlatformAccount();
  if (result?.ok === false || !["confirmed", "pending"].includes(result?.status) || result.providerReference !== expected || (result.mode && result.mode !== stripeMode(config))) throw new HttpError(503,"STRIPE_ACCOUNT_MISMATCH","Stripe account verification did not match the configured Cal-Eats account");
  verifiedAdapters.set(adapter, expected); return expected;
}
const ensurePlatform = ensureStripePlatform;

export function assertStripePaymentBinding(result, { order, payment }) {
  const hasIntent = Boolean(result?.paymentIntentId);
  if (!result || result.ok === false || result.amountMinor !== order.total_minor || String(result.currency || "").toUpperCase() !== order.currency || result.orderId !== order.id || result.restaurantId !== order.restaurant_id || (hasIntent && result.captureMethod !== "manual") || (["authorized", "captured"].includes(result.paymentState) && !hasIntent)) throw new HttpError(409,"STRIPE_PAYMENT_MISMATCH","Stripe payment does not match the order");
  if (payment?.payment_intent_id && result.paymentIntentId !== payment.payment_intent_id) throw new HttpError(409,"STRIPE_PAYMENT_MISMATCH","Stripe PaymentIntent does not match the order");
  return result;
}

function accountForMode(db, restaurantId, config) {
  const row = db.prepare("SELECT * FROM provider_accounts WHERE restaurant_id=?").get(restaurantId);
  if (row && row.provider_mode !== stripeMode(config)) throw new HttpError(409,"STRIPE_MODE_MISMATCH","Restaurant banking belongs to another payment mode. Complete the reviewed account switch before continuing");
  return row;
}
function accountReadiness(db, row) { return row && db.prepare("SELECT * FROM stripe_account_readiness WHERE restaurant_id=? AND provider_mode=? AND provider_account_id=?").get(row.restaurant_id, row.provider_mode, row.provider_reference); }
function accountDto(db, row) {
  const ready = accountReadiness(db, row);
  return { status: row?.status ?? "not_started", chargesEnabled: Boolean(ready?.charges_enabled), payoutsEnabled: Boolean(ready?.payouts_enabled), requirements: row ? JSON.parse(row.requirements || "[]") : [] };
}
function saveAccount(db, config, restaurantId, result) {
  if (result?.ok === false || !["confirmed", "pending", "failed"].includes(result?.status) || !/^acct_[A-Za-z0-9_]+$/.test(result.providerReference || "")) throw new HttpError(502,"STRIPE_ACCOUNT_REFRESH_FAILED","Stripe account status could not be confirmed");
  const stamp = now(config), mode = stripeMode(config);
  withTransaction(db, () => {
    const status = result.chargesEnabled && result.payoutsEnabled ? "enabled" : result.status === "failed" ? "restricted" : "pending";
    db.prepare("INSERT INTO provider_accounts VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(restaurant_id) DO UPDATE SET provider_mode=excluded.provider_mode,status=excluded.status,capabilities=excluded.capabilities,requirements=excluded.requirements,provider_reference=excluded.provider_reference,updated_at=excluded.updated_at").run(randomUUID(),restaurantId,mode,status,JSON.stringify(result.capabilities ?? []),JSON.stringify(result.requirements ?? []),result.providerReference,stamp,stamp);
    recordAccountReadiness(db, { restaurantId, mode, accountId: result.providerReference, result, stamp });
  });
  return accountForMode(db, restaurantId, config);
}
function ownedCardOrder(db, session, orderId, config) {
  const customer = requireRole(session,"customer"), order = db.prepare("SELECT * FROM orders WHERE id=? AND customer_id=? AND payment_method='card'").get(orderId,customer.id);
  if (!order) throw new HttpError(404,"NOT_FOUND","Resource not found");
  const payment = db.prepare("SELECT * FROM stripe_order_payments WHERE order_id=?").get(order.id);
  if (payment && payment.provider_mode !== stripeMode(config)) throw new HttpError(409,"STRIPE_MODE_MISMATCH","Order belongs to another payment mode");
  return { order, payment };
}
function applyPaymentFacts(db, config, order, result) {
  const allowed = new Set(["pending","authorized","captured","failed","cancelled","expired","unknown"]);
  const returned = allowed.has(result.paymentState) ? result.paymentState : "unknown";
  withTransaction(db, () => {
    const fresh = db.prepare("SELECT * FROM stripe_order_payments WHERE order_id=?").get(order.id);
    const state = fresh.status === "captured" ? "captured" : returned;
    db.prepare("UPDATE stripe_order_payments SET payment_intent_id=COALESCE(?,payment_intent_id),latest_charge_id=COALESCE(?,latest_charge_id),status=?,provider_cost_minor=COALESCE(?,provider_cost_minor),available_on=COALESCE(?,available_on),error=?,updated_at=? WHERE order_id=?").run(result.paymentIntentId ?? null,result.latestChargeId ?? null,state,result.providerCostMinor ?? null,result.availableOn ?? null,safeProviderError(result.errorCode),now(config),order.id);
    const refunded = db.prepare("SELECT COALESCE(SUM(food_amount_minor+delivery_amount_minor),0) n FROM refunds WHERE order_id=?").get(order.id).n;
    const paymentStatus = refunded >= order.total_minor && refunded > 0 ? "stripe_refunded" : refunded > 0 ? "stripe_partially_refunded" : `stripe_${state}`;
    db.prepare("UPDATE orders SET payment_status=?,updated_at=? WHERE id=?").run(paymentStatus,now(config),order.id);
    if (order.status === "placed" && ["authorized","captured"].includes(state) && !["authorized","captured"].includes(fresh.status)) notifyNewOrder(db,order,now(config));
  });
}

export async function routeStripeConnect(ctx) {
  const { req, res, url, db, config, session } = ctx;
  if (req.method === "GET" && url.pathname === "/api/payments/config") return sendJson(res,200,{data:{providerMode:config.paymentProviderMode,cardAvailable:configured(config),stripeMode:stripeMode(config)?.replace("stripe_","") ?? null,payoutSchedule:schedule,commissionRateBasisPoints:700}});
  let match = url.pathname.match(/^\/api\/orders\/([^/]+)\/(checkout|payment\/refresh)$/);
  if (match && req.method === "POST") {
    const access = ownedCardOrder(db,session,match[1],config); await ensurePlatform(config);
    return match[2] === "checkout" ? checkout({ ...ctx, ...access }) : refreshPayment({ ...ctx, ...access });
  }
  match = url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/finance\/stripe(?:\/(onboarding|refresh|dashboard|payouts))?$/);
  if (match) {
    const owner = requireRestaurantOwner(db,session,match[1]), mode = stripeMode(config);
    if (req.method === "GET" && !match[2]) {
      const row = mode ? accountForMode(db,match[1],config) : null;
      return sendJson(res,200,{data:{providerMode:config.paymentProviderMode,configured:configured(config),account:accountDto(db,row),payoutSchedule:schedule}});
    }
    if (req.method === "GET" && match[2] === "payouts") {
      if (!mode || !accountForMode(db,match[1],config)?.provider_reference) return sendJson(res,200,{data:{items:[]}});
      await ensurePlatform(config); return listPayouts({ ...ctx, restaurantId:match[1] });
    }
    if (req.method === "POST" && ["onboarding","refresh","dashboard"].includes(match[2])) { await ensurePlatform(config); return accountAction({ ...ctx, owner, restaurantId:match[1], action:match[2] }); }
  }
  if (req.method === "GET" && url.pathname === "/api/admin/finance/stripe/readiness") {
    requireRole(session,"admin"); const mode = stripeMode(config);
    const accounts = db.prepare("SELECT status,COUNT(*) n FROM provider_accounts WHERE provider_mode=? GROUP BY status").all(mode ?? "unconfigured");
    return sendJson(res,200,{data:{providerMode:config.paymentProviderMode,configured:configured(config),webhookConfigured:Boolean(config.paymentProviderWebhookSecret && config.paymentProviderConnectWebhookSecret),accounts:Object.fromEntries(accounts.map(row=>[row.status,row.n])),orders:{pending:db.prepare("SELECT COUNT(*) n FROM stripe_order_payments WHERE provider_mode=? AND status IN ('pending','unknown')").get(mode).n,failed:db.prepare("SELECT COUNT(*) n FROM stripe_order_payments WHERE provider_mode=? AND status='failed'").get(mode).n},payoutSchedule:schedule}});
  }
  if (req.method === "GET" && url.pathname === "/api/admin/finance/stripe/payouts") {
    requireRole(session,"admin");
    const rows = db.prepare("SELECT p.*,r.name restaurant_name FROM stripe_connected_payouts p JOIN restaurants r ON r.id=p.restaurant_id JOIN provider_accounts a ON a.restaurant_id=p.restaurant_id AND a.provider_reference=p.provider_account_id WHERE a.provider_mode=? ORDER BY p.updated_at DESC LIMIT 50").all(stripeMode(config));
    return sendJson(res,200,{data:{items:rows.map(row=>({id:row.id,restaurantName:row.restaurant_name,amountMinor:row.amount_minor,status:row.status,arrivalAt:row.arrival_at,failure:row.failure}))}});
  }
  return false;
}

async function checkout({ req, res, db, config, order, payment }) {
  const body = await readJson(req,config.bodyLimit); exactObject(body,[]); key(req);
  if (order.status !== "placed") throw new HttpError(409,"CHECKOUT_NOT_ALLOWED","Checkout is not available for this order");
  if (Date.parse(order.created_at) <= config.now().getTime()-config.orderExpiryMinutes*60_000) throw new HttpError(409,"CHECKOUT_EXPIRED","This order has expired. Start a new order with current prices");
  if (payment?.checkout_url && ["pending","authorized","failed"].includes(payment.status)) return sendJson(res,200,{data:paymentDto(payment,order)});
  if (payment && ["captured","cancelled","expired"].includes(payment.status)) throw new HttpError(409,"CHECKOUT_NOT_ALLOWED","This payment cannot start another checkout");
  const stamp = now(config), mode = stripeMode(config);
  withTransaction(db,()=>db.prepare("INSERT INTO stripe_order_payments(order_id,provider_mode,status,created_at,updated_at) VALUES(?,?,'pending',?,?) ON CONFLICT(order_id) DO NOTHING").run(order.id,mode,stamp,stamp));
  // This key is fixed by the server, so changing client retry keys cannot create another session.
  const result = await provider(config).createCheckoutSession({orderId:order.id,restaurantId:order.restaurant_id,amountMinor:order.total_minor,transferGroup:`order:${order.id}`,successUrl:new URL(`/order/?payment_order=${encodeURIComponent(order.id)}`,config.origin).href,cancelUrl:new URL(`/order/?payment_order=${encodeURIComponent(order.id)}&payment_cancelled=1`,config.origin).href,idempotencyKey:`checkout:${mode}:${order.id}`});
  if (result?.ok === false || !result?.checkoutUrl || !/^cs_[A-Za-z0-9_]+$/.test(result.providerReference || "")) {
    db.prepare("UPDATE stripe_order_payments SET status='unknown',error='CHECKOUT_CREATION_UNCONFIRMED',updated_at=? WHERE order_id=? AND status<>'captured'").run(now(config),order.id);
    throw new HttpError(503,"CHECKOUT_CREATION_UNCONFIRMED","Checkout could not be confirmed. Retry this order; another order is not needed");
  }
  const destination = new URL(result.checkoutUrl);
  if (destination.protocol !== "https:" || destination.hostname !== "checkout.stripe.com" || destination.username || destination.password) throw new HttpError(502,"STRIPE_DESTINATION_INVALID","Secure checkout destination could not be verified");
  if (result.amountMinor !== order.total_minor || result.orderId !== order.id || result.restaurantId !== order.restaurant_id || String(result.currency).toUpperCase() !== order.currency) throw new HttpError(409,"STRIPE_PAYMENT_MISMATCH","Checkout does not match the order");
  withTransaction(db,()=>{
    if (!db.prepare("SELECT 1 FROM orders WHERE id=? AND status='placed'").get(order.id)) throw new HttpError(409,"CHECKOUT_EXPIRED","This order is no longer awaiting payment");
    db.prepare("UPDATE stripe_order_payments SET checkout_session_id=COALESCE(checkout_session_id,?),payment_intent_id=COALESCE(payment_intent_id,?),checkout_url=?,status=CASE WHEN status='captured' THEN status ELSE 'pending' END,error=NULL,updated_at=? WHERE order_id=? AND provider_mode=?").run(result.providerReference,result.paymentIntentId ?? null,destination.href,now(config),order.id,mode);
  });
  return sendJson(res,200,{data:paymentDto(db.prepare("SELECT * FROM stripe_order_payments WHERE order_id=?").get(order.id),order)});
}
async function refreshPayment({ req, res, db, config, order, payment }) {
  const body = await readJson(req,config.bodyLimit); exactObject(body,[]);
  if (payment?.checkout_session_id) {
    const result = assertStripePaymentBinding(await provider(config).retrieveCheckoutSession({sessionId:payment.checkout_session_id}),{order,payment});
    applyPaymentFacts(db,config,order,result);
  }
  return sendJson(res,200,{data:paymentDto(db.prepare("SELECT * FROM stripe_order_payments WHERE order_id=?").get(order.id),order)});
}
async function accountAction({ req, res, db, config, owner, restaurantId, action }) {
  const body = await readJson(req,config.bodyLimit); exactObject(body,[]);
  const adapter = provider(config), mode = stripeMode(config);
  let row = accountForMode(db,restaurantId,config);
  if (action === "onboarding") {
    const retryKey = key(req);
    if (!row?.provider_reference) row = saveAccount(db,config,restaurantId,await adapter.createConnectedAccount({restaurantId,email:owner.email,idempotencyKey:`connect-account:${mode}:${restaurantId}`}));
    const payoutPolicy = await adapter.configureWeeklyPayouts({accountId:row.provider_reference,weeklyAnchor:"monday",idempotencyKey:`connect-schedule:${mode}:${restaurantId}`});
    if (payoutPolicy?.status !== "confirmed" || payoutPolicy?.ok === false) throw new HttpError(503,"STRIPE_PAYOUT_POLICY_PENDING","Weekly payout settings could not be confirmed. Retry setup");
    const result = await adapter.createAccountLink({accountId:row.provider_reference,refreshUrl:new URL("/business/owner/stripe",config.origin).href,returnUrl:new URL("/business/owner/stripe",config.origin).href,idempotencyKey:`connect-link:${mode}:${restaurantId}:${retryKey}`});
    if (!result?.actionUrl || result.ok === false) throw new HttpError(503,"STRIPE_LINK_UNAVAILABLE","Stripe verification link is unavailable. Try again");
    return sendJson(res,200,{data:{url:result.actionUrl,providerMode:mode,expiresAt:result.expiresAt}});
  }
  if (!row?.provider_reference) throw new HttpError(409,"CONNECT_ACCOUNT_REQUIRED","Complete Stripe onboarding first");
  if (action === "refresh") {
    const result = await adapter.refreshConnectedAccount({accountId:row.provider_reference});
    if (result?.providerReference !== row.provider_reference) throw new HttpError(409,"STRIPE_ACCOUNT_MISMATCH","Restaurant account could not be verified");
    row = saveAccount(db,config,restaurantId,result);
    return sendJson(res,200,{data:{providerMode:mode,configured:configured(config),account:accountDto(db,row),payoutSchedule:schedule}});
  }
  const result = await adapter.createAccountLoginLink({accountId:row.provider_reference,idempotencyKey:`connect-dashboard:${mode}:${restaurantId}:${key(req)}`});
  if (!result?.actionUrl || result.ok === false) throw new HttpError(503,"STRIPE_LINK_UNAVAILABLE","Stripe dashboard is unavailable. Try again");
  return sendJson(res,200,{data:{url:result.actionUrl,providerMode:mode}});
}
async function listPayouts({ res, db, config, restaurantId }) {
  const row = accountForMode(db,restaurantId,config);
  const result = await provider(config).listPayouts({accountId:row.provider_reference,limit:50});
  if (result?.ok === false || !Array.isArray(result?.items)) throw new HttpError(503,"STRIPE_PAYOUTS_UNAVAILABLE","Bank payout status could not be refreshed");
  const stamp = now(config), items = result.items.map(item=>({id:item.providerReference,amountMinor:item.amountMinor,status:item.paymentState ?? item.status,arrivalAt:item.arrivalAt,failure:safeProviderError(item.errorCode)}));
  withTransaction(db,()=>{for(const item of items) db.prepare("INSERT INTO stripe_connected_payouts VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,arrival_at=excluded.arrival_at,failure=excluded.failure,updated_at=excluded.updated_at").run(item.id,restaurantId,row.provider_reference,item.amountMinor,item.status,item.arrivalAt ?? null,item.failure,stamp,stamp);});
  return sendJson(res,200,{data:{items}});
}

export async function runStripeConnectWorker(db, config, { workerId = randomUUID(), limit = 25 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Stripe worker limit is invalid");
  const adapter = provider(config), mode = stripeMode(config), summary = { claimed:0, completed:0, failed:0, retried:0 };
  if (!adapter || !mode) return summary;
  await ensurePlatform(config);
  await reconcileStripeCosts(db,config,adapter,{limit});
  await expireCardOrders(db,config,adapter,{limit});
  queueEligibleStripeTransfers(db,config,{limit});
  for (let index = 0; index < limit; index += 1) {
    const stamp = now(config), lease = new Date(config.now().getTime()+120_000).toISOString();
    const job = withTransaction(db, () => {
      db.prepare("UPDATE marketplace_operations SET status='failed',error='PROVIDER_RETRY_EXHAUSTED',updated_at=? WHERE status<>'confirmed' AND operation_key IN (SELECT operation_key FROM marketplace_worker_jobs WHERE kind LIKE 'stripe_%' AND status='claimed' AND lease_expires_at<=? AND attempts>=5)").run(stamp,stamp);
      db.prepare("UPDATE marketplace_worker_jobs SET status='failed',lease_owner=NULL,lease_expires_at=NULL,error='PROVIDER_RETRY_EXHAUSTED',updated_at=? WHERE kind LIKE 'stripe_%' AND status='claimed' AND lease_expires_at<=? AND attempts>=5").run(stamp,stamp);
      const row = db.prepare("SELECT * FROM marketplace_worker_jobs WHERE kind IN ('stripe_transfer','stripe_refund','stripe_transfer_reversal') AND ((status IN ('queued','delayed') AND available_at<=?) OR (status='claimed' AND lease_expires_at<=?)) AND attempts<5 ORDER BY created_at,id LIMIT 1").get(stamp,stamp);
      if (!row) return null;
      db.prepare("UPDATE marketplace_worker_jobs SET status='claimed',lease_owner=?,lease_expires_at=?,attempts=attempts+1,updated_at=? WHERE id=?").run(workerId,lease,stamp,row.id);
      return db.prepare("SELECT * FROM marketplace_worker_jobs WHERE id=?").get(row.id);
    });
    if (!job) break; summary.claimed += 1;
    try {
      const payload = JSON.parse(job.payload), binding = movementBinding(db,config,job,payload);
      let op = db.prepare("SELECT * FROM marketplace_operations WHERE operation_key=?").get(job.operation_key);
      if (!op) {
        db.prepare("INSERT INTO marketplace_operations VALUES(?,?,?,?,?,'pending',?,'GBP',?,NULL,NULL,?,?,?)").run(randomUUID(),job.operation_key,binding.order.restaurant_id,binding.order.id,job.kind === "stripe_refund" ? "order_refund" : "transfer_reversal",payload.amountMinor,mode,JSON.stringify({caseId:payload.caseId}),now(config),now(config));
        op = db.prepare("SELECT * FROM marketplace_operations WHERE operation_key=?").get(job.operation_key);
      }
      let result;
      if (op.provider_reference) {
        result = await retrieveAuthoritativeProviderState(adapter,{kind:job.kind === "stripe_transfer" ? "transfer" : job.kind === "stripe_refund" ? "refund" : "transfer_reversal",providerReference:op.provider_reference,transferId:payload.transferId,accountId:payload.accountId});
      } else if (job.kind === "stripe_transfer") {
        assertCurrentTransfer(db,config,payload,binding);
        const ready = await adapter.refreshConnectedAccount({accountId:binding.account.provider_reference});
        if (ready?.providerReference !== binding.account.provider_reference || !ready.chargesEnabled || !ready.payoutsEnabled || ready.ok === false) throw Object.assign(Error("Restaurant account is not ready"),{code:"STRIPE_TRANSFER_INELIGIBLE"});
        saveAccount(db,config,binding.order.restaurant_id,ready);
        assertCurrentTransfer(db,config,payload,binding);
        result = await adapter.createTransfer({amountMinor:payload.amountMinor,destinationAccountId:payload.accountId,sourceTransactionId:payload.sourceCharge,transferGroup:`order:${payload.orderId}`,operationKey:job.operation_key,idempotencyKey:job.operation_key});
      } else if (job.kind === "stripe_refund") {
        assertCurrentRefund(db,payload,binding);
        result = await adapter.refundPayment({...payload,orderId:binding.order.id,restaurantId:binding.order.restaurant_id,idempotencyKey:job.operation_key,operationKey:job.operation_key});
      } else result = await adapter.reverseTransfer({...payload,idempotencyKey:job.operation_key});
      if (result?.ok === false && result.status === "failed") throw Object.assign(Error("Stripe operation failed"),{code:safeProviderError(result.errorCode) ?? "PROVIDER_OPERATION_FAILED"});
      if (result?.status === "confirmed") assertMovementResult(result,job,payload,binding);
      const updated = now(config), confirmed = result?.status === "confirmed" && result?.ok !== false;
      withTransaction(db, () => {
        requireWorkerLease(db,job,workerId,updated);
        const fresh = db.prepare("SELECT * FROM marketplace_operations WHERE operation_key=?").get(job.operation_key);
        if (!confirmed && fresh.status === "confirmed") throw Object.assign(Error("Confirmed operation cannot regress"),{code:"PROVIDER_STATE_REGRESSION"});
        db.prepare("UPDATE marketplace_operations SET status=?,provider_reference=COALESCE(?,provider_reference),error=?,updated_at=? WHERE operation_key=?").run(confirmed?"confirmed":"unknown",result?.providerReference ?? null,confirmed?null:safeProviderError(result?.errorCode) ?? "PROVIDER_RESULT_PENDING",updated,job.operation_key);
        if (confirmed && job.kind === "stripe_refund") {
          finalizeStripeRefund(db,{caseId:payload.caseId,providerReference:result.providerReference,now:updated});
          queueStripeTransferReversal(db,{caseId:payload.caseId,now:updated});
        }
        if (confirmed && job.kind === "stripe_transfer") {
          recordStripeMovement(db,fresh,"merchant_available","connected_account_funds",updated);
          for (const row of db.prepare("SELECT id FROM refund_cases WHERE order_id=? AND execution_status='confirmed'").all(binding.order.id)) queueStripeTransferReversal(db,{caseId:row.id,now:updated});
        }
        if (confirmed && job.kind === "stripe_transfer_reversal") recordStripeMovement(db,fresh,"connected_account_funds","merchant_recovery",updated);
        if (!confirmed && job.kind === "stripe_refund") db.prepare("UPDATE refund_cases SET status='refund_processing',execution_status='provider_pending',execution_operation_id=?,execution_error=NULL,updated_at=? WHERE id=? AND execution_status<>'confirmed'").run(fresh.id,updated,payload.caseId);
        db.prepare("UPDATE marketplace_worker_jobs SET status=?,lease_owner=NULL,lease_expires_at=NULL,error=?,available_at=?,updated_at=? WHERE id=?").run(confirmed?"completed":"delayed",confirmed?null:"PROVIDER_RESULT_PENDING",confirmed?updated:new Date(config.now().getTime()+60_000).toISOString(),updated,job.id);
      });
      summary[confirmed?"completed":"retried"] += 1;
    } catch (error) {
      const updated = now(config), code = safeProviderError(error?.code) ?? "PROVIDER_OPERATION_FAILED";
      const held = ["STRIPE_TRANSFER_INELIGIBLE","STRIPE_RESULT_MISMATCH","STRIPE_MODE_MISMATCH"].includes(code), permanent = held || job.attempts >= 5;
      const saved = withTransaction(db, () => {
        if (!hasWorkerLease(db,job,workerId,updated)) return false;
        db.prepare("UPDATE marketplace_operations SET status=?,error=?,updated_at=? WHERE operation_key=? AND status<>'confirmed'").run(held?"held":permanent?"failed":"unknown",code,updated,job.operation_key);
        db.prepare("UPDATE marketplace_worker_jobs SET status=?,lease_owner=NULL,lease_expires_at=NULL,error=?,available_at=?,updated_at=? WHERE id=?").run(held?"completed":permanent?"failed":"delayed",code,permanent?updated:new Date(config.now().getTime()+60_000).toISOString(),updated,job.id);
        if (job.kind === "stripe_refund" && permanent) db.prepare("UPDATE refund_cases SET status='refund_failed',execution_status='failed',execution_error=?,updated_at=? WHERE id=? AND execution_status<>'confirmed'").run(code,updated,job.entity_id);
        return true;
      });
      if (saved) summary[permanent?"failed":"retried"] += 1;
    }
  }
  return summary;
}
function hasWorkerLease(db,job,workerId,stamp) { return Boolean(db.prepare("SELECT 1 FROM marketplace_worker_jobs WHERE id=? AND status='claimed' AND lease_owner=? AND lease_expires_at>?").get(job.id,workerId,stamp)); }
function requireWorkerLease(db,job,workerId,stamp) { if (!hasWorkerLease(db,job,workerId,stamp)) throw Object.assign(Error("Worker lease lost"),{code:"WORKER_LEASE_LOST"}); }
function movementBinding(db,config,job,payload) {
  const dispute = payload.caseId ? db.prepare("SELECT * FROM refund_cases WHERE id=?").get(payload.caseId) : null;
  const order = db.prepare("SELECT * FROM orders WHERE id=? AND payment_method='card'").get(payload.orderId ?? dispute?.order_id ?? "");
  const payment = order && db.prepare("SELECT * FROM stripe_order_payments WHERE order_id=?").get(order.id);
  if (!order || !payment || payment.provider_mode !== config.paymentProviderMode || (payload.providerMode && payload.providerMode !== payment.provider_mode)) throw Object.assign(Error("Payment mode binding failed"),{code:"STRIPE_MODE_MISMATCH"});
  if (!Number.isSafeInteger(payload.amountMinor) || payload.amountMinor < 1 || payload.amountMinor > order.total_minor) throw Object.assign(Error("Amount binding failed"),{code:"STRIPE_RESULT_MISMATCH"});
  const account = accountForMode(db,order.restaurant_id,config);
  if (job.kind === "stripe_transfer" && (!account || payload.accountId !== account.provider_reference || payload.platformAccountId !== config.stripePlatformAccountId || payload.sourceCharge !== payment.latest_charge_id || payload.paymentIntentId !== payment.payment_intent_id)) throw Object.assign(Error("Transfer binding failed"),{code:"STRIPE_RESULT_MISMATCH"});
  if (job.kind === "stripe_refund" && (!dispute || dispute.provider_mode !== config.paymentProviderMode || payload.paymentIntentId !== payment.payment_intent_id || payload.amountMinor !== dispute.approved_amount_minor)) throw Object.assign(Error("Refund binding failed"),{code:"STRIPE_RESULT_MISMATCH"});
  if (job.kind === "stripe_transfer_reversal") {
    const transfer = db.prepare("SELECT * FROM marketplace_operations WHERE order_id=? AND kind='merchant_transfer' AND provider_reference=? AND provider_mode=? AND status='confirmed'").get(order.id,payload.transferId,config.paymentProviderMode);
    if (!dispute || dispute.execution_status !== "confirmed" || !transfer) throw Object.assign(Error("Reversal binding failed"),{code:"STRIPE_RESULT_MISMATCH"});
    const reversed = db.prepare("SELECT COALESCE(SUM(amount_minor),0) n FROM marketplace_operations WHERE order_id=? AND kind='transfer_reversal' AND status='confirmed' AND operation_key<>?").get(order.id,job.operation_key).n;
    if (payload.amountMinor > transfer.amount_minor - reversed) throw Object.assign(Error("Reversal exceeds transferred funds"),{code:"STRIPE_RESULT_MISMATCH"});
  }
  return { order, payment, account, dispute };
}
function assertCurrentTransfer(db,config,payload,binding) {
  const order = db.prepare("SELECT * FROM orders WHERE id=?").get(binding.order.id), ready = accountReadiness(db,binding.account);
  const refunds = db.prepare("SELECT COALESCE(SUM(food_amount_minor+delivery_amount_minor),0) total,COALESCE(SUM(commission_reversal_minor),0) reversal FROM refunds WHERE order_id=?").get(order.id);
  const active = db.prepare("SELECT 1 FROM refund_cases WHERE order_id=? AND resolved_at IS NULL AND status NOT IN ('rejected','refunded')").get(order.id);
  const net = order.total_minor - refunds.total - Math.max(0,order.commission_minor-refunds.reversal);
  if (order.status !== "completed" || binding.payment.status !== "captured" || !ready?.charges_enabled || !ready?.payouts_enabled || active || payload.amountMinor !== net || payload.totalMinor !== order.total_minor || payload.policyVersion !== order.contract_policy_version) throw Object.assign(Error("Transfer snapshot is no longer eligible"),{code:"STRIPE_TRANSFER_INELIGIBLE"});
}
function assertCurrentRefund(db,payload,binding) {
  const dispute = db.prepare("SELECT * FROM refund_cases WHERE id=?").get(payload.caseId), refunded = db.prepare("SELECT COALESCE(SUM(food_amount_minor+delivery_amount_minor),0) n FROM refunds WHERE order_id=?").get(binding.order.id).n;
  if (!["approved","partially_approved","refund_processing","refund_failed"].includes(dispute.status) || dispute.execution_status === "confirmed" || payload.amountMinor > binding.order.total_minor-refunded) throw Object.assign(Error("Refund is no longer eligible"),{code:"STRIPE_REFUND_INELIGIBLE"});
}
function assertMovementResult(result,job,payload,binding) {
  let valid = result.amountMinor === payload.amountMinor && String(result.currency).toUpperCase() === "GBP" && Boolean(result.providerReference);
  if (job.kind === "stripe_transfer") valid &&= result.destinationAccountId === payload.accountId && result.sourceTransactionId === payload.sourceCharge && result.transferGroup === `order:${binding.order.id}`;
  else if (job.kind === "stripe_refund") valid &&= result.paymentIntentId === binding.payment.payment_intent_id && (!result.orderId || result.orderId === binding.order.id) && (!result.restaurantId || result.restaurantId === binding.order.restaurant_id);
  else valid &&= result.transferId === payload.transferId;
  if (!valid) throw Object.assign(Error("Provider result does not match operation"),{code:"STRIPE_RESULT_MISMATCH"});
}
function recordStripeMovement(db,op,debit,credit,stamp) {
  if (db.prepare("SELECT 1 FROM journal_postings WHERE operation_key=?").get(op.operation_key)) return;
  const group = randomUUID();
  for (const [account,direction] of [[debit,"debit"],[credit,"credit"]]) db.prepare("INSERT INTO journal_postings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(),group,op.operation_key,op.restaurant_id,op.order_id,account,direction,op.amount_minor,"GBP",op.kind,op.id,op.provider_mode,stamp);
}
async function reconcileStripeCosts(db,config,adapter,{limit}) {
  if (typeof adapter.retrievePayment !== "function") return;
  const rows = db.prepare("SELECT o.* FROM orders o JOIN stripe_order_payments p ON p.order_id=o.id WHERE p.provider_mode=? AND p.status='captured' AND p.provider_cost_minor IS NULL AND p.payment_intent_id IS NOT NULL AND o.status IN ('accepted','preparing','ready','out_for_delivery','completed') ORDER BY o.updated_at LIMIT ?").all(config.paymentProviderMode,limit);
  for (const order of rows) {
    try {
      const payment = db.prepare("SELECT * FROM stripe_order_payments WHERE order_id=?").get(order.id);
      const result = assertStripePaymentBinding(await adapter.retrievePayment({paymentIntentId:payment.payment_intent_id}),{order,payment});
      if (result.paymentState !== "captured" || !Number.isSafeInteger(result.providerCostMinor) || result.providerCostMinor < 0) continue;
      withTransaction(db,()=>{
        db.prepare("UPDATE stripe_order_payments SET provider_cost_minor=?,available_on=COALESCE(?,available_on),updated_at=? WHERE order_id=? AND provider_mode=?").run(result.providerCostMinor,result.availableOn ?? null,now(config),order.id,config.paymentProviderMode);
        recordMarketplaceAcceptance(db,order,now(config),config);
      });
    } catch { /* An unconfirmed fee remains pending; it cannot change customer or restaurant money. */ }
  }
}

async function expireCardOrders(db,config,adapter,{limit}) {
  const cutoff = new Date(config.now().getTime()-config.orderExpiryMinutes*60_000).toISOString();
  const rows = db.prepare("SELECT o.* FROM orders o JOIN stripe_order_payments p ON p.order_id=o.id WHERE o.payment_method='card' AND o.status='placed' AND o.created_at<=? AND p.provider_mode=? AND p.status IN ('pending','authorized','unknown','failed','expired','cancelled') ORDER BY o.created_at LIMIT ?").all(cutoff,config.paymentProviderMode,limit);
  for (const order of rows) {
    const owner = randomUUID(), stamp = now(config);
    const claimed = withTransaction(db,()=>{
      const decision = db.prepare("SELECT * FROM stripe_order_decisions WHERE order_id=?").get(order.id);
      if (decision?.state === "confirmed" && decision.desired_status === "accepted") return false;
      if (decision?.state === "claimed" && decision.lease_expires_at > stamp) return false;
      db.prepare("INSERT INTO stripe_order_decisions(order_id,desired_status,state,lease_owner,lease_expires_at,provider_mode,created_at,updated_at) VALUES(?,'rejected','claimed',?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET desired_status='rejected',state='claimed',lease_owner=excluded.lease_owner,lease_expires_at=excluded.lease_expires_at,provider_mode=excluded.provider_mode,provider_result=NULL,error=NULL,updated_at=excluded.updated_at").run(order.id,owner,new Date(config.now().getTime()+120_000).toISOString(),config.paymentProviderMode,stamp,stamp);
      return true;
    });
    if (!claimed) continue;
    try {
      const payment = db.prepare("SELECT * FROM stripe_order_payments WHERE order_id=?").get(order.id);
      let result = payment.checkout_session_id ? assertStripePaymentBinding(await adapter.retrieveCheckoutSession({sessionId:payment.checkout_session_id}),{order,payment}) : {paymentState:"expired"};
      if (!["captured","cancelled","expired"].includes(result.paymentState)) {
        if (result.paymentIntentId) await adapter.cancelPayment({paymentIntentId:result.paymentIntentId,idempotencyKey:`expire-card:${order.id}`});
        else if (typeof adapter.expireCheckoutSession === "function") await adapter.expireCheckoutSession({sessionId:payment.checkout_session_id,idempotencyKey:`expire-checkout:${order.id}`});
        result = assertStripePaymentBinding(await adapter.retrieveCheckoutSession({sessionId:payment.checkout_session_id}),{order,payment});
      }
      const state = result.paymentState;
      if (!["captured","cancelled","expired"].includes(state)) throw Object.assign(Error("Expiry not confirmed"),{code:"PAYMENT_EXPIRY_UNCONFIRMED"});
      withTransaction(db,()=>{
        const current = db.prepare("SELECT * FROM stripe_order_decisions WHERE order_id=? AND state='claimed' AND lease_owner=? AND lease_expires_at>?").get(order.id,owner,now(config));
        if (!current) return;
        db.prepare("UPDATE stripe_order_decisions SET desired_status=?,state='confirmed',lease_owner=NULL,lease_expires_at=NULL,provider_result=?,error=NULL,updated_at=? WHERE order_id=?").run(state === "captured" ? "accepted" : "rejected",JSON.stringify(result),now(config),order.id);
        db.prepare("UPDATE stripe_order_payments SET status=?,payment_intent_id=COALESCE(?,payment_intent_id),latest_charge_id=COALESCE(?,latest_charge_id),error=NULL,updated_at=? WHERE order_id=? AND status<>'captured'").run(state,result.paymentIntentId ?? null,result.latestChargeId ?? null,now(config),order.id);
        if (state === "captured") { db.prepare("UPDATE orders SET payment_status='stripe_captured',updated_at=? WHERE id=?").run(now(config),order.id); return; }
        const fresh = db.prepare("SELECT * FROM orders WHERE id=? AND status='placed'").get(order.id);
        if (!fresh) return;
        db.prepare("UPDATE orders SET status='rejected',payment_status=?,updated_at=? WHERE id=?").run(`stripe_${state}`,now(config),order.id);
        db.prepare("INSERT INTO order_events VALUES(?,?,NULL,'payment_expired','placed','rejected',?)").run(randomUUID(),order.id,now(config));
        releaseOfferForOrder(db,fresh,now(config));
        if(fresh.merchant_visible_at)notifyOrderStatus(db,{...fresh,status:"rejected"},"rejected",now(config),"order_expired");
      });
    } catch (error) {
      const code = safeProviderError(error?.code) ?? "PAYMENT_EXPIRY_UNCONFIRMED";
      withTransaction(db,()=>{
        db.prepare("UPDATE stripe_order_decisions SET state='unknown',lease_owner=NULL,lease_expires_at=NULL,error=?,updated_at=? WHERE order_id=? AND state='claimed' AND lease_owner=?").run(code,now(config),order.id,owner);
        db.prepare("UPDATE stripe_order_payments SET error=?,updated_at=? WHERE order_id=? AND status<>'captured'").run(code,now(config),order.id);
      });
    }
  }
}

function safeProviderError(value){return typeof value==="string"&&/^[A-Z0-9_]{1,80}$/i.test(value)?value:null;}
function recordAccountReadiness(db,{restaurantId,mode,accountId,result,stamp}){const charges=Boolean(result?.chargesEnabled),payouts=Boolean(result?.payoutsEnabled);db.prepare("INSERT INTO stripe_account_readiness(restaurant_id,provider_mode,provider_account_id,charges_enabled,payouts_enabled,verified_at) VALUES(?,?,?,?,?,?) ON CONFLICT(restaurant_id,provider_mode) DO UPDATE SET provider_account_id=excluded.provider_account_id,charges_enabled=excluded.charges_enabled,payouts_enabled=excluded.payouts_enabled,verified_at=excluded.verified_at").run(restaurantId,mode,accountId,charges?1:0,payouts?1:0,stamp);return{charges,payouts};}
