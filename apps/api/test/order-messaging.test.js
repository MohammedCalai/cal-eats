import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, get as httpGet } from "node:http";
import { journeyFixture } from "./helpers.js";
import { orderMessagingMigration19 } from "../src/order-messaging-migration.js";
import { routeOrderMessaging, runMessageRetention } from "../src/order-messaging.js";
import { notificationStreamHub } from "../src/notification-stream.js";

const ensureMessagingSchema = (db) => { if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='order_messages'").get()) db.exec(orderMessagingMigration19.sql); };

function direct(fixture, session, route, { method = "GET", body, headers = {} } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]); Object.assign(req, { method, url: route, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers } });
  return new Promise((resolve, reject) => {
    const chunks = []; const responseHeaders = {};
    const res = { headersSent: false, writableEnded: false, setHeader(k, v) { responseHeaders[k.toLowerCase()] = v; }, writeHead(status, values = {}) { this.statusCode = status; this.headersSent = true; Object.assign(responseHeaders, values); }, write(value) { chunks.push(Buffer.from(value)); return true; }, end(value) { if (value) chunks.push(Buffer.from(value)); this.writableEnded = true; const text = Buffer.concat(chunks).toString(); resolve({ status: this.statusCode ?? 200, body: text ? JSON.parse(text) : null }); }, destroy() { reject(new Error("destroyed")); } };
    routeOrderMessaging({ req, res, url: new URL(route, fixture.config.origin), db: fixture.db, config: fixture.config, session }).then((handled) => { if (!handled && !res.writableEnded) reject(new Error("not handled")); }).catch(reject);
  });
}

