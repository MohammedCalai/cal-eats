import assert from "node:assert/strict";
import test from "node:test";
import { journeyFixture } from "./helpers.js";

test("business native sessions keep roles and restaurant membership scoped and revoke through browser controls", async () => {
  const f = await journeyFixture();
  try {
    const login = (email, password, path = "/api/native/business/auth/login") => f.json(path, { method: "POST", body: { email, password } });
    assert.equal((await login("customer@calai.local", "LocalCustomer!4310")).status, 401);
    assert.equal((await login("restaurant@calai.local", "LocalRestaurant!4310", "/api/native/auth/login")).status, 401);
    const business = await login("restaurant@calai.local", "LocalRestaurant!4310");
    assert.equal(business.status, 200, business.text);
    const headers = { Authorization: `Bearer ${business.body.data.token}` };
    const restaurants = await f.json("/api/restaurant/restaurants", { headers });
    assert.equal(restaurants.status, 200); assert.equal(restaurants.body.data.length, 1);
    const other = f.db.prepare("SELECT restaurant_id FROM restaurant_memberships WHERE user_id=(SELECT id FROM users WHERE email='restaurant2@calai.local')").get().restaurant_id;
    assert.equal((await f.json(`/api/restaurant/restaurants/${other}/menu`, { headers })).status, 404);
    const cookie = await f.login("restaurant@calai.local", "LocalRestaurant!4310");
    const listed = await f.json("/api/account/sessions", { cookie });
    assert.ok(listed.body.data.some(x => x.device === "Cal-Eats Admin"));
    await f.json("/api/account/sessions/revoke-others", { method: "POST", cookie, body: {} });
    assert.equal((await f.json("/api/native/auth/me", { headers })).status, 401);
    const fresh = await login("restaurant@calai.local", "LocalRestaurant!4310");
    f.db.prepare("DELETE FROM restaurant_memberships WHERE user_id=?").run(fresh.body.data.user.id);
    assert.equal((await f.json("/api/native/auth/me", { headers: { Authorization: `Bearer ${fresh.body.data.token}` } })).status, 401);
  } finally { await f.close(); }
});

test("help requests produce receipts, team notifications and an encrypted reply thread", async () => {
  const f = await journeyFixture();
  try {
    const customer = await f.login("customer@calai.local", "LocalCustomer!4310"), admin = await f.login("admin@calai.local", "LocalAdmin!4310"), other = await f.login("restaurant2@calai.local", "LocalRestaurant2!4310");
    const created = await f.json("/api/support", { method: "POST", cookie: customer, headers: { "Idempotency-Key": "support-create-01" }, body: { subject: "App help", message: "My request needs a visible reply." } });
    assert.equal(created.status, 201, created.text); const ticket = created.body.data;
    assert.equal(ticket.recipient, "Cal-Eats support");
    assert.ok(f.db.prepare("SELECT 1 FROM user_notifications WHERE support_case_id=? AND type='support_request'").get(ticket.id));
    assert.ok(f.db.prepare("SELECT 1 FROM user_notifications WHERE support_case_id=? AND type='support_receipt'").get(ticket.id));
    assert.equal((await f.json(`/api/support/${ticket.id}`, { cookie: other })).status, 404);
    const send = () => f.json(`/api/support/${ticket.id}/messages`, { method: "POST", cookie: admin, headers: { "Idempotency-Key": "support-reply-01" }, body: { message: "We can help with your account." } });
    const replies = await Promise.all([send(), send()]); assert.ok(replies.every(x => [200, 201].includes(x.status)), JSON.stringify(replies));
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM support_case_messages WHERE case_id=?").get(ticket.id).n, 1);
    assert.equal(JSON.stringify(f.db.prepare("SELECT * FROM support_case_messages WHERE case_id=?").get(ticket.id)).includes("We can help"), false);
    const detail = await f.json(`/api/support/${ticket.id}`, { cookie: customer });
    assert.equal(detail.body.data.messages[0].message, "We can help with your account.");
    assert.equal(detail.body.data.waitingFor, "customer");
    await f.json(`/api/support/${ticket.id}`, { method: "PATCH", cookie: customer, body: { status: "resolved" } });
    assert.equal((await f.json(`/api/support/${ticket.id}`, { cookie: customer })).body.data.status, "resolved");
  } finally { await f.close(); }
});

test("order help is routed to its restaurant and cannot be read by another restaurant", async () => {
  const f = await journeyFixture();
  try {
    const customer = await f.login("customer@calai.local", "LocalCustomer!4310"), owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310"), other = await f.login("restaurant2@calai.local", "LocalRestaurant2!4310");
    const restaurant = (await f.json("/api/restaurants")).body.data[0], item = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
    const order = (await f.json("/api/orders", { method: "POST", cookie: customer, headers: { "Idempotency-Key": "order-for-help" }, body: { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], paymentMethod: "mock_card", fulfillment: "collection" } })).body.data;
    const ticket = (await f.json("/api/support", { method: "POST", cookie: customer, body: { subject: "Order help", message: "Please check my collection time", orderId: order.id } })).body.data;
    assert.equal(ticket.restaurantId, restaurant.id);
    assert.equal((await f.json(`/api/support/${ticket.id}`, { cookie: owner })).status, 200);
    assert.equal((await f.json(`/api/support/${ticket.id}`, { cookie: other })).status, 404);
    const page = await f.json(`/api/restaurant/restaurants/${restaurant.id}/support?page=1&pageSize=10`, { cookie: owner });
    assert.equal(page.body.data.total, 1); assert.equal(page.body.data.items[0].id, ticket.id);
  } finally { await f.close(); }
});
