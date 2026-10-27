import test from "node:test";
import assert from "node:assert/strict";
import { journeyFixture } from "./helpers.js";

test("Stripe checkout, refresh, capture and owner onboarding remain authoritative and idempotent", async () => {
  let checkoutCalls = 0, captureCalls = 0, checkoutState = "pending";
  const paymentFacts = (order, state = checkoutState) => ({
    status: "confirmed", paymentState: state, providerReference: "cs_fixture",
    paymentIntentId: state === "pending" ? null : "pi_fixture", latestChargeId: state === "captured" ? "ch_fixture" : null,
    amountMinor: order.total_minor, currency: "GBP", captureMethod: state === "pending" ? null : "manual",
    orderId: order.id, restaurantId: order.restaurant_id,
  });
  let currentOrder;
  const provider = {
    mode: "stripe_test",
    retrievePlatformAccount: async () => ({ status: "confirmed", providerReference: "acct_platform", mode: "stripe_test" }),
    createCheckoutSession: async ({ orderId, restaurantId, amountMinor }) => {
      checkoutCalls += 1;
      return { status: "confirmed", paymentState: "pending", providerReference: "cs_fixture", checkoutUrl: "https://checkout.stripe.com/c/pay/cs_fixture", paymentIntentId: null, amountMinor, currency: "GBP", orderId, restaurantId };
    },
    retrieveCheckoutSession: async () => paymentFacts(currentOrder),
    capturePayment: async () => { captureCalls += 1; checkoutState = "captured"; return paymentFacts(currentOrder, "captured"); },
    retrievePayment: async () => paymentFacts(currentOrder),
    createConnectedAccount: async () => ({ status: "pending", providerReference: "acct_restaurant", chargesEnabled: false, payoutsEnabled: false, capabilities: [], requirements: ["details_submitted"] }),
    refreshConnectedAccount: async () => ({status:"confirmed",providerReference:"acct_restaurant",chargesEnabled:true,payoutsEnabled:true,capabilities:["card_payments","transfers"],requirements:[]}),
    configureWeeklyPayouts: async () => ({ status: "confirmed" }),
    createAccountLink: async () => ({ status: "confirmed", actionUrl: "https://connect.stripe.com/setup/s/acct_restaurant", expiresAt: "2026-01-02T00:00:00.000Z" }),
    createAccountLoginLink: async () => ({ status: "confirmed", actionUrl: "https://connect.stripe.com/express/acct_restaurant" }),
  };
  const f = await journeyFixture({ paymentProviderMode: "stripe_test", paymentProvider: provider, stripePlatformAccountId: "acct_platform", paymentProviderWebhookSecret: "whsec_platform_fixture", paymentProviderConnectWebhookSecret: "whsec_connect_fixture" });
  try {
    const customer = await f.login("customer@calai.local", "LocalCustomer!4310");
    const owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310");
    const restaurant = (await f.json("/api/restaurants")).body.data.find((entry) => entry.name === "Calai Kitchen");
    const item = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];

    const initialFinance = await f.json(`/api/restaurant/restaurants/${restaurant.id}/finance/stripe`, { cookie: owner });
    assert.equal(initialFinance.status, 200, initialFinance.text);
    assert.equal(initialFinance.body.data.account.status, "not_started");
    const onboarding = await f.json(`/api/restaurant/restaurants/${restaurant.id}/finance/stripe/onboarding`, { method: "POST", cookie: owner, headers: { "Idempotency-Key": "owner-onboarding" }, body: {} });
    assert.equal(onboarding.status, 200, onboarding.text);
    const finance = await f.json(`/api/restaurant/restaurants/${restaurant.id}/finance/stripe`, { cookie: owner });
    assert.equal(finance.body.data.account.status, "pending");
    assert.equal(finance.body.data.account.chargesEnabled, false);
    assert.equal(finance.body.data.account.payoutsEnabled, false);
    const verified = await f.json(`/api/restaurant/restaurants/${restaurant.id}/finance/stripe/refresh`, {method:"POST",cookie:owner,body:{}});
    assert.equal(verified.body.data.account.chargesEnabled,true);

    const mock = await f.json("/api/orders", { method: "POST", cookie: customer, headers: { "Idempotency-Key": "stripe-mock-rejected" }, body: { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], paymentMethod: "mock_card", fulfillment: "collection" } });
    assert.equal(mock.status, 409);
    assert.equal(mock.body.error.code, "MOCK_PAYMENT_DISABLED");

    const placed = await f.json("/api/orders", { method: "POST", cookie: customer, headers: { "Idempotency-Key": "stripe-card-order" }, body: { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], paymentMethod: "card", fulfillment: "collection" } });
    assert.equal(placed.status, 201, placed.text);
    currentOrder = f.db.prepare("SELECT * FROM orders WHERE id=?").get(placed.body.data.id);
    assert.equal((await f.json(`/api/restaurant/restaurants/${restaurant.id}/orders`,{cookie:owner})).body.data.some(order=>order.id===currentOrder.id),false);

    const checkout = await f.json(`/api/orders/${currentOrder.id}/checkout`, { method: "POST", cookie: customer, headers: { "Idempotency-Key": "client-checkout-one" }, body: {} });
    assert.equal(checkout.status, 200, checkout.text);
    assert.equal(f.db.prepare("SELECT checkout_session_id FROM stripe_order_payments WHERE order_id=?").get(currentOrder.id).checkout_session_id, "cs_fixture");
    const replay = await f.json(`/api/orders/${currentOrder.id}/checkout`, { method: "POST", cookie: customer, headers: { "Idempotency-Key": "client-checkout-two" }, body: {} });
    assert.equal(replay.status, 200, replay.text);
    assert.equal(checkoutCalls, 1);

    const pending = await f.json(`/api/orders/${currentOrder.id}/payment/refresh`, { method: "POST", cookie: customer, body: {} });
    assert.equal(pending.status, 200, pending.text);
    assert.equal(pending.body.data.status, "pending");
    checkoutState = "authorized";
    const authorized = await f.json(`/api/orders/${currentOrder.id}/payment/refresh`, { method: "POST", cookie: customer, body: {} });
    assert.equal(authorized.status, 200, authorized.text);
    assert.equal(authorized.body.data.status, "authorized");
    assert.equal((await f.json(`/api/restaurant/restaurants/${restaurant.id}/orders`,{cookie:owner})).body.data.some(order=>order.id===currentOrder.id),true);

    const accepted = await f.json(`/api/restaurant/orders/${currentOrder.id}/status`, { method: "PATCH", cookie: owner, body: { status: "accepted" } });
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal(captureCalls, 1);
    const duplicate = await f.json(`/api/restaurant/orders/${currentOrder.id}/status`, { method: "PATCH", cookie: owner, body: { status: "accepted" } });
    assert.equal(duplicate.status, 200, duplicate.text);
    assert.equal(captureCalls, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM marketplace_worker_jobs WHERE kind='stripe_transfer'").get().n, 0);

    const dashboard = await f.json(`/api/restaurant/restaurants/${restaurant.id}/finance/stripe/dashboard`, { method: "POST", cookie: owner, headers: { "Idempotency-Key": "owner-dashboard" }, body: {} });
    assert.equal(dashboard.status, 200, dashboard.text);
    assert.match(dashboard.body.data.url, /^https:\/\/connect\.stripe\.com\//);
  } finally { await f.close(); }
});