test("encrypted order messages support idempotency, unread cursors and retention", async () => {
  const fixture = await journeyFixture();
  try {
    ensureMessagingSchema(fixture.db);
    const customer = fixture.db.prepare("SELECT * FROM users WHERE email='customer@calai.local'").get(); const restaurant = fixture.db.prepare("SELECT * FROM restaurants WHERE status='approved'").get(); const orderId = randomUUID(); const createdAt = "2026-01-01T00:30:00.000Z";
    fixture.db.prepare("INSERT INTO orders(id,restaurant_id,restaurant_name,customer_id,status,subtotal_minor,total_minor,commission_minor,payment_method,payment_status,fulfillment,idempotency_key,request_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(orderId, restaurant.id, restaurant.name, customer.id, "placed", 1000, 1000, 70, "cash", "cash_due", "collection", "message-test-order", "hash", createdAt, createdAt);
    const session = { user: { id: customer.id, role: customer.role, name: customer.name, email: customer.email } };
    const first = await direct(fixture, session, `/api/orders/${orderId}/messages`, { method: "POST", headers: { "idempotency-key": "hello-1" }, body: { message: "Please leave it at reception." } });
    assert.equal(first.status, 201); assert.equal(first.body.data.message, "Please leave it at reception.");
    const stored = fixture.db.prepare("SELECT * FROM order_messages WHERE id=?").get(first.body.data.id); assert.doesNotMatch(stored.ciphertext, /reception/); assert.notEqual(stored.ciphertext, first.body.data.message);
    const replay = await direct(fixture, session, `/api/orders/${orderId}/messages`, { method: "POST", headers: { "idempotency-key": "hello-1" }, body: { message: "Please leave it at reception." } }); assert.equal(replay.status, 200); assert.equal(replay.body.data.id, first.body.data.id);
    const list = await direct(fixture, session, `/api/orders/${orderId}/messages`); assert.equal(list.body.data.items.length, 1);
    await assert.rejects(direct(fixture, session, `/api/orders/${orderId}/messages?limit=1.5`), (error) => error.code === "VALIDATION_ERROR");
    fixture.db.prepare("INSERT INTO user_notifications(id,user_id,type,title,message,order_id,restaurant_id,event_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), customer.id, "order_message", "New order message", "Generic only", orderId, restaurant.id, `order-message:${first.body.data.id}`, first.body.data.createdAt);
    const read = await direct(fixture, session, `/api/orders/${orderId}/messages/read`, { method: "POST", body: { lastMessageId: first.body.data.id } }); assert.equal(read.body.data.unreadCount, 0);
    assert.ok(fixture.db.prepare("SELECT read_at FROM user_notifications WHERE user_id=? AND event_key=?").get(customer.id, `order-message:${first.body.data.id}`).read_at);
    fixture.db.prepare("UPDATE order_messages SET expires_at='2020-01-01T00:00:00.000Z'").run(); await assert.rejects(direct(fixture, session, `/api/orders/${orderId}/messages`, { method: "POST", headers: { "idempotency-key": "hello-1" }, body: { message: "Please leave it at reception." } }), (error) => error.code === "MESSAGE_EXPIRED"); assert.equal(runMessageRetention(fixture.db, fixture.config), 1); assert.equal(fixture.db.prepare("SELECT COUNT(*) count FROM order_messages").get().count, 0);
  } finally { await fixture.close(); }
});

test("restaurant message settings require exactly six responses and cap support at 24 hours", async () => {
  const fixture = await journeyFixture();
  try {
    ensureMessagingSchema(fixture.db); const owner = fixture.db.prepare("SELECT * FROM users WHERE email='restaurant@calai.local'").get(); const membership = fixture.db.prepare("SELECT * FROM restaurant_memberships WHERE user_id=?").get(owner.id); const session = { user: { id: owner.id, role: owner.role, name: owner.name, email: owner.email } };
    const result = await direct(fixture, session, `/api/restaurant/restaurants/${membership.restaurant_id}/message-settings`, { method: "PATCH", body: { quickResponses: ["One", "Two", "Three", "Four", "Five", "Six"], supportWindowMinutes: 1440 } }); assert.equal(result.status, 200); assert.equal(result.body.data.quickResponses.length, 6); assert.equal(result.body.data.supportWindowMinutes, 1440);
  } finally { await fixture.close(); }
});

test("closed conversations reject messages and retention uses the exact expiry boundary", async () => {
  const fixed = new Date("2026-02-01T12:00:00.000Z"); const fixture = await journeyFixture({ now: () => fixed });
  try {
    ensureMessagingSchema(fixture.db); const customer = fixture.db.prepare("SELECT * FROM users WHERE email='customer@calai.local'").get(); const restaurant = fixture.db.prepare("SELECT * FROM restaurants WHERE status='approved'").get(); const orderId = randomUUID();
    fixture.db.prepare("INSERT INTO orders(id,restaurant_id,restaurant_name,customer_id,status,subtotal_minor,total_minor,commission_minor,payment_method,payment_status,fulfillment,idempotency_key,request_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(orderId, restaurant.id, restaurant.name, customer.id, "completed", 1000, 1000, 70, "cash", "cash_collected", "collection", "closed-order", "hash", "2026-01-01T00:00:00.000Z", "2026-01-01T01:00:00.000Z");
    fixture.db.prepare("INSERT INTO order_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(), orderId, customer.id, "status_changed", "ready", "completed", "2026-01-01T01:00:00.000Z"); const session = { user: { id: customer.id, role: "customer" } };
    await assert.rejects(direct(fixture, session, `/api/orders/${orderId}/messages`, { method: "POST", headers: { "idempotency-key": "late" }, body: { message: "Too late" } }), (error) => error.code === "MESSAGING_CLOSED");
    fixture.db.prepare("INSERT INTO order_messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), orderId, customer.id, "customer", "expired", "hash", "x", "x", "x", "v1", "2026-01-02T12:00:00.000Z", fixed.toISOString());
    assert.equal(runMessageRetention(fixture.db, fixture.config), 1);
  } finally { await fixture.close(); }
});

test("SSE catch-up is isolated and closes after session revocation over real HTTP", async (t) => {
  const fixture = await journeyFixture(); let server; let hub;
  try {
    await fixture.login("customer@calai.local", "LocalCustomer!4310"); const customer = fixture.db.prepare("SELECT * FROM users WHERE email='customer@calai.local'").get(); const owner = fixture.db.prepare("SELECT * FROM users WHERE email='restaurant@calai.local'").get(); const session = fixture.db.prepare("SELECT * FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 1").get(customer.id); const now = fixture.config.now().toISOString();
    fixture.db.prepare("INSERT INTO user_notifications(id,user_id,type,title,message,event_key,created_at) VALUES(?,?,?,?,?,?,?)").run("customer-event", customer.id, "order_status", "Customer only", "Visible", "sse-customer", now);
    fixture.db.prepare("INSERT INTO user_notifications(id,user_id,type,title,message,event_key,created_at) VALUES(?,?,?,?,?,?,?)").run("owner-event", owner.id, "order_status", "Owner only", "Hidden", "sse-owner", now);
    hub = notificationStreamHub(fixture.db, { pollMs: 10_000, heartbeatMs: 25, now: fixture.config.now }); server = createHttpServer((req, res) => hub.subscribe({ req, res, userId: customer.id, sessionId: session.id })); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let text; try { text = await new Promise((resolve, reject) => { let output = "", timeout; const request = httpGet(`http://127.0.0.1:${server.address().port}/stream`, (response) => { response.on("data", (chunk) => { output += chunk; if (output.includes("customer-event")) fixture.db.prepare("UPDATE sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(fixture.config.now().toISOString(), session.id); }); response.on("end", () => { clearTimeout(timeout); resolve(output); }); }); request.on("error", (error) => { clearTimeout(timeout); reject(error); }); timeout = setTimeout(() => { request.destroy(new Error("SSE did not close")); }, 2000); timeout.unref(); }); } catch (error) { if (error.code === "EACCES") { t.skip("Loopback HTTP is blocked in this environment"); return; } throw error; }
    assert.match(text, /customer-event/); assert.doesNotMatch(text, /owner-event/);
  } finally { hub?.close(); if (server) await new Promise((resolve) => server.close(resolve)); await fixture.close(); }
});

test("message incidents are tenant scoped and store no chat content", async () => {
  const fixture = await journeyFixture();
  try {
    ensureMessagingSchema(fixture.db); const customer = fixture.db.prepare("SELECT * FROM users WHERE email='customer@calai.local'").get(); const restaurant = fixture.db.prepare("SELECT * FROM restaurants WHERE status='approved'").get(); const orderId = randomUUID(), stamp = fixture.config.now().toISOString();
    fixture.db.prepare("INSERT INTO orders(id,restaurant_id,restaurant_name,customer_id,status,subtotal_minor,total_minor,commission_minor,payment_method,payment_status,fulfillment,idempotency_key,request_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(orderId, restaurant.id, restaurant.name, customer.id, "placed", 1000, 1000, 70, "cash", "cash_due", "collection", "incident-order", "hash", stamp, stamp);
    const session = { user: { id: customer.id, role: "customer" } }; const reported = await direct(fixture, session, `/api/orders/${orderId}/message-incidents`, { method: "POST", body: { reason: "Restaurant sent an inappropriate response" } }); assert.equal(reported.status, 201);
    const row = fixture.db.prepare("SELECT * FROM order_message_incidents WHERE id=?").get(reported.body.data.id); assert.equal(row.order_id, orderId); assert.equal(Object.hasOwn(row, "message"), false); assert.equal(Object.hasOwn(row, "ciphertext"), false);
    const unrelated = { user: { id: randomUUID(), role: "customer" } }; await assert.rejects(direct(fixture, unrelated, `/api/orders/${orderId}/message-incidents`, { method: "POST", body: { reason: "Should not work" } }), (error) => error.code === "NOT_FOUND");
  } finally { await fixture.close(); }
});
