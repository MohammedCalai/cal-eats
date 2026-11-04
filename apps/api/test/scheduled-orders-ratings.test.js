import assert from "node:assert/strict";
import test from "node:test";
import { journeyFixture } from "./helpers.js";
import { queueShopRatingPrompt } from "../src/shop-ratings.js";

async function setup(f) {
  const owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310"), customer = await f.login("customer@calai.local", "LocalCustomer!4310");
  const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0];
  const menu = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items;
  return { owner, customer, restaurant, items: [{ menuItemId: menu.find(item => item.priceMinor >= 1000).id, quantity: 1 }] };
}

test("scheduled slots and quote validation use the server clock, fulfillment estimates, London hours and holidays", async () => {
  const now = new Date("2026-01-01T10:00:00.000Z"), f = await journeyFixture({ now: () => new Date(now) });
  try {
    const { customer, restaurant, items } = await setup(f);
    f.db.prepare("UPDATE restaurants SET always_open=0,opening_hours=?,estimated_delivery_minutes=75,busy_minutes=15 WHERE id=?").run(JSON.stringify([{ day: 5, open: "11:00", close: "15:00" }]), restaurant.id);
    const slots = await f.json(`/api/restaurants/${restaurant.id}/schedule-slots?fulfillment=delivery`);
    assert.equal(slots.status, 200, slots.text); assert.equal(slots.body.data.minimumLeadMinutes, 90); assert.equal(slots.body.data.maxDays, 7);
    assert.ok(slots.body.data.items.length > 0 && slots.body.data.items.length <= 672);
    assert.equal(slots.body.data.items[0].scheduledFor, "2026-01-02T11:00:00.000Z");
    assert.ok(slots.body.data.items.every(slot => slot.dateKey === "2026-01-02" && slot.label < "15:00"));
    const quote = scheduledFor => f.json("/api/orders/quote", { method: "POST", cookie: customer, body: { restaurantId: restaurant.id, items, fulfillment: "collection", scheduledFor } });
    const selected = "2026-01-02T12:00:00.000Z", good = await quote(selected);
    assert.equal(good.status, 200, good.text); assert.equal(good.body.data.scheduledFor, selected); assert.equal(good.body.data.scheduleMinimumLeadMinutes, 35);
    for (const input of ["2026-01-01T09:00:00Z", "2026-01-01T10:15:00Z"]) assert.equal((await quote(input)).body.error.code, "SCHEDULE_TOO_SOON");
    assert.equal((await quote("2026-01-09T12:00:00Z")).body.error.code, "SCHEDULE_TOO_FAR");
    for (const input of ["later", "2026-02-30T12:00:00Z", "2026-01-02T12:00:00", 123]) assert.equal((await quote(input)).status, 400);
    assert.equal((await quote("2026-01-02T15:00:00Z")).body.error.code, "SCHEDULE_UNAVAILABLE");
    const closedOrder = await f.json("/api/orders", { method: "POST", cookie: customer, headers: { "Idempotency-Key": "closed-schedule" }, body: { restaurantId: restaurant.id, items, fulfillment: "collection", paymentMethod: "mock_card", scheduledFor: "2026-01-02T15:00:00Z" } });
    assert.equal(closedOrder.body.error.code, "SCHEDULE_UNAVAILABLE");
    f.db.prepare("UPDATE restaurants SET holiday_dates=? WHERE id=?").run('["2026-01-02"]', restaurant.id);
    assert.equal((await quote(selected)).body.error.code, "SCHEDULE_UNAVAILABLE");
    assert.deepEqual((await f.json(`/api/restaurants/${restaurant.id}/schedule-slots?fulfillment=collection`)).body.data.items, []);
    f.db.prepare("UPDATE restaurants SET holiday_dates='[]',collection_enabled=0 WHERE id=?").run(restaurant.id);
    assert.equal((await quote(selected)).body.error.code, "COLLECTION_DISABLED");
    assert.equal((await f.json(`/api/restaurants/${restaurant.id}/schedule-slots?fulfillment=unknown`)).status, 400);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM orders").get().n, 0, "Schedule browsing and quoting must not create orders");
  } finally { await f.close(); }
});

