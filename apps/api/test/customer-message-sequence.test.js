import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { journeyFixture } from "./helpers.js";
import { customerMessageSequenceMigration25 } from "../src/customer-message-sequence-migration.js";
import { runCustomerMessageRetention } from "../src/customer-relationships.js";

test("CRM ingestion cursor preserves late earlier-created messages and never reuses a purged sequence", async () => {
  // Upgrade a pre-sequence cursor by its actual acknowledged message, not a timestamp range.
  const old = new DatabaseSync(":memory:");
  try {
    old.exec(`CREATE TABLE restaurant_customer_threads(id TEXT PRIMARY KEY);
      CREATE TABLE restaurant_customer_messages(id TEXT PRIMARY KEY,thread_id TEXT,created_at TEXT);
      CREATE TABLE restaurant_customer_message_reads(thread_id TEXT,user_id TEXT,last_read_created_at TEXT,last_read_message_id TEXT,updated_at TEXT);
      INSERT INTO restaurant_customer_threads VALUES('thread');
      INSERT INTO restaurant_customer_messages(rowid,id,thread_id,created_at) VALUES(7,'acknowledged','thread','2026-01-01T02:00:00.000Z'),(15,'late','thread','2026-01-01T01:00:00.000Z');
      INSERT INTO restaurant_customer_message_reads VALUES('thread','customer','2026-01-01T02:00:00.000Z','acknowledged','2026-01-01T02:01:00.000Z');`);
    old.exec(customerMessageSequenceMigration25.sql);
    assert.equal(old.prepare("SELECT ingest_sequence n FROM restaurant_customer_messages WHERE id='late'").get().n, 15);
    assert.equal(old.prepare("SELECT last_read_sequence n FROM restaurant_customer_message_reads").get().n, 7);
    assert.equal(old.prepare("SELECT last_sequence n FROM restaurant_customer_thread_sequences").get().n, 15);
  } finally { old.close(); }

  let clock = Date.parse("2026-01-01T01:00:00.000Z");
  const f = await journeyFixture({ now: () => new Date(clock), sessionHours: 24 * 60 });
  try {
    const owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310"), customer = await f.login("customer@calai.local", "LocalCustomer!4310");
    const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0], item = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
    const order = await f.json("/api/orders", { method: "POST", cookie: customer, headers: { "Idempotency-Key": "sequence-history" }, body: { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], fulfillment: "collection", paymentMethod: "mock_card" } });
    assert.equal(order.status, 201, order.text);
    const route = `/api/restaurant/restaurants/${restaurant.id}/customers/${order.body.data.customerId}/conversation`;
    clock = Date.parse("2026-01-01T02:00:00.000Z");
    const first = await f.json(route, { method: "POST", cookie: owner, headers: { "Idempotency-Key": "sequence-first" }, body: { message: "First message, already read." } });
    assert.equal(first.status, 201, first.text); assert.equal(first.body.data.ingestSequence, 1);
    const threadId = first.body.data.threadId, readRoute = `/api/customer/conversations/${threadId}/read`, messageRoute = `/api/customer/conversations/${threadId}/messages`;
    assert.equal((await f.json(readRoute, { method: "POST", cookie: customer, body: { lastMessageId: first.body.data.id } })).body.data.unreadCount, 0);
    // A delayed persistence (or backwards clock correction) has an older creation timestamp.
    clock = Date.parse("2026-01-01T01:30:00.000Z");
    const lateBody = { message: "Persisted later, although created earlier." }, late = await f.json(route, { method: "POST", cookie: owner, headers: { "Idempotency-Key": "sequence-late" }, body: lateBody });
    assert.equal(late.status, 201, late.text); assert.equal(late.body.data.ingestSequence, 2); assert.ok(late.body.data.createdAt < first.body.data.createdAt);
    const afterLate = await f.json(messageRoute, { cookie: customer });
    assert.equal(afterLate.body.data.unreadCount, 1); assert.equal(afterLate.body.data.items.at(-1).id, first.body.data.id); assert.equal(afterLate.body.data.readThroughMessageId, late.body.data.id);
    const replay = await f.json(route, { method: "POST", cookie: owner, headers: { "Idempotency-Key": "sequence-late" }, body: lateBody });
    assert.equal(replay.status, 200); assert.equal(replay.body.data.ingestSequence, 2); assert.equal(f.db.prepare("SELECT last_sequence n FROM restaurant_customer_thread_sequences WHERE thread_id=?").get(threadId).n, 2);
    assert.equal((await f.json(readRoute, { method: "POST", cookie: customer, body: { lastMessageId: first.body.data.id } })).body.data.unreadCount, 1);
    assert.equal(f.db.prepare("SELECT read_at FROM user_notifications WHERE event_key=? AND user_id=?").get(`customer-message:${late.body.data.id}`, order.body.data.customerId).read_at, null);
    assert.equal((await f.json(readRoute, { method: "POST", cookie: customer, body: { lastMessageId: afterLate.body.data.readThroughMessageId } })).body.data.unreadCount, 0);
    assert.equal(f.db.prepare("SELECT last_read_sequence n FROM restaurant_customer_message_reads WHERE thread_id=? AND user_id=?").get(threadId, order.body.data.customerId).n, 2);
    clock = Date.parse(first.body.data.expiresAt) + 1;
    assert.equal(runCustomerMessageRetention(f.db, f.config), 2);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM restaurant_customer_messages WHERE thread_id=?").get(threadId).n, 0);
    assert.equal(f.db.prepare("SELECT last_sequence n FROM restaurant_customer_thread_sequences WHERE thread_id=?").get(threadId).n, 2);
    const fresh = await f.json(route, { method: "POST", cookie: owner, headers: { "Idempotency-Key": "sequence-after-purge" }, body: { message: "A fresh message after all old bodies expired." } });
    assert.equal(fresh.status, 201, fresh.text); assert.equal(fresh.body.data.ingestSequence, 3);
    assert.equal(f.db.prepare("SELECT rowid n FROM restaurant_customer_messages WHERE id=?").get(fresh.body.data.id).n, 1);
    assert.equal((await f.json(messageRoute, { cookie: customer })).body.data.unreadCount, 1);
    assert.equal((await f.json(readRoute, { method: "POST", cookie: customer, body: { lastMessageId: fresh.body.data.id } })).body.data.unreadCount, 0);
  } finally { await f.close(); }
});
