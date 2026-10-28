import assert from "node:assert/strict";
import test from "node:test";
import { journeyFixture } from "./helpers.js";
import { createCheckoutAttempt } from "../../web/checkout-attempt.js";

test("shared browser/native checkout attempt recovers a lost response unchanged after prices and delivery fees change", async () => {
  const f = await journeyFixture();
  try {
    const owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310"), customer = await f.login("customer@calai.local", "LocalCustomer!4310");
    const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0], root = `/api/restaurant/restaurants/${restaurant.id}`;
    const item = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items.find(row => row.priceMinor >= 1000);
    const delivery = { enabled: true, outcodes: ["N1"], deliveryFeeMinor: 250, minDeliverySubtotalMinor: 1000 };
    await f.json(`${root}/delivery`, { method: "PATCH", cookie: owner, body: delivery });
    const basket = { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], fulfillment: "delivery", deliveryAddress: { line1: "1 Fictional Test Road", city: "London", postcode: "N1 1AA" } };
    const price = async () => { const result = await f.json("/api/orders/quote", { method: "POST", cookie: customer, body: basket }); assert.equal(result.status, 200, result.text); return result.body.data.totalMinor; };
    const body = { ...basket, paymentMethod: "mock_card", expectedTotalMinor: await price() };
    let keys = 0, lost = true, firstId;
    const attempt = createCheckoutAttempt(() => `client-recovery-${++keys}`), sent = [];
    const count = () => f.db.prepare("SELECT COUNT(*) AS n FROM orders").get().n, before = count();
    async function send(record) {
      sent.push(record.serializedBody);
      const response = await f.json("/api/orders", { method: "POST", cookie: customer, headers: { "Idempotency-Key": record.key }, body: JSON.parse(record.serializedBody) });
      if (response.status >= 400) { const error = new Error(response.body.error.message); error.status = response.status; error.code = response.body.error.code; throw error; }
      if (lost) { lost = false; firstId = response.body.data.id; const error = new Error("Simulated lost response after commit"); error.status = 0; error.code = "TIMEOUT"; throw error; }
      return response.body.data;
    }
    await assert.rejects(attempt.submit(body, send), /lost response/);
    assert.ok(attempt.pending); assert.equal(count(), before + 1);
    await f.json(`${root}/menu/${item.id}`, { method: "PATCH", cookie: owner, body: { priceMinor: item.priceMinor + 400 } });
    await f.json(`${root}/delivery`, { method: "PATCH", cookie: owner, body: { ...delivery, deliveryFeeMinor: 500 } });
    const changed = { ...body, expectedTotalMinor: await price(), deliveryAddress: { ...body.deliveryAddress, line1: "Changed after timeout" } };
    await assert.rejects(attempt.submit(changed, async record => {
      const denied = await f.json("/api/orders", { method: "POST", headers: { "Idempotency-Key": record.key }, body: JSON.parse(record.serializedBody) });
      assert.equal(denied.status, 401);
      throw Object.assign(new Error(denied.body.error.message), { status: denied.status, code: denied.body.error.code });
    }));
    assert.equal(attempt.pending.key, "client-recovery-1", "An expired session on retry must not discard a potentially committed order");
    await assert.rejects(attempt.submit(changed, async () => { throw Object.assign(new Error("Retry throttled before lookup"), { status: 429, code: "RATE_LIMITED" }); }));
    assert.equal(attempt.pending.key, "client-recovery-1"); assert.equal(count(), before + 1);
    const recovered = await attempt.submit(changed, send);
    assert.equal(recovered.id, firstId); assert.equal(recovered.totalMinor, body.expectedTotalMinor);
    assert.equal(recovered.deliveryAddress.line1, body.deliveryAddress.line1);
    assert.equal(sent[0], sent[1], "A retry must preserve the exact serialized request, including reviewed total");
    assert.equal(keys, 1); assert.equal(count(), before + 1); assert.equal(attempt.pending, null);
    await assert.rejects(attempt.submit(body, send), error => error.code === "PRICE_CHANGED");
    assert.equal(attempt.pending, null, "A definite no-order response allows a fresh review");
    const next = await attempt.submit({ ...body, expectedTotalMinor: await price() }, send);
    assert.notEqual(next.id, firstId); assert.equal(count(), before + 2);
  } finally { await f.close(); }
});

test("checkout ambiguity, conflicts and malformed responses retain recovery while duplicate presses share the in-flight request", async () => {
  let keys = 0, calls = 0;
  const attempt = createCheckoutAttempt(() => `uncertain-${++keys}`);
  for (const failure of [{ status: 500, code: "INTERNAL_ERROR" }, { status: 409, code: "IDEMPOTENCY_CONFLICT" }]) {
    await assert.rejects(attempt.submit({ expectedTotalMinor: 1200 }, async () => { throw Object.assign(new Error(failure.code), failure); }));
    assert.equal(attempt.pending.key, "uncertain-1");
  }
  await assert.rejects(attempt.submit({ expectedTotalMinor: 1500 }, async () => null), error => error.code === "MALFORMED_RESPONSE");
  assert.equal(attempt.pending.key, "uncertain-1");
  let finish;
  const first = attempt.submit(null, () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const second = attempt.submit({ expectedTotalMinor: 9999 }, async () => { calls++; return { id: "duplicate" }; });
  await Promise.resolve(); finish({ id: "recovered" });
  assert.equal((await first).id, "recovered"); assert.equal((await second).id, "recovered");
  assert.equal(calls, 1); assert.equal(keys, 1); assert.equal(attempt.pending, null);
});
