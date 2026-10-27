import test from "node:test";
import assert from "node:assert/strict";
import { migrateDatabase, openDatabase } from "../src/db/index.js";
import { prepareStripeOrderTransition, STRIPE_TRANSITION_SQL } from "../src/payments/stripe-transitions.js";

const stamp = "2026-10-27T12:00:00.000Z";
const facts = (paymentState) => ({ status: "confirmed", paymentState, providerReference: "pi_fixture", paymentIntentId: "pi_fixture", amountMinor: 2000, currency: "gbp", captureMethod: "manual", orderId: "order", restaurantId: "restaurant", latestChargeId: paymentState === "captured" ? "ch_fixture" : null });

function fixture(adapter) {
  const db = openDatabase(":memory:");
  migrateDatabase(db);
  db.exec(STRIPE_TRANSITION_SQL);
  db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES('customer','Customer','customer@example.invalid','unused','customer',?),('owner','Owner','owner@example.invalid','unused','restaurant',?)").run(stamp, stamp);
  db.prepare("INSERT INTO restaurants(id,name,status,created_at) VALUES('restaurant','Kitchen','approved',?)").run(stamp);
  db.prepare("INSERT INTO restaurant_memberships(user_id,restaurant_id,permission,created_at) VALUES('owner','restaurant','owner',?)").run(stamp);
  db.prepare(`INSERT INTO orders(id,restaurant_id,restaurant_name,customer_id,status,subtotal_minor,delivery_fee_minor,total_minor,commission_minor,payment_method,payment_status,fulfillment,idempotency_key,request_hash,created_at,updated_at)
    VALUES('order','restaurant','Kitchen','customer','placed',2000,0,2000,140,'card','stripe_authorized','collection','fixture','fixture',?,?)`).run(stamp, stamp);
  db.prepare("INSERT INTO stripe_order_payments(order_id,provider_mode,checkout_session_id,payment_intent_id,status,created_at,updated_at) VALUES('order','stripe_test','cs_fixture','pi_fixture','authorized',?,?)").run(stamp, stamp);
  const config = { paymentProviderMode: "stripe_test", stripePlatformAccountId: "acct_platform", paymentProviderWebhookSecret: "whsec_platform", paymentProviderConnectWebhookSecret: "whsec_connect", stripeProvider: adapter, now: () => new Date(stamp) };
  return { db, config };
}

test("an acceptance claim serializes an opposing rejection", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const adapter = {
    retrievePlatformAccount: async () => ({ providerReference: "acct_platform", status: "confirmed" }),
    retrieveCheckoutSession: async () => { await gate; return facts("captured"); },
    retrievePayment: async () => facts("captured"),
  };
  const { db, config } = fixture(adapter);
  try {
    const accepting = prepareStripeOrderTransition(db, config, { orderId: "order", userId: "owner", targetStatus: "accepted" });
    await Promise.resolve();
    await assert.rejects(prepareStripeOrderTransition(db, config, { orderId: "order", userId: "owner", targetStatus: "rejected" }), (error) => error.code === "ORDER_DECISION_CONFLICT");
    release();
    assert.equal((await accepting).paymentState, "captured");
  } finally { db.close(); }
});

test("capture timeout is recovered authoritatively without a second capture", async () => {
  let captured = false, captureCalls = 0;
  const adapter = {
    retrievePlatformAccount: async () => ({ providerReference: "acct_platform", status: "confirmed" }),
    retrieveCheckoutSession: async () => facts(captured ? "captured" : "authorized"),
    capturePayment: async () => { captureCalls += 1; captured = true; throw Object.assign(Error("timeout"), { code: "PROVIDER_TIMEOUT" }); },
    retrievePayment: async () => facts(captured ? "captured" : "authorized"),
  };
  const { db, config } = fixture(adapter);
  try {
    await assert.rejects(prepareStripeOrderTransition(db, config, { orderId: "order", userId: "owner", targetStatus: "accepted" }));
    const recovered = await prepareStripeOrderTransition(db, config, { orderId: "order", userId: "owner", targetStatus: "accepted" });
    assert.equal(recovered.paymentState, "captured");
    assert.equal(captureCalls, 1);
    assert.equal(db.prepare("SELECT state FROM stripe_order_decisions WHERE order_id='order'").get().state, "confirmed");
  } finally { db.close(); }
});

test("a failed cancellation never confirms rejection", async () => {
  const adapter = {
    retrievePlatformAccount: async () => ({ providerReference: "acct_platform", status: "confirmed" }),
    retrieveCheckoutSession: async () => facts("authorized"),
    cancelPayment: async () => ({ status: "failed", paymentState: "authorized" }),
    retrievePayment: async () => facts("authorized"),
  };
  const { db, config } = fixture(adapter);
  try {
    await assert.rejects(prepareStripeOrderTransition(db, config, { orderId: "order", userId: "owner", targetStatus: "rejected" }), (error) => error.code === "PAYMENT_CANCEL_UNKNOWN");
    assert.equal(db.prepare("SELECT state FROM stripe_order_decisions WHERE order_id='order'").get().state, "unknown");
  } finally { db.close(); }
});

test("a confirmed duplicate decision replays without provider I/O", async () => {
  let retrieves = 0;
  const adapter = {
    retrievePlatformAccount: async () => ({ providerReference: "acct_platform", status: "confirmed" }),
    retrieveCheckoutSession: async () => { retrieves += 1; return facts("captured"); },
    retrievePayment: async () => facts("captured"),
  };
  const { db, config } = fixture(adapter);
  try {
    await prepareStripeOrderTransition(db, config, { orderId: "order", userId: "owner", targetStatus: "accepted" });
    await prepareStripeOrderTransition(db, config, { orderId: "order", userId: "owner", targetStatus: "accepted" });
    assert.equal(retrieves, 1);
  } finally { db.close(); }
});
