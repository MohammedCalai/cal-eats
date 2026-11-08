import { HttpError } from "./http.js";

const known = new Set(["local_simulator", "stripe_test", "stripe_live"]);

export function financialEnvironmentScope(config) {
  return config?.paymentProviderMode === "stripe_live" ? "live" : "testing";
}

// Fixed SQL literals only. The caller supplies a validated table alias, never
// customer data. Missing or unproven legacy provenance can never enter live.
export function orderEnvironmentPredicate(alias, scope) {
  if (typeof alias !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias) || !["live", "testing"].includes(scope)) throw new TypeError("A valid order alias and financial scope are required");
  const live = `EXISTS(SELECT 1 FROM order_financial_environments fe WHERE fe.order_id=${alias}.id AND fe.environment='stripe_live')`;
  return scope === "live" ? live : `NOT ${live}`;
}

export function orderFinancialEnvironment(db, orderId) {
  return db.prepare("SELECT environment FROM order_financial_environments WHERE order_id=?").get(orderId)?.environment ?? "unknown";
}

// Called only after the scoped Stripe adapter has verified the platform and
// payout response, inside the same transaction as its bound payout-row upsert.
// No existing payout or current provider-account binding is backfilled as proof.
export function recordVerifiedPayoutApiRead(db, config, { restaurantId, accountId, payoutId, amountMinor, currency, verifiedAt }) {
  const mode = config?.paymentProviderMode, adapter = config?.stripeProvider ?? config?.paymentProvider;
  const platformId = config?.stripePlatformAccountId;
  const reference = (value, prefix) => typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_]{1,200}$`).test(value);
  const fail = () => { throw new HttpError(409,"STRIPE_PAYOUT_PROVENANCE_MISMATCH","Verified payout details do not match their stored payment environment"); };
  if (!["stripe_test","stripe_live"].includes(mode) || adapter?.mode !== mode || !reference(platformId,"acct") || !reference(accountId,"acct") || !reference(payoutId,"po") || typeof restaurantId !== "string" || !restaurantId || restaurantId.length > 100 || !Number.isSafeInteger(amountMinor) || amountMinor < 0 || currency !== "GBP" || typeof verifiedAt !== "string" || !Number.isFinite(Date.parse(verifiedAt))) fail();
  const payout = db.prepare("SELECT * FROM stripe_connected_payouts WHERE id=?").get(payoutId);
  if (!payout || payout.restaurant_id !== restaurantId || payout.provider_account_id !== accountId || payout.amount_minor !== amountMinor) fail();
  const signed = db.prepare("SELECT provider,restaurant_id,provider_account_reference FROM provider_events WHERE object_id=? AND object_type='payout' AND event_type LIKE 'payout.%' AND status='completed' AND error IS NULL").all(payoutId);
  if (signed.some(event => event.provider !== mode || event.restaurant_id !== restaurantId || event.provider_account_reference !== accountId)) fail();
  const wanted = { payout_id:payoutId, restaurant_id:restaurantId, provider_mode:mode, provider_account_id:accountId, platform_account_id:platformId, amount_minor:amountMinor, currency, source:"stripe_payouts_api_read" };
  const existing = db.prepare("SELECT * FROM stripe_payout_api_provenance WHERE payout_id=?").get(payoutId);
  if (existing) {
    if (Object.entries(wanted).some(([key,value]) => existing[key] !== value)) fail();
    return { ...existing, created:false };
  }
  db.prepare("INSERT INTO stripe_payout_api_provenance(payout_id,restaurant_id,provider_mode,provider_account_id,platform_account_id,amount_minor,currency,source,verified_at) VALUES(?,?,?,?,?,?,?,?,?)").run(...Object.values(wanted),new Date(verifiedAt).toISOString());
  return { ...wanted, verified_at:new Date(verifiedAt).toISOString(), created:true };
}

// Called inside the new-order INSERT transaction. No retry or mode switch can
// rewrite the financial environment saved when an order was first created.
export function recordOrderFinancialEnvironment(db, order, config, recordedAt = order.created_at) {
  const environment = config?.paymentProviderMode;
  if (!known.has(environment)) throw new Error("New orders require a known financial environment");
  const old = db.prepare("SELECT environment FROM order_financial_environments WHERE order_id=?").get(order.id);
  if (old) {
    if (old.environment !== environment) throw new Error("An order's financial environment cannot be changed");
    return environment;
  }
  db.prepare("INSERT INTO order_financial_environments(order_id,environment,provenance,source_reference,recorded_at) VALUES(?,?,'order_created',NULL,?)").run(order.id, environment, recordedAt);
  return environment;
}

// Freeze cross-environment and unproven order actions instead of inventing a
// live capture, commission, cash sale or settlement for a historical order.
export function requireOrderFinancialEnvironment(db, order, config) {
  const environment = orderFinancialEnvironment(db, order.id);
  if (!known.has(environment)) throw new HttpError(409, "ORDER_FINANCIAL_ENVIRONMENT_UNPROVEN", "This historical order needs a financial-history review before its status can change.");
  if ((environment === "stripe_live") !== (financialEnvironmentScope(config) === "live")) throw new HttpError(409, "ORDER_FINANCIAL_ENVIRONMENT_MISMATCH", "This order belongs to a different payment environment and cannot be actioned here.");
  if (order.payment_method === "card") {
    const payment = db.prepare("SELECT provider_mode FROM stripe_order_payments WHERE order_id=?").get(order.id);
    if (!payment || payment.provider_mode !== environment) throw new HttpError(409, "ORDER_FINANCIAL_ENVIRONMENT_MISMATCH", "The order's saved card-payment environment could not be verified.");
  }
  return environment;
}
