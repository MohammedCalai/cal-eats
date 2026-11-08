import assert from "node:assert/strict";
import test from "node:test";
import { journeyFixture } from "./helpers.js";

async function setup() {
  const f = await journeyFixture({ rateLimit: { attempts: 100, windowMs: 60000 } });
  const owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310"), otherOwner = await f.login("restaurant2@calai.local", "LocalRestaurant2!4310"), customer = await f.login("customer@calai.local", "LocalCustomer!4310");
  const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0], root = `/api/restaurant/restaurants/${restaurant.id}`;
  const item = f.db.prepare("SELECT * FROM menu_items WHERE restaurant_id=? LIMIT 1").get(restaurant.id);
  f.db.prepare("UPDATE menu_items SET modifier_groups='[]' WHERE id=?").run(item.id);
  const placed = await f.json("/api/orders", { method: "POST", cookie: customer, headers: { "Idempotency-Key": "moderation-order" }, body: { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], fulfillment: "collection", paymentMethod: "cash" } });
  assert.equal(placed.status, 201, placed.text);
  return { f, owner, otherOwner, customer, restaurant, root, item, order: placed.body.data };
}
const rejected = result => { assert.equal(result.status, 422, result.text); assert.equal(result.body.error.code, "CONTENT_NOT_ALLOWED"); assert.match(result.body.error.message, /Reword it.*Help & support/); };

test("order screening rejects both senders before persistence or notification, preserving safe retries and quick-response settings", async () => {
  const s = await setup(); try {
    const route = `/api/orders/${s.order.id}/messages`, before = s.f.db.prepare("SELECT COUNT(*) n FROM user_notifications").get().n;
    for (const cookie of [s.customer, s.owner]) rejected(await s.f.json(route, { method: "POST", cookie, headers: { "Idempotency-Key": "blocked-draft" }, body: { message: "I will k1ll you" } }));
    assert.equal(s.f.db.prepare("SELECT COUNT(*) n FROM order_messages").get().n, 0);
    assert.equal(s.f.db.prepare("SELECT COUNT(*) n FROM order_message_rate_limits").get().n, 0);
    assert.equal(s.f.db.prepare("SELECT COUNT(*) n FROM user_notifications").get().n, before);
    const safe = { message: "Chicken breast contains nuts? I have a severe allergy; please check." };
    const first = await s.f.json(route, { method: "POST", cookie: s.customer, headers: { "Idempotency-Key": "blocked-draft" }, body: safe });
    assert.equal(first.status, 201, first.text);
    const replay = await s.f.json(route, { method: "POST", cookie: s.customer, headers: { "Idempotency-Key": "blocked-draft" }, body: safe });
    assert.equal(replay.status, 200); assert.equal(replay.body.data.id, first.body.data.id);
    const settings = `${s.root}/message-settings`, old = (await s.f.json(settings, { cookie: s.owner })).body.data;
    rejected(await s.f.json(settings, { method: "PATCH", cookie: s.owner, body: { quickResponses: ["send me nudes", "Two", "Three", "Four", "Five", "Six"], supportWindowMinutes: 60 } }));
    assert.deepEqual((await s.f.json(settings, { cookie: s.owner })).body.data, old);
    assert.equal((await s.f.json(route, { method: "POST", cookie: s.otherOwner, headers: { "Idempotency-Key": "unrelated" }, body: { message: "I will kill you" } })).status, 404, "Tenant checks precede moderation feedback");
  } finally { await s.f.close(); }
});

test("CRM screening creates no rejected thread and leaves genuine safety/support evidence available privately", async () => {
  const s = await setup(); try {
    const route = `${s.root}/customers/${s.order.customerId}/conversation`;
    rejected(await s.f.json(route, { method: "POST", cookie: s.owner, headers: { "Idempotency-Key": "blocked-crm" }, body: { message: "send me nudes" } }));
    assert.equal(s.f.db.prepare("SELECT COUNT(*) n FROM restaurant_customer_threads").get().n, 0);
    const sent = await s.f.json(route, { method: "POST", cookie: s.owner, headers: { "Idempotency-Key": "safe-crm" }, body: { message: "How can we help with your food allergy?" } });
    assert.equal(sent.status, 201, sent.text);
    const customerRoute = `/api/customer/conversations/${sent.body.data.threadId}/messages`;
    rejected(await s.f.json(customerRoute, { method: "POST", cookie: s.customer, headers: { "Idempotency-Key": "blocked-reply" }, body: { message: "f.u.c.k y.o.u" } }));
    assert.equal(s.f.db.prepare("SELECT COUNT(*) n FROM restaurant_customer_messages").get().n, 1);
    const quoted = await s.f.json(customerRoute, { method: "POST", cookie: s.customer, headers: { "Idempotency-Key": "reported-quote" }, body: { message: 'Your driver said "fuck you" to me. Please investigate.' } });
    assert.equal(quoted.status, 201, quoted.text);
    const report = await s.f.json("/api/customer-safety/reports", { method: "POST", cookie: s.customer, headers: { "Idempotency-Key": "moderation-safety-evidence" }, body: { restaurantId: s.restaurant.id, reason: "harassment", details: "I will kill you" } });
    assert.equal(report.status, 201, report.text);
    const stored = s.f.db.prepare("SELECT * FROM support_cases WHERE id=?").get(report.body.data.supportCaseId);
    assert.equal(stored.restaurant_id, null); assert.match(stored.message, /I will kill you/);
    assert.equal((await s.f.json(`/api/support/${stored.id}`, { cookie: s.owner })).status, 404);
    const support = await s.f.json("/api/support", { method: "POST", cookie: s.customer, body: { subject: "Unsafe message evidence", message: "I will kill you" } });
    assert.equal(support.status, 201, support.text, "Support intake must accept verbatim evidence");
  } finally { await s.f.close(); }
});

