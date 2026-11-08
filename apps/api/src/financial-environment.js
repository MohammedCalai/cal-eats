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
