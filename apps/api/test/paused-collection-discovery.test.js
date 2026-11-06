import assert from "node:assert/strict";
import test from "node:test";
import { journeyFixture } from "./helpers.js";
import { discoveryFeedHtml } from "../../web/discovery-ui.js";
import { discoveryAvailabilityMessage, discoveryCollections, restaurantBrowseFulfillment } from "../../web/discovery-model.js";

test("collection-only paused restaurants remain visible and readable without enabling orders or demo listings", async () => {
  const f = await journeyFixture({ now: () => new Date("2026-01-01T10:00:00.000Z") });
  try {
    const owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310"), customer = await f.login("customer@calai.local", "LocalCustomer!4310");
    const restaurantId = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0].id;
    const item = f.db.prepare("SELECT id FROM menu_items WHERE restaurant_id=? LIMIT 1").get(restaurantId);
    f.db.prepare("UPDATE restaurants SET name='Arndale Market Curry Centre',status='approved',paused=1,suspended=0,archived_at=NULL,delivery_enabled=0,collection_enabled=1,cash_enabled=0,always_open=0,opening_hours='[]' WHERE id=?").run(restaurantId);
    f.db.prepare("UPDATE menu_items SET available=0 WHERE restaurant_id=?").run(restaurantId);
    const base = "/api/restaurants?q=Arndale&fulfillment=delivery&postcode=LU1%201AA";
    assert.deepEqual((await f.json(base)).body.data, [], "Strict delivery API queries retain their existing meaning");
    const discovered = await f.json(`${base}&includeCollectionOnly=true`); assert.equal(discovered.status, 200, discovered.text); assert.equal(discovered.body.data.length, 1);
    const restaurant = discovered.body.data[0]; assert.equal(restaurant.id, restaurantId); assert.equal(restaurant.profile.paused, true); assert.equal(restaurant.acceptingOrders, false); assert.equal(restaurant.schedulingAvailable, false); assert.equal(restaurant.delivery.enabled, false); assert.equal(restaurant.profile.collectionEnabled, true); assert.equal(restaurant.profile.cashEnabled, false);
    assert.equal((await f.json("/api/restaurants?q=Arndale&fulfillment=collection")).body.data[0].id, restaurantId);
    const menu = await f.json(`/api/restaurants/${restaurantId}/menu`); assert.equal(menu.status, 200, menu.text); assert.equal(menu.body.data.restaurant.name, restaurant.name); assert.deepEqual(menu.body.data.items, []);
    const state = { restaurants: [restaurant], offers: [], search: "Arndale", postcode: "LU1 1AA", fulfillment: "delivery", discoverCollection: "home", serviceArea: { available: true } };
    const html = discoveryFeedHtml(state); assert.ok(html.includes(restaurant.name)); assert.ok(html.includes("Collection only")); assert.ok(html.includes("Not taking orders right now")); assert.ok(html.includes('data-action="open-menu"')); assert.equal(html.includes('disabled aria-disabled="true"'), false); assert.equal(html.includes("£0.00 delivery"), false); assert.equal(html.includes("40 min"), false);
    const noDeliveryArea = discoveryFeedHtml({ ...state, serviceArea: { available: false, headline: "Delivery unavailable here", message: "Collection restaurants can still be viewed." } }); assert.ok(noDeliveryArea.includes(restaurant.name)); assert.equal(noDeliveryArea.includes('disabled aria-disabled="true"'), false, "An unavailable delivery area must not prevent reading a collection-only restaurant");
    assert.equal(restaurantBrowseFulfillment(restaurant, "delivery"), "collection", "Native and web cards share the correct fulfillment label"); assert.equal(discoveryAvailabilityMessage(restaurant), "Not taking orders right now"); assert.deepEqual(discoveryCollections([restaurant], [], "delivery").freeDelivery, []); assert.deepEqual(discoveryCollections([restaurant], [], "delivery").quick, []);
    const orderBody = { restaurantId, items: [{ menuItemId: item.id, quantity: 1 }], paymentMethod: "cash", fulfillment: "collection" };
    const quote = await f.json("/api/orders/quote", { method: "POST", cookie: customer, body: { restaurantId, items: orderBody.items, fulfillment: "collection" } }); assert.equal(quote.status, 409, quote.text); assert.equal(quote.body.error.code, "RESTAURANT_CLOSED");
    const order = await f.json("/api/orders", { method: "POST", cookie: customer, headers: { "Idempotency-Key": "paused-listing-no-checkout" }, body: orderBody }); assert.equal(order.status, 409, order.text); assert.equal(order.body.error.code, "RESTAURANT_CLOSED");
    assert.equal((await f.json(`/api/restaurants/${restaurantId}/schedule-slots?fulfillment=collection`)).body.data.items.length, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM orders WHERE restaurant_id=?").get(restaurantId).n, 0); assert.equal(f.db.prepare("SELECT COUNT(*) n FROM menu_items WHERE restaurant_id=? AND available=1").get(restaurantId).n, 0);
    for (const update of ["suspended=1", "suspended=0,archived_at='2026-01-01T10:00:00.000Z'", "archived_at=NULL,status='pending'"]) { f.db.prepare(`UPDATE restaurants SET ${update} WHERE id=?`).run(restaurantId); assert.deepEqual((await f.json(`${base}&includeCollectionOnly=true`)).body.data, []); }
    assert.equal((await f.json(`${base}&includeCollectionOnly=yes`)).status, 400);
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { await f.close(); }
});
