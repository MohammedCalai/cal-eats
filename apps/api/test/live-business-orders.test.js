import assert from "node:assert/strict";
import test from "node:test";
import { journeyFixture } from "./helpers.js";

test("live kitchen counts follow paid/visible placed orders through handover, across periods and restaurant roles", async () => {
  const f = await journeyFixture({ now: () => new Date("2026-10-29T12:00:00.000Z") });
  try {
    const owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310"), customer = await f.login("customer@calai.local", "LocalCustomer!4310"), other = await f.login("restaurant2@calai.local", "LocalRestaurant2!4310");
    const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0], item = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
    const root = `/api/restaurant/restaurants/${restaurant.id}`;
    const read = async period => { const r = await f.json(`${root}/dashboard?period=${period || "today"}`, { cookie: owner }); assert.equal(r.status, 200, r.text); return r.body.data; };
    const place = async (key, fulfillment) => { const r = await f.json("/api/orders", { method: "POST", cookie: customer, headers: { "Idempotency-Key": key }, body: { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], paymentMethod: "cash", fulfillment, ...(fulfillment === "delivery" ? { deliveryAddress: { line1: "10 Fictional Demo Street", city: "Luton", postcode: "LU1 2AB" } } : {}) } }); assert.equal(r.status, 201, r.text); return r.body.data.id; };
    const delivery = await place("live-delivery", "delivery");
    assert.equal((await read()).operations.liveOrders, 1);
    f.db.prepare("UPDATE orders SET created_at='2026-10-20T12:00:00.000Z' WHERE id=?").run(delivery);
    assert.equal((await read("yesterday")).operations.liveOrders, 1);
    async function status(id, status) { const r = await f.json(`/api/restaurant/orders/${id}/status`, { method: "PATCH", cookie: owner, body: { status } }); assert.equal(r.status, 200, r.text); }
    for (const next of ["accepted", "preparing", "ready"]) { await status(delivery, next); const data = (await read()).operations; assert.equal(data.liveOrders, 1); assert.equal(data.readyForHandover, next === "ready" ? 1 : 0); }
    await status(delivery, "out_for_delivery");
    assert.equal((await read()).operations.liveOrders, 0); assert.equal((await read()).operations.activeOrders, 1);
    const collection = await place("live-collection", "collection");
    for (const next of ["accepted", "preparing", "ready"]) await status(collection, next);
    assert.equal((await read()).operations.liveOrders, 1);
    await status(collection, "completed"); assert.equal((await read()).operations.liveOrders, 0);
    const hidden = await place("live-hidden", "collection");
    f.db.prepare("UPDATE orders SET merchant_visible_at=NULL WHERE id=?").run(hidden); assert.equal((await read()).operations.liveOrders, 0);
    f.db.prepare("UPDATE orders SET merchant_visible_at='2026-10-29T12:00:00.000Z',payment_method='card',payment_status='stripe_checkout_pending' WHERE id=?").run(hidden); assert.equal((await read()).operations.liveOrders, 0);
    f.db.prepare("UPDATE orders SET payment_status='stripe_authorized' WHERE id=?").run(hidden); assert.equal((await read()).operations.liveOrders, 1);
    f.db.prepare("UPDATE orders SET status='rejected' WHERE id=?").run(hidden); assert.equal((await read()).operations.liveOrders, 0);
    assert.equal((await f.json(`${root}/dashboard`, { cookie: other })).status, 404);
  } finally { await f.close(); }
});