test("scheduled delivery remains a customer snapshot through business ETA, receipts, email payloads, printing and retry", async () => {
  let clock = Date.parse("2026-01-01T10:00:00.000Z");
  const f = await journeyFixture({ now: () => new Date(clock) });
  try {
    const { owner, customer, restaurant, items } = await setup(f), root = `/api/restaurant/restaurants/${restaurant.id}`;
    const printer = (await f.json(`${root}/printers`, { method: "POST", cookie: owner, body: { name: "Scheduled kitchen", enabled: true } })).body.data;
    const scheduledFor = "2026-01-03T12:00:00.000Z", orderBody = { restaurantId: restaurant.id, items, fulfillment: "delivery", scheduledFor, deliveryAddress: { line1: "1 Test Road", city: "Luton", postcode: "LU1 1AA" } };
    const quote = await f.json("/api/orders/quote", { method: "POST", cookie: customer, body: orderBody });
    assert.equal(quote.status, 200, quote.text); assert.equal(quote.body.data.scheduledFor, scheduledFor);
    const body = { ...orderBody, expectedTotalMinor: quote.body.data.totalMinor, paymentMethod: "mock_card" };
    let customerSession = customer;
    const place = payload => f.json("/api/orders", { method: "POST", cookie: customerSession, headers: { "Idempotency-Key": "scheduled-delivery" }, body: payload });
    const placed = await place(body); assert.equal(placed.status, 201, placed.text); const id = placed.body.data.id;
    assert.equal(placed.body.data.scheduledFor, scheduledFor); assert.equal(placed.body.data.scheduleMinimumLeadMinutes, 35);
    const confirmed = await f.json(`/api/restaurant/orders/${id}/status`, { method: "PATCH", cookie: owner, body: { status: "accepted" } });
    assert.equal(confirmed.status, 200, confirmed.text); assert.equal(confirmed.body.data.customerEtaAt, scheduledFor);
    const printed = JSON.parse(f.db.prepare("SELECT receipt FROM device_print_jobs WHERE order_id=? AND printer_id=?").get(id, printer.id).receipt);
    assert.equal(printed.scheduledFor, scheduledFor);
    const payload = JSON.parse(f.db.prepare("SELECT payload FROM customer_transactional_email_outbox WHERE order_id=? AND source_key=?").get(id, `order:${id}:accepted`).payload);
    assert.equal(payload.order.scheduledFor, scheduledFor);
    const adjustedEta = "2026-01-03T12:15:00.000Z";
    const adjusted = await f.json(`/api/restaurant/orders/${id}/preparation`, { method: "PATCH", cookie: owner, body: { estimatedReadyAt: adjustedEta } });
    assert.equal(adjusted.status, 200, adjusted.text); assert.equal(adjusted.body.data.customerEtaAt, adjustedEta); assert.equal(adjusted.body.data.scheduledFor, scheduledFor);
    const business = (await f.json(`${root}/orders`, { cookie: owner })).body.data.find(row => row.id === id);
    assert.equal(business.scheduledFor, scheduledFor);
    const dashboard = await f.json(`${root}/dashboard?from=2026-01-01&to=2026-01-01`, { cookie: owner });
    assert.equal(dashboard.status, 200, dashboard.text); assert.equal(dashboard.body.data.orders.items.find(row => row.id === id).scheduledFor, scheduledFor);
    const csv = await f.request(`${root}/dashboard/orders.csv?from=2026-01-01&to=2026-01-01`, { cookie: owner });
    assert.equal(csv.status, 200, csv.text); assert.match(csv.text, /scheduledForUtc/); assert.ok(csv.text.includes(scheduledFor));
    const receipt = await f.request(`/api/orders/${id}/receipt`, { cookie: customer });
    assert.match(receipt.text, /Scheduled delivery/); assert.match(receipt.text, /3 January 2026 at 12:00/);
    assert.equal((await place({ ...body, scheduledFor: "2026-01-03T13:00:00.000Z" })).body.error.code, "IDEMPOTENCY_CONFLICT");
    clock = Date.parse("2026-01-05T12:00:00.000Z");
    customerSession = await f.login("customer@calai.local", "LocalCustomer!4310");
    f.db.prepare("UPDATE restaurants SET paused=1 WHERE id=?").run(restaurant.id);
    const replay = await place(body); assert.equal(replay.status, 200, replay.text); assert.equal(replay.body.data.id, id); assert.equal(replay.body.data.scheduledFor, scheduledFor);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM orders").get().n, 1);
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { await f.close(); }
});

test("shop ratings are customer-owned completed-order stars, with genuine aggregates and one completion prompt", async () => {
  const now = new Date("2026-01-01T10:00:00.000Z"), f = await journeyFixture({ now: () => new Date(now) });
  try {
    const { owner, customer, restaurant, items } = await setup(f), otherOwner = await f.login("restaurant2@calai.local", "LocalRestaurant2!4310");
    f.db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) SELECT 'rating-other','Other customer','rating-other@example.invalid',password_hash,'customer',created_at FROM users WHERE email='customer@calai.local'").run();
    const otherCustomer = await f.login("rating-other@example.invalid", "LocalCustomer!4310");
    const place = async key => { const result = await f.json("/api/orders", { method: "POST", cookie: customer, headers: { "Idempotency-Key": key }, body: { restaurantId: restaurant.id, items, fulfillment: "collection", paymentMethod: "cash", scheduledFor: null } }); assert.equal(result.status, 201, result.text); return result.body.data; };
    const order = await place("rating-first"), route = `/api/orders/${order.id}/shop-rating`;
    assert.equal(order.scheduledFor, null); assert.equal(order.shopRating, null); assert.equal(order.canRateShop, false);
    assert.equal((await f.json(route, { method: "POST", cookie: customer, body: { stars: 5 } })).body.error.code, "RATING_NOT_ELIGIBLE");
    for (const cookie of [otherCustomer, otherOwner]) assert.equal((await f.json(route, { method: "POST", cookie, body: { stars: 5 } })).status, cookie === otherOwner ? 403 : 404);
    const complete = async order => { for (const status of ["accepted", "preparing", "ready", "completed"]) { const result = await f.json(`/api/restaurant/orders/${order.id}/status`, { method: "PATCH", cookie: owner, body: { status } }); assert.equal(result.status, 200, result.text); } };
    await complete(order);
    await f.json(`/api/restaurant/orders/${order.id}/status`, { method: "PATCH", cookie: owner, body: { status: "completed" } });
    queueShopRatingPrompt(f.db, f.db.prepare("SELECT * FROM orders WHERE id=?").get(order.id), now.toISOString());
    const prompts = () => f.db.prepare("SELECT * FROM user_notifications WHERE order_id=? AND type='shop_rating'").all(order.id);
    assert.equal(prompts().length, 1); assert.equal(prompts()[0].read_at, null);
    assert.equal((await f.json(`/api/orders/${order.id}`, { cookie: customer })).body.data.canRateShop, true);
    for (const body of [{ stars: 0 }, { stars: 6 }, { stars: 1.5 }, { stars: "5" }, { stars: 5, comment: "Not allowed" }]) assert.equal((await f.json(route, { method: "POST", cookie: customer, body })).status, 400);
    const rated = await f.json(route, { method: "POST", cookie: customer, body: { stars: 5 } });
    assert.equal(rated.status, 201, rated.text); assert.equal(rated.body.data.ratingCount, 1); assert.equal(rated.body.data.ratingAverage, 5); assert.ok(prompts()[0].read_at);
    assert.equal((await f.json(route, { method: "POST", cookie: customer, body: { stars: 5 } })).status, 200);
    const nativeLogin = await f.json("/api/native/auth/login", { method: "POST", body: { email: "customer@calai.local", password: "LocalCustomer!4310" } });
    assert.equal(nativeLogin.status, 200, nativeLogin.text);
    assert.equal((await f.json(route, { method: "POST", headers: { authorization: `Bearer ${nativeLogin.body.data.token}` }, body: { stars: 5 } })).status, 200);
    assert.equal((await f.json(route, { method: "POST", cookie: customer, body: { stars: 4 } })).body.error.code, "RATING_ALREADY_SUBMITTED");
    const second = await place("rating-second"); await complete(second);
    await f.json(`/api/orders/${second.id}/shop-rating`, { method: "POST", cookie: customer, body: { stars: 2 } });
    const menu = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.restaurant;
    assert.equal(menu.ratingCount, 2); assert.equal(menu.ratingAverage, 3.5);
    const listing = (await f.json("/api/restaurants")).body.data.find(row => row.id === restaurant.id);
    assert.equal(listing.ratingCount, 2); assert.equal(listing.ratingAverage, 3.5);
    const older = await place("rating-old"); await complete(older);
    f.db.prepare("UPDATE orders SET created_at='2025-10-01T10:00:00.000Z' WHERE id=?").run(older.id);
    assert.equal((await f.json(`/api/orders/${older.id}/shop-rating`, { method: "POST", cookie: customer, body: { stars: 3 } })).status, 404);
    const unrateable = await place("rating-rejected");
    await f.json(`/api/restaurant/orders/${unrateable.id}/status`, { method: "PATCH", cookie: owner, body: { status: "rejected" } });
    assert.equal((await f.json(`/api/orders/${unrateable.id}/shop-rating`, { method: "POST", cookie: customer, body: { stars: 3 } })).body.error.code, "RATING_NOT_ELIGIBLE");
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM restaurant_order_ratings").get().n, 2);
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { await f.close(); }
});