test("published menu/profile/import and campaign text cannot bypass screening or partially save a rejected request", async () => {
  const s = await setup(); try {
    const before = s.f.db.prepare("SELECT COUNT(*) n FROM menu_items WHERE restaurant_id=?").get(s.restaurant.id).n;
    rejected(await s.f.json(`${s.root}/menu`, { method: "POST", cookie: s.owner, body: { name: "New curry", description: "I will kill you", priceMinor: 500 } }));
    rejected(await s.f.json(`${s.root}/menu/${s.item.id}`, { method: "PATCH", cookie: s.owner, body: { category: "You are an idiot" } }));
    rejected(await s.f.json(`${s.root}/menu/${s.item.id}`, { method: "PATCH", cookie: s.owner, body: { modifierGroups: [{ id: "side", name: "Choose a side", minSelections: 0, maxSelections: 1, options: [{ id: "bad", name: "send me nudes", priceMinor: 0, available: true }] }] } }));
    rejected(await s.f.json(`${s.root}/menu/import`, { method: "POST", cookie: s.owner, headers: { "Idempotency-Key": "rejected-import" }, body: { items: [{ name: "Safe curry", priceMinor: 500 }, { name: "New curry", description: "I will kill you", priceMinor: 500 }] } }));
    assert.equal(s.f.db.prepare("SELECT COUNT(*) n FROM menu_items WHERE restaurant_id=?").get(s.restaurant.id).n, before);
    const original = s.f.db.prepare("SELECT description FROM restaurants WHERE id=?").get(s.restaurant.id).description;
    rejected(await s.f.json(`${s.root}/profile`, { method: "PATCH", cookie: s.owner, body: { description: "You are a stupid idiot" } }));
    assert.equal(s.f.db.prepare("SELECT description FROM restaurants WHERE id=?").get(s.restaurant.id).description, original);
    const allowed = await s.f.json(`${s.root}/menu/${s.item.id}`, { method: "PATCH", cookie: s.owner, body: { name: "Chicken breast", description: "Shiitake mushrooms, cumin and nuts. Ask about allergies." } });
    assert.equal(allowed.status, 200, allowed.text);
    rejected(await s.f.json(`${s.root}/offers`, { method: "POST", cookie: s.owner, headers: { "Idempotency-Key": "blocked-offer" }, body: { customerIds: [s.order.customerId], title: "Dinner offer", message: "send me nudes", menuItemId: s.item.id, minSubtotalMinor: 0, expiresInDays: 7 } }));
    for (const status of ["accepted", "preparing", "ready", "completed"]) assert.equal((await s.f.json(`/api/restaurant/orders/${s.order.id}/status`, { method: "PATCH", cookie: s.owner, body: { status } })).status, 200);
    assert.equal((await s.f.json("/api/account/marketing-preferences", { method: "PATCH", cookie: s.customer, body: { inAppPromotions: true, pushPromotions: false, source: "moderation-fixture" } })).status, 200);
    const now = s.f.config.now(), promotion = { title: "Dinner offer", message: "10% off your next meal", campaignType: "percent_order", offerType: "percent_off", value: 1000, minSubtotalMinor: 0, startsAt: new Date(+now - 1000).toISOString(), expiresAt: new Date(+now + 86400000).toISOString(), redemptionLimit: 100, eligibleItemIds: [], eligibleCategories: [], recipientSegment: "all", customerIds: [], stackingPolicy: "exclusive", fundingParty: "restaurant" };
    rejected(await s.f.json(`${s.root}/loyalty/promotions`, { method: "POST", cookie: s.owner, headers: { "Idempotency-Key": "blocked-promotion" }, body: { ...promotion, title: "Fuck you" } }));
    const created = await s.f.json(`${s.root}/loyalty/promotions`, { method: "POST", cookie: s.owner, headers: { "Idempotency-Key": "safe-promotion" }, body: promotion });
    assert.equal(created.status, 201, created.text);
    rejected(await s.f.json(`${s.root}/loyalty/promotions/${created.body.data.id}`, { method: "PATCH", cookie: s.owner, body: { message: "I will kill you" } }));
    assert.equal(s.f.db.prepare("SELECT message FROM offer_campaigns WHERE id=?").get(created.body.data.id).message, promotion.message);
  } finally { await s.f.close(); }
});
