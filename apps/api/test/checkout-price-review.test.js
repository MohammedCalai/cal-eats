import assert from "node:assert/strict";
import test from "node:test";
import { journeyFixture } from "./helpers.js";

test("a price or owner delivery-fee change requires a fresh reviewed total before an order exists; retries keep the original snapshot", async () => {
  const f = await journeyFixture();
  try {
    const owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310"), customer = await f.login("customer@calai.local", "LocalCustomer!4310");
    const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0];
    const root = `/api/restaurant/restaurants/${restaurant.id}`;
    await f.json(`${root}/delivery`, { method: "PATCH", cookie: owner, body: { enabled: true, outcodes: ["N1"], deliveryFeeMinor: 250, minDeliverySubtotalMinor: 1000 } });
    const item = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items.find(row => row.priceMinor >= 1000);
    const body = { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], fulfillment: "delivery", deliveryAddress: { line1: "1 Fictional Test Road", city: "London", postcode: "N1 1AA" } };
    const price = async () => { const result = await f.json("/api/orders/quote", { method: "POST", cookie: customer, body }); assert.equal(result.status, 200, result.text); return result.body.data.totalMinor; };
    const reviewed = await price(); const before = f.db.prepare("SELECT COUNT(*) n FROM orders").get().n;
    await f.json(`${root}/menu/${item.id}`, { method: "PATCH", cookie: owner, body: { priceMinor: item.priceMinor + 100 } });
    const orderBody = { ...body, paymentMethod: "mock_card", expectedTotalMinor: reviewed };
    const place = payload => f.json("/api/orders", { method: "POST", cookie: customer, headers: { "Idempotency-Key": "reviewed-order" }, body: payload });
    assert.equal((await place(orderBody)).body.error.code, "PRICE_CHANGED");
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM orders").get().n, before);
    const menuReviewed = await price();
    await f.json(`${root}/delivery`, { method: "PATCH", cookie: owner, body: { enabled: true, outcodes: ["N1"], deliveryFeeMinor: 375, minDeliverySubtotalMinor: 1000 } });
    assert.equal((await place({ ...orderBody, expectedTotalMinor: menuReviewed })).body.error.code, "PRICE_CHANGED");
    const finalBody = { ...orderBody, expectedTotalMinor: await price() };
    const placed = await place(finalBody); assert.equal(placed.status, 201, placed.text);
    assert.equal(placed.body.data.totalMinor, finalBody.expectedTotalMinor);
    await f.json(`${root}/menu/${item.id}`, { method: "PATCH", cookie: owner, body: { priceMinor: item.priceMinor + 900 } });
    const retry = await place(finalBody); assert.equal(retry.status, 200); assert.equal(retry.body.data.id, placed.body.data.id);
    assert.equal(retry.body.data.totalMinor, finalBody.expectedTotalMinor);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM orders").get().n, before + 1);
  } finally { await f.close(); }
});
