import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { EventEmitter } from "node:events";
import { journeyFixture } from "./helpers.js";
import { runCustomerMessageRetention } from "../src/customer-relationships.js";
import { notificationStreamHub } from "../src/notification-stream.js";

test("10,001-customer directory stays bounded, tenant scoped, and connects encrypted service conversations and notifications", async t => {
  const f = await journeyFixture();
  try {
    const owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310"), otherOwner = await f.login("restaurant2@calai.local", "LocalRestaurant2!4310"), customer = await f.login("customer@calai.local", "LocalCustomer!4310");
    const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0], menu = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items;
    const placed = await f.json("/api/orders", { method: "POST", cookie: customer, headers: { "Idempotency-Key": "crm-history" }, body: { restaurantId: restaurant.id, items: [{ menuItemId: menu[0].id, quantity: 1 }], fulfillment: "collection", paymentMethod: "mock_card" } });
    assert.equal(placed.status, 201, placed.text);
    for (const status of ["accepted", "preparing", "ready", "completed"]) assert.equal((await f.json(`/api/restaurant/orders/${placed.body.data.id}/status`, { method: "PATCH", cookie: owner, body: { status } })).status, 200);
    const customerId = placed.body.data.customerId, templateUser = f.db.prepare("SELECT * FROM users WHERE id=?").get(customerId), templateOrder = f.db.prepare("SELECT * FROM orders WHERE id=?").get(placed.body.data.id);
    const userColumns = Object.keys(templateUser), orderColumns = Object.keys(templateOrder), insertUser = f.db.prepare(`INSERT INTO users(${userColumns.join(",")}) VALUES(${userColumns.map(() => "?").join(",")})`), insertOrder = f.db.prepare(`INSERT INTO orders(${orderColumns.join(",")}) VALUES(${orderColumns.map(() => "?").join(",")})`);
    f.db.exec("BEGIN IMMEDIATE");
    try {
      for (let i = 0; i < 10000; i++) {
        const suffix = String(i).padStart(5, "0"), user = { ...templateUser, id: `scale-customer-${suffix}`, name: `Fictional customer ${suffix}`, email: `crm-scale-${suffix}@example.invalid` }, order = { ...templateOrder, id: `scale-order-${suffix}`, customer_id: user.id, customer_name: user.name, customer_email: user.email, created_at: "2025-12-01T12:00:00.000Z", updated_at: "2025-12-01T12:00:00.000Z", idempotency_key: `scale-${suffix}` };
        insertUser.run(...userColumns.map(column => user[column])); insertOrder.run(...orderColumns.map(column => order[column]));
      }
      f.db.exec("COMMIT");
    } catch (error) { f.db.exec("ROLLBACK"); throw error; }
    const base = `/api/restaurant/restaurants/${restaurant.id}`, started = performance.now(), first = await f.json(`${base}/customers?page=1&pageSize=25&sort=name`, { cookie: owner });
    assert.equal(first.status, 200, first.text); assert.equal(first.body.data.items.length, 25); assert.equal(first.body.data.pagination.total, 10001); assert.equal(first.body.data.summary.totalCustomers, 10001);
    assert.ok(first.text.length < 25000); t.diagnostic(`10,001-customer directory query: ${(performance.now() - started).toFixed(1)} ms; ${first.text.length} response bytes`);
    const second = await f.json(`${base}/customers?page=2&pageSize=25&sort=name`, { cookie: owner });
    assert.equal(second.body.data.pagination.hasPrevious, true); assert.equal(new Set([...first.body.data.items, ...second.body.data.items].map(row => row.customerId)).size, 50);
    assert.equal((await f.json(`${base}/customers?q=%25`, { cookie: owner })).body.data.pagination.total, 0);
    assert.equal((await f.json(`${base}/customers?pageSize=101`, { cookie: owner })).status, 400);
    assert.equal((await f.json(`${base}/customers`, { cookie: otherOwner })).status, 404);
    const reduced = await f.json(`${base}/loyalty?includeCustomers=false`, { cookie: owner });
    assert.equal(reduced.status, 200); assert.equal(reduced.body.data.customers, undefined);
    const profile = await f.json(`${base}/customers/${customerId}/profile`, { method: "PATCH", cookie: owner, body: { workflowStatus: "vip", note: "Fictional priority customer" } });
    assert.equal(profile.status, 200, profile.text); assert.equal(profile.body.data.customer.workflowStatus, "vip"); assert.equal(profile.body.data.note, "Fictional priority customer"); assert.equal(profile.body.data.customer.email, undefined);
    assert.equal((await f.json(`${base}/customers?segment=vip`, { cookie: owner })).body.data.pagination.total, 1);
    const route = `${base}/customers/${customerId}/conversation`, outbound = { message: "We can help with your recent order." };
    const sent = await f.json(route, { method: "POST", cookie: owner, headers: { "Idempotency-Key": "crm-owner-message" }, body: outbound });
    assert.equal(sent.status, 201, sent.text); const threadId = sent.body.data.threadId;
    assert.notEqual(f.db.prepare("SELECT ciphertext FROM restaurant_customer_messages WHERE id=?").get(sent.body.data.id).ciphertext, outbound.message);
    const replay = await f.json(route, { method: "POST", cookie: owner, headers: { "Idempotency-Key": "crm-owner-message" }, body: outbound });
    assert.equal(replay.status, 200); assert.equal(replay.body.data.id, sent.body.data.id);
    assert.equal((await f.json(route, { method: "POST", cookie: owner, headers: { "Idempotency-Key": "crm-owner-message" }, body: { message: "Changed message" } })).status, 409);
    const customerNotifications = (await f.json("/api/notifications", { cookie: customer })).body.data.items, notification = customerNotifications.find(row => row.type === "customer_message");
    assert.equal(notification.conversationId, threadId); assert.equal(notification.customerId, customerId); assert.ok(!notification.message.includes(outbound.message));
    const customerThreads = await f.json("/api/customer/conversations", { cookie: customer });
    assert.equal(customerThreads.body.data.items[0].threadId, threadId);
    const unrelatedCustomer = await f.login("crm-scale-00000@example.invalid", "LocalCustomer!4310");
    assert.equal((await f.json(`/api/customer/conversations/${threadId}/messages`, { cookie: unrelatedCustomer })).status, 404);
    const messages = await f.json(`/api/customer/conversations/${threadId}/messages`, { cookie: customer });
    assert.equal(messages.body.data.items[0].message, outbound.message); assert.equal(messages.body.data.unreadCount, 1);
    const reply = await f.json(`/api/customer/conversations/${threadId}/messages`, { method: "POST", cookie: customer, headers: { "Idempotency-Key": "crm-customer-reply" }, body: { message: "Thank you, please follow up." } });
    assert.equal(reply.status, 201, reply.text);
    const streamChunks = [], streamReq = new EventEmitter(), streamRes = new EventEmitter();
    Object.assign(streamRes, { writeHead() {}, flushHeaders() {}, write(chunk) { streamChunks.push(chunk); return true; }, end() {} });
    const ownerSession = f.db.prepare("SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email='restaurant@calai.local' AND s.revoked_at IS NULL").get(), ownerUser = f.db.prepare("SELECT id FROM users WHERE email='restaurant@calai.local'").get();
    const stream = notificationStreamHub(f.db, { now: f.config.now });
    stream.subscribe({ req: streamReq, res: streamRes, userId: ownerUser.id, sessionId: ownerSession.id }); stream.close();
    assert.ok(streamChunks.some(chunk => chunk.includes('"conversationId":"' + threadId + '"') && chunk.includes('"type":"customer_message"')));
    const attention = await f.json(`${base}/customers?segment=needs_attention`, { cookie: owner });
    assert.equal(attention.body.data.items[0].customerId, customerId); assert.equal(attention.body.data.items[0].unreadMessageCount, 1);
    const inbox = await f.json(`${base}/inbox?unread=true`, { cookie: owner });
    assert.equal(inbox.status, 200, inbox.text); assert.equal(inbox.body.data.items[0].conversationType, "customer"); assert.equal(inbox.body.data.items[0].status, "awaiting_restaurant");
    assert.equal((await f.json(`${base}/customers/${customerId}/conversation`, { cookie: otherOwner })).status, 404);
    const read = await f.json(`${route}/read`, { method: "POST", cookie: owner, body: { lastMessageId: reply.body.data.id } });
    assert.equal(read.body.data.unreadCount, 0);
    assert.equal((await f.json(route, { method: "PATCH", cookie: owner, body: { status: "resolved" } })).body.data.status, "resolved");
    const orderMessage = await f.json(`/api/orders/${placed.body.data.id}/messages`, { method: "POST", cookie: customer, headers: { "Idempotency-Key": "crm-order-inbox" }, body: { message: "This is about the delivery." } });
    assert.equal(orderMessage.status, 201, orderMessage.text);
    const unified = await f.json(`${base}/inbox?unread=true`, { cookie: owner }), orderThread = unified.body.data.items.find(row => row.conversationType === "order");
    assert.equal(orderThread.orderId, placed.body.data.id); assert.equal(orderThread.messagingAvailable, true); assert.equal(orderThread.unreadMessageCount, 1);
    assert.equal(unified.body.data.items.some(row => row.conversationType === "customer"), false);
    const row = f.db.prepare("SELECT * FROM restaurant_customer_messages WHERE id=?").get(reply.body.data.id);
    assert.equal(runCustomerMessageRetention(f.db, { ...f.config, now: () => new Date(Date.parse(row.expires_at) + 1) }), 2);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM user_notifications WHERE type='customer_message'").get().n, 0);
    f.db.prepare("DELETE FROM restaurant_memberships WHERE restaurant_id=? AND user_id=(SELECT id FROM users WHERE email='restaurant@calai.local')").run(restaurant.id);
    assert.equal((await f.json("/api/notifications", { cookie: owner })).body.data.items.some(item => item.restaurantId === restaurant.id), false);
  } finally { await f.close(); }
});
