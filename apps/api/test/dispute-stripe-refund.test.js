import assert from "node:assert/strict";
import test from "node:test";
import { journeyFixture } from "./helpers.js";

test("accepted restaurant card-refund proposal queues Stripe execution without an instant refund", async () => {
  const f = await journeyFixture();
  try {
    const customer = await f.login("customer@calai.local", "LocalCustomer!4310");
    const owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310");
    const restaurant = (await f.json("/api/restaurants")).body.data.find((item) => item.name === "Calai Kitchen");
    const item = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
    const placed = await f.json("/api/orders", { method: "POST", cookie: customer, headers: { "Idempotency-Key": "stripe-dispute-order" }, body: { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], paymentMethod: "mock_card", fulfillment: "collection" } });
    assert.equal(placed.status, 201, placed.text);
    const order = placed.body.data;
    f.db.prepare("UPDATE orders SET payment_method='card',payment_status='stripe_captured' WHERE id=?").run(order.id);
    f.db.prepare("INSERT INTO stripe_order_payments(order_id,provider_mode,checkout_session_id,payment_intent_id,latest_charge_id,status,created_at,updated_at) VALUES(?,?,?,?,?,'captured',?,?)").run(order.id, "stripe_test", `cs_${order.id}`, `pi_${order.id}`, `ch_${order.id}`, f.config.now().toISOString(), f.config.now().toISOString());

    const dispute = (await f.json("/api/refund-cases", { method: "POST", cookie: customer, body: { orderId: order.id, reason: "incorrect_items", itemIds: [order.items[0].id], description: "Wrong item" } })).body.data;
    const proposal = (await f.json(`/api/restaurant/restaurants/${restaurant.id}/refund-cases/${dispute.id}/proposals`, { method: "POST", cookie: owner, headers: { "Idempotency-Key": "stripe-refund-proposal" }, body: { type: "partial_refund", amountMinor: 100, itemIds: [order.items[0].id], description: "Refund affected item" } })).body.data;
    const accepted = await f.json(`/api/refund-cases/${dispute.id}/proposals/${proposal.id}/respond`, { method: "POST", cookie: customer, headers: { "Idempotency-Key": "accept-stripe-refund" }, body: { decision: "accept" } });
    assert.equal(accepted.status, 200, accepted.text);

    const job = f.db.prepare("SELECT kind,operation_key,payload FROM marketplace_worker_jobs WHERE entity_id=?").get(dispute.id);
    assert.equal(job.kind, "stripe_refund");
    assert.equal(job.operation_key, `refund-case:${dispute.id}:stripe`);
    assert.deepEqual(JSON.parse(job.payload), { caseId: dispute.id, paymentIntentId: `pi_${order.id}`, amountMinor: 100, operationKey: job.operation_key, idempotencyKey: job.operation_key });
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM marketplace_worker_jobs WHERE entity_id=? AND kind='refund_execution'").get(dispute.id).n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM refunds WHERE order_id=?").get(order.id).n, 0);
    const stored = f.db.prepare("SELECT execution_status,provider_mode FROM refund_cases WHERE id=?").get(dispute.id);
    assert.equal(stored.execution_status, "queued");
    assert.equal(stored.provider_mode, "stripe_test");
  } finally { await f.close(); }
});
