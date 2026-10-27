import { randomUUID } from "node:crypto";
import { withTransaction } from "../db/index.js";
import { HttpError } from "../http.js";
import { assertStripePaymentBinding, ensureStripePlatform } from "./stripe-connect.js";

export { STRIPE_TRANSITION_SQL } from "./stripe-transitions-schema.js";

const adapterFor = (config) => config.stripeProvider ?? config.paymentProvider;
const safeError = (value) => typeof value === "string" && /^[A-Z0-9_]{1,80}$/i.test(value) ? value : "PROVIDER_RESULT_UNKNOWN";

export async function prepareStripeOrderTransition(db, config, { orderId, userId, targetStatus }) {
  if (!['accepted', 'rejected'].includes(targetStatus)) throw new TypeError("Stripe order target is invalid");
  const stamp = config.now().toISOString();
  const leaseOwner = randomUUID();
  const leaseExpiresAt = new Date(config.now().getTime() + 120_000).toISOString();
  const claimed = withTransaction(db, () => {
    const order = db.prepare("SELECT * FROM orders WHERE id=? AND payment_method='card'").get(orderId);
    const membership = order && db.prepare("SELECT 1 FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?").get(order.restaurant_id, userId);
    if (!order || !membership) throw new HttpError(404, "NOT_FOUND", "Resource not found");
    const existing = db.prepare("SELECT * FROM stripe_order_decisions WHERE order_id=?").get(orderId);
    const payment = db.prepare("SELECT provider_mode FROM stripe_order_payments WHERE order_id=?").get(orderId);
    if (payment?.provider_mode !== config.paymentProviderMode || (existing && existing.provider_mode !== config.paymentProviderMode)) throw new HttpError(409,"STRIPE_MODE_MISMATCH","Payment belongs to another provider mode");
    if (order.status !== "placed" && order.status !== targetStatus && existing?.state !== "confirmed") throw new HttpError(409,"INVALID_TRANSITION","Order status transition is not allowed");
    if (targetStatus === "accepted" && order.status === "placed" && !db.prepare("SELECT 1 FROM restaurants WHERE id=? AND status='approved' AND suspended=0").get(order.restaurant_id)) throw new HttpError(409,"RESTAURANT_UNAVAILABLE","Restaurant cannot accept orders");
    if (existing?.desired_status !== undefined && existing.desired_status !== targetStatus && existing.state !== "unknown") throw new HttpError(409, "ORDER_DECISION_CONFLICT", "The opposing order decision is already in progress");
    if (existing?.state === "confirmed") return { replay: JSON.parse(existing.provider_result), order };
    if (existing?.state === "claimed" && existing.lease_expires_at > stamp) throw new HttpError(409, "ORDER_DECISION_IN_PROGRESS", "This order decision is already in progress");
    if (existing) {
      const result = db.prepare("UPDATE stripe_order_decisions SET desired_status=?,state='claimed',lease_owner=?,lease_expires_at=?,provider_mode=?,provider_result=NULL,error=NULL,updated_at=? WHERE order_id=? AND (state='unknown' OR (desired_status=? AND lease_expires_at<=?))").run(targetStatus, leaseOwner, leaseExpiresAt, config.paymentProviderMode, stamp, orderId, targetStatus, stamp);
      if (result.changes !== 1) throw new HttpError(409, "ORDER_DECISION_IN_PROGRESS", "This order decision is already in progress");
    } else db.prepare("INSERT INTO stripe_order_decisions(order_id,desired_status,state,lease_owner,lease_expires_at,provider_mode,created_at,updated_at) VALUES(?,?,'claimed',?,?,?,?,?)").run(orderId, targetStatus, leaseOwner, leaseExpiresAt, config.paymentProviderMode, stamp, stamp);
    return { order };
  });
  if (claimed.replay) return claimed.replay;

  try {
    await ensureStripePlatform(config);
    const adapter = adapterFor(config);
    const payment = db.prepare("SELECT * FROM stripe_order_payments WHERE order_id=?").get(orderId);
    if (!adapter || !payment?.payment_intent_id || !payment.checkout_session_id || typeof adapter.retrieveCheckoutSession !== "function" || typeof adapter.retrievePayment !== "function") throw new HttpError(409, "PAYMENT_NOT_AUTHORIZED", "Card payment authorization is required");
    const bind = (result) => assertStripePaymentBinding(result, { order: claimed.order, payment });
    let authoritative = bind(await adapter.retrieveCheckoutSession({ sessionId: payment.checkout_session_id }));
    if (targetStatus === "accepted") {
      if (authoritative.paymentState !== "captured") {
        if (authoritative.paymentState !== "authorized") throw new HttpError(409, "PAYMENT_NOT_AUTHORIZED", "Card payment authorization is required");
        await adapter.capturePayment({ paymentIntentId: payment.payment_intent_id, amountMinor: claimed.order.total_minor, idempotencyKey: `capture:${orderId}` });
        authoritative = bind(await adapter.retrievePayment({ paymentIntentId: payment.payment_intent_id }));
      }
      if (authoritative.paymentState !== "captured") throw new HttpError(409, "PAYMENT_CAPTURE_UNKNOWN", "Card capture needs authoritative reconciliation");
    } else {
      if (authoritative.paymentState === "captured") throw new HttpError(409, "PAYMENT_CAPTURED_RECONCILE", "Captured payment must be reconciled before rejection");
      if (authoritative.paymentState !== "cancelled") {
        await adapter.cancelPayment({ paymentIntentId: payment.payment_intent_id, idempotencyKey: `cancel:${orderId}` });
        authoritative = bind(await adapter.retrievePayment({ paymentIntentId: payment.payment_intent_id }));
      }
      if (authoritative.paymentState !== "cancelled") throw new HttpError(409, "PAYMENT_CANCEL_UNKNOWN", "Card payment cancellation needs authoritative reconciliation");
    }
    const serialized = JSON.stringify(authoritative);
    withTransaction(db, () => {
      const result = db.prepare("UPDATE stripe_order_decisions SET state='confirmed',lease_owner=NULL,lease_expires_at=NULL,provider_result=?,error=NULL,updated_at=? WHERE order_id=? AND desired_status=? AND state='claimed' AND lease_owner=? AND lease_expires_at>?").run(serialized, config.now().toISOString(), orderId, targetStatus, leaseOwner, config.now().toISOString());
      if (result.changes !== 1) throw new HttpError(409, "ORDER_DECISION_LEASE_LOST", "The order decision must be retried");
    });
    return authoritative;
  } catch (error) {
    db.prepare("UPDATE stripe_order_decisions SET state='unknown',lease_owner=NULL,lease_expires_at=NULL,error=?,updated_at=? WHERE order_id=? AND state='claimed' AND lease_owner=?").run(safeError(error?.code), config.now().toISOString(), orderId, leaseOwner);
    throw error;
  }
}
