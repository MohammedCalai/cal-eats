import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { Readable } from "node:stream";
import { journeyFixture } from "./helpers.js";
import { createAPNsLiveActivityAdapter } from "../src/apns-live-activity-adapter.js";
import { LIVE_ACTIVITY_PROJECT, LIVE_ACTIVITY_TOPIC, LIVE_ACTIVITY_NAME, loadOrderLiveActivityConfig, runOrderLiveActivities, routeOrderLiveActivities, decryptLiveActivityToken } from "../src/order-live-activities.js";

const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const sender = { enabled: true, teamId: "HB56AJWWY2", keyId: "TESTKEY123", privateKey: keys.privateKey.export({ format: "pem", type: "pkcs8" }) };
async function fixture() {
  let clock = Date.parse("2026-01-01T10:00:00Z"), sequence = 0;
  const f = await journeyFixture({ now: () => new Date(clock), rateLimit: { attempts: 200, windowMs: 60000 }, messageEncryptionKey: Buffer.alloc(32, 61).toString("base64"), orderLiveActivities: sender });
  const login = await f.json("/api/native/auth/login", { method: "POST", body: { email: "customer@calai.local", password: "LocalCustomer!4310" } });
  const headers = { authorization: `Bearer ${login.body.data.token}` }, owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310"), admin = await f.login("admin@calai.local", "LocalAdmin!4310");
  const restaurant = f.db.prepare("SELECT * FROM restaurants WHERE name='Calai Kitchen'").get(), item = f.db.prepare("SELECT * FROM menu_items WHERE restaurant_id=? LIMIT 1").get(restaurant.id);
  const install = randomUUID();
  async function place(fulfillment = "delivery", customerHeaders = headers, extra = {}) {
    const response = await f.json("/api/orders", { method: "POST", headers: { ...customerHeaders, "Idempotency-Key": `activity-order-${sequence++}` }, body: { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], paymentMethod: "cash", fulfillment, ...(fulfillment === "delivery" ? { deliveryAddress: { line1: "PRIVATE_ADDRESS_MARKER", city: "Luton", postcode: "LU1 2AB" } } : {}), ...extra } });
    assert.equal(response.status, 201, response.text); return response.body.data;
  }
  const body = (orderId, extra = {}) => ({ installationId: install, activityId: randomUUID(), orderId, pushToken: "aa".repeat(32), platform: "ios", projectId: LIVE_ACTIVITY_PROJECT, ...extra });
  const register = (value, customHeaders = headers) => f.json("/api/native/live-activities", { method: "POST", headers: customHeaders, body: value });
  const advance = ms => { clock += ms; };
  const transition = async (order, status, extra = {}) => { advance(2000); const response = await f.json(`/api/restaurant/orders/${order.id}/status`, { method: "PATCH", cookie: owner, body: { status, ...extra } }); assert.equal(response.status, 200, response.text); return response.body.data; };
  const sent = [], adapter = { send: async (token, payload, { beforeSend, priority }) => { if (!beforeSend()) return { status: "cancelled" }; sent.push({ token, payload, priority }); return { status: "accepted", apnsId: randomUUID() }; } };
  const session = (await f.json("/api/native/auth/me", { headers })).body.data.session;
  return { ...f, headers, auth: login.body.data, session, owner, admin, restaurant, place, body, register, advance, transition, sent, adapter, now: () => clock };
}

test("native Live Activity registration validates identities, installations, encrypted tokens and generation/session boundaries", async () => {
  const f = await fixture(); try {
    const order = await f.place(), value = f.body(order.id);
    assert.equal((await f.json("/api/native/live-activities", { cookie: await f.login("customer@calai.local", "LocalCustomer!4310") })).status, 403);
    assert.equal((await f.json("/api/native/live-activities", { cookie: f.owner })).status, 403);
    assert.equal((await f.register({ ...value, installationId: [value.installationId] })).status, 400);
    assert.equal((await f.register({ ...value, activityId: [value.activityId] })).status, 400);
    assert.equal((await f.register({ ...value, projectId: randomUUID() })).status, 400);
    assert.equal((await f.register({ ...value, platform: "android" })).status, 400);
    assert.equal((await f.register({ ...value, orderId: randomUUID() })).status, 404);
    const registered = await f.register(value); assert.equal(registered.status, 200, registered.text); assert.equal(registered.body.data.updatesEnabled, true);
    const binding = () => f.db.prepare("SELECT * FROM customer_order_live_activities WHERE activity_id=?").get(value.activityId);
    assert.equal(decryptLiveActivityToken(f.config, binding()), value.pushToken);
    assert.ok(!JSON.stringify(binding()).includes(value.pushToken)); assert.ok(!registered.text.includes(value.pushToken));
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM customer_push_devices").get().count, 0, "ActivityKit must not depend on ordinary alert permission or an Expo token");
    const expiry = binding().expires_at; f.advance(60000); await f.register(value); assert.equal(binding().generation, 1); assert.equal(binding().expires_at, expiry);
    await f.register({ ...value, pushToken: "bb".repeat(32) }); assert.equal(binding().generation, 2); assert.equal(binding().expires_at, expiry);
    const nextLogin = await f.json("/api/native/auth/login", { method: "POST", body: { email: "customer@calai.local", password: "LocalCustomer!4310" } });
    const nextHeaders = { authorization: `Bearer ${nextLogin.body.data.token}` };
    const rebound = await f.register({ ...value, pushToken: "cc".repeat(32) }, nextHeaders); assert.equal(rebound.status, 200, rebound.text); assert.equal(binding().state, "active"); assert.equal(binding().generation, 3);
    assert.equal((await f.json(`/api/native/live-activities/${value.activityId}`, { method: "DELETE", headers: f.headers })).status, 200); assert.equal(binding().state, "active");
    const copied = f.body(order.id, { pushToken: "cc".repeat(32) }); assert.equal((await f.register(copied, nextHeaders)).body.error.code, "LIVE_ACTIVITY_TOKEN_IN_USE");
    const another = await f.place(); assert.equal((await f.register({ ...value, orderId: another.id }, nextHeaders)).body.error.code, "LIVE_ACTIVITY_BINDING_MISMATCH");
    const foreignId = randomUUID(), original = f.db.prepare("SELECT password_hash FROM users WHERE id=?").get(f.auth.user.id);
    f.db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,'Other customer','other-live@calai.local',?,'customer',?)").run(foreignId, original.password_hash, new Date(f.now()).toISOString());
    const foreign = await f.json("/api/native/auth/login", { method: "POST", body: { email: "other-live@calai.local", password: "LocalCustomer!4310" } }), foreignHeaders = { authorization: `Bearer ${foreign.body.data.token}` };
    assert.equal((await f.register(f.body(order.id), foreignHeaders)).status, 404);
    const foreignOrder = await f.place("collection", foreignHeaders);
    assert.equal((await f.register(f.body(foreignOrder.id, { pushToken: "dd".repeat(32) }), foreignHeaders)).body.error.code, "LIVE_ACTIVITY_INSTALLATION_IN_USE");
    assert.equal((await f.json("/api/admin/live-activities/readiness", { headers: nextHeaders })).status, 403);
    const ready = await f.json("/api/admin/live-activities/readiness", { cookie: f.admin }); assert.equal(ready.status, 200); assert.equal(ready.body.data.environment, "production"); assert.ok(!ready.text.includes(value.pushToken));
  } finally { await f.close(); }
});

test("registration rechecks native authentication after the request body has arrived", async () => {
  const f = await fixture(); try {
    const order = await f.place(), body = JSON.stringify(f.body(order.id)), session = { native: true, nativeAudience: "customer", user: f.auth.user, sessionId: f.session.id };
    const req = Readable.from((async function* () { yield Buffer.from(body.slice(0, 20)); f.db.prepare("UPDATE native_sessions SET revoked_at=? WHERE id=?").run(new Date(f.now()).toISOString(), session.sessionId); yield Buffer.from(body.slice(20)); })());
    Object.assign(req, { method: "POST", headers: { "content-type": "application/json" } });
    await assert.rejects(routeOrderLiveActivities({ req, res: {}, url: new URL("https://eats.calai.info/api/native/live-activities"), db: f.db, config: f.config, session }), error => error.code === "AUTH_REQUIRED");
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM customer_order_live_activities").get().count, 0);
  } finally { await f.close(); }
});

test("canonical customer status and ETA update independently of notification reads, through dispatch to Delivered/Collected", async () => {
  const f = await fixture(); try {
    const order = await f.place(), registration = await f.register(f.body(order.id)); assert.equal(registration.body.data.content.etaUnix, null);
    await runOrderLiveActivities(f.db, f.config, { adapter: f.adapter }); assert.equal(f.sent.at(-1).payload.aps.event, "update");
    const eta = new Date(f.now() + 45 * 60000).toISOString(), confirmed = await f.transition(order, "accepted", { estimatedReadyAt: eta });
    f.db.prepare("UPDATE user_notifications SET read_at=?").run(new Date(f.now()).toISOString());
    await runOrderLiveActivities(f.db, f.config, { adapter: f.adapter });
    const update = f.sent.at(-1).payload.aps, content = JSON.parse(update["content-state"].props);
    assert.equal(f.sent.at(-1).priority, 10, "Confirmed status and ETA must request prompt delivery");
    assert.equal(update["content-state"].name, LIVE_ACTIVITY_NAME); assert.equal(content.statusLabel, "Order confirmed"); assert.equal(content.etaUnix, Date.parse(confirmed.customerEtaAt) / 1000); assert.equal(content.etaUnix, Date.parse(eta) / 1000);
    assert.equal(update["stale-date"], Date.parse(eta) / 1000 + 15 * 60);
    const newEta = new Date(f.now() + 60 * 60000).toISOString(); f.advance(2000);
    const changed = await f.json(`/api/restaurant/orders/${order.id}/preparation`, { method: "PATCH", cookie: f.owner, body: { estimatedReadyAt: newEta } }); assert.equal(changed.status, 200, changed.text);
    await runOrderLiveActivities(f.db, f.config, { adapter: f.adapter }); assert.equal(JSON.parse(f.sent.at(-1).payload.aps["content-state"].props).etaUnix, Date.parse(changed.body.data.customerEtaAt) / 1000);
    for (const status of ["preparing", "ready", "out_for_delivery"]) { await f.transition(order, status); await runOrderLiveActivities(f.db, f.config, { adapter: f.adapter }); }
    assert.equal(f.sent.at(-1).payload.aps.event, "update"); assert.equal(JSON.parse(f.sent.at(-1).payload.aps["content-state"].props).statusLabel, "Your food is on its way");
    await f.transition(order, "completed"); await runOrderLiveActivities(f.db, f.config, { adapter: f.adapter });
    assert.equal(f.sent.at(-1).payload.aps.event, "end"); assert.equal(JSON.parse(f.sent.at(-1).payload.aps["content-state"].props).statusLabel, "Delivered"); assert.ok(f.sent.at(-1).payload.aps["dismissal-date"] < f.sent.at(-1).payload.aps.timestamp);
    const collection = await f.place("collection"); await f.register(f.body(collection.id, { pushToken: "ee".repeat(32) }));
    for (const status of ["accepted", "preparing", "ready", "completed"]) await f.transition(collection, status);
    await runOrderLiveActivities(f.db, f.config, { adapter: f.adapter }); assert.equal(JSON.parse(f.sent.at(-1).payload.aps["content-state"].props).statusLabel, "Collected");
    assert.ok(f.sent.every(item => !JSON.stringify(item.payload).includes("PRIVATE_ADDRESS_MARKER")));
    assert.ok(f.db.prepare("SELECT COUNT(*) count FROM customer_order_live_activities WHERE state='ended' AND ciphertext IS NULL").get().count >= 2);
  } finally { await f.close(); }
});

test("logout, disabled accounts and natural expiry deliver only a final privacy-safe end, even without a foreground app", async () => {
  for (const mode of ["logout", "disabled", "session_expired", "eight_hours"]) {
    const f = await fixture(); try {
      const order = await f.place(), value = f.body(order.id); await f.register(value);
      await runOrderLiveActivities(f.db, f.config, { adapter: f.adapter }); f.advance(2000);
      if (mode === "logout") await f.json("/api/native/auth/logout", { method: "POST", headers: f.headers, body: {} });
      if (mode === "disabled") f.db.prepare("UPDATE users SET account_enabled=0 WHERE id=?").run(f.auth.user.id);
      if (mode === "session_expired") f.db.prepare("UPDATE native_sessions SET expires_at=? WHERE id=?").run(new Date(f.now() - 1).toISOString(), f.session.id);
      if (mode === "eight_hours") f.advance(8 * 3600000);
      const result = await runOrderLiveActivities(f.db, f.config, { adapter: f.adapter }); assert.equal(result.ended, 1, mode);
      const sent = f.sent.at(-1).payload.aps, content = JSON.parse(sent["content-state"].props);
      assert.equal(sent.event, "end", mode); assert.equal(content.statusLabel, "Tracking ended", mode); assert.equal(content.restaurantName, "Cal-Eats"); assert.equal(content.etaUnix, null);
      assert.equal(f.db.prepare("SELECT ciphertext FROM customer_order_live_activities WHERE activity_id=?").get(value.activityId).ciphertext, null);
    } finally { await f.close(); }
  }
});

test("GET and POST accept yesterday's preorder near fulfillment, exclude stale/malformed/future orders and end terminal registration safely", async () => {
  const f = await fixture(); try {
    const visible = await f.place(), old = await f.place(), unpaid = await f.place(), scheduled = await f.place();
    const nearPreorder = await f.place(), stalePreorder = await f.place(), malformedPreorder = await f.place(), futureCreation = await f.place();
    f.db.prepare("UPDATE orders SET created_at=? WHERE id=?").run(new Date(f.now() - 9 * 3600000).toISOString(), old.id);
    f.db.prepare("UPDATE orders SET payment_status='stripe_pending',payment_method='card',merchant_visible_at=NULL WHERE id=?").run(unpaid.id);
    f.db.prepare("UPDATE orders SET scheduled_for=? WHERE id=?").run(new Date(f.now() + 3 * 3600000).toISOString(), scheduled.id);
    f.db.prepare("UPDATE orders SET created_at=?,scheduled_for=? WHERE id=?").run(new Date(f.now() - 24 * 3600000).toISOString(), new Date(f.now() + 3600000).toISOString(), nearPreorder.id);
    f.db.prepare("UPDATE orders SET created_at=?,scheduled_for=? WHERE id=?").run(new Date(f.now() - 24 * 3600000).toISOString(), new Date(f.now() - 8 * 3600000).toISOString(), stalePreorder.id);
    f.db.prepare("UPDATE orders SET scheduled_for='' WHERE id=?").run(malformedPreorder.id);
    f.db.prepare("UPDATE orders SET created_at=?,scheduled_for=? WHERE id=?").run(new Date(f.now() + 61000).toISOString(), new Date(f.now() + 3600000).toISOString(), futureCreation.id);
    const list = await f.json("/api/native/live-activities", { headers: f.headers }); assert.equal(list.status, 200, list.text); assert.deepEqual(list.body.data.items.map(item => item.orderId).sort(), [visible.id, nearPreorder.id].sort());
    const acceptedPreorder = await f.register(f.body(nearPreorder.id)); assert.equal(acceptedPreorder.status, 200, acceptedPreorder.text); assert.equal(acceptedPreorder.body.data.registered, true); assert.equal(acceptedPreorder.body.data.action, "update");
    for (const excluded of [old, scheduled, stalePreorder, malformedPreorder, futureCreation]) {
      const rejected = await f.register(f.body(excluded.id)); assert.equal(rejected.status, 200, rejected.text); assert.equal(rejected.body.data.registered, false); assert.equal(rejected.body.data.action, "end");
    }
    await f.transition(visible, "rejected"); const ended = await f.register(f.body(visible.id)); assert.equal(ended.body.data.action, "end"); assert.equal(ended.body.data.registered, false);
    const disabledConfig = { ...f.config, orderLiveActivities: { enabled: false } };
    const disabled = await runOrderLiveActivities(f.db, disabledConfig); assert.equal(disabled.disabled, true);
  } finally { await f.close(); }
});

test("rotation and an order change during a claimed send supersede the old generation/state without stale payloads", async () => {
  const f = await fixture(); try {
    const order = await f.place(), value = f.body(order.id); await f.register(value);
    let rotated = false;
    await runOrderLiveActivities(f.db, f.config, { adapter: f.adapter, beforeDispatch: async () => { if (!rotated) { rotated = true; await f.register({ ...value, pushToken: "ff".repeat(32) }); } } });
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0].token, "ff".repeat(32));
    await f.transition(order, "accepted"); let advanced = false;
    await runOrderLiveActivities(f.db, f.config, { adapter: f.adapter, beforeDispatch: async () => { if (!advanced) { advanced = true; await f.transition(order, "preparing"); } } });
    assert.equal(f.sent.length, 2); assert.equal(JSON.parse(f.sent.at(-1).payload.aps["content-state"].props).statusLabel, "Preparing your food");
    const times = f.sent.map(item => item.payload.aps.timestamp); assert.ok(times[1] > times[0]);
  } finally { await f.close(); }
});

test("retries, invalid activity tokens, same-second coalescing and disabled cleanup remain bounded and durable", async () => {
  const f = await fixture(); try {
    const order = await f.place(), value = f.body(order.id); await f.register(value);
    let attempts = 0;
    const flaky = { send: async (_token, _payload, { beforeSend }) => { if (!beforeSend()) return { status: "cancelled" }; attempts++; return { status: "retry", errorCode: "LIVE_ACTIVITY_NETWORK_RETRY" }; } };
    const result = await runOrderLiveActivities(f.db, f.config, { adapter: flaky }); assert.equal(result.failed, 1);
    await runOrderLiveActivities(f.db, f.config, { adapter: flaky }); assert.equal(attempts, 1);
    for (let i = 0; i < 4; i++) { f.advance(60000); await runOrderLiveActivities(f.db, f.config, { adapter: flaky }); }
    assert.equal(attempts, 5); const stopped = f.db.prepare("SELECT * FROM order_live_activity_outbox").get(); assert.equal(stopped.available_at, null); assert.equal(stopped.attempts, 5);
    await f.register({ ...value, pushToken: "ab".repeat(32) }); f.advance(2000);
    await runOrderLiveActivities(f.db, f.config, { adapter: { send: async (_token, _payload, { beforeSend }) => beforeSend() ? { status: "invalid_activity", errorCode: "LIVE_ACTIVITY_TOKEN_ENDED" } : { status: "cancelled" } } });
    assert.equal(f.db.prepare("SELECT state FROM customer_order_live_activities WHERE activity_id=?").get(value.activityId).state, "invalid");
    const second = f.body(order.id, { pushToken: "ac".repeat(32) }); await f.register(second); await runOrderLiveActivities(f.db, f.config, { adapter: f.adapter });
    f.db.prepare("UPDATE orders SET estimated_ready_at=?,updated_at=? WHERE id=?").run(new Date(f.now() + 3600000).toISOString(), new Date(f.now()).toISOString(), order.id);
    const deferred = await runOrderLiveActivities(f.db, f.config, { adapter: f.adapter }); assert.equal(deferred.deferred, 1); f.advance(1000); await runOrderLiveActivities(f.db, f.config, { adapter: f.adapter });
    const row = f.db.prepare("SELECT id FROM customer_order_live_activities WHERE activity_id=?").get(second.activityId);
    f.db.prepare("UPDATE users SET account_enabled=0 WHERE id=?").run(f.auth.user.id);
    await runOrderLiveActivities(f.db, { ...f.config, orderLiveActivities: { enabled: false } }); f.advance(6 * 60000);
    await runOrderLiveActivities(f.db, { ...f.config, orderLiveActivities: { enabled: false } });
    assert.equal(f.db.prepare("SELECT ciphertext FROM customer_order_live_activities WHERE id=?").get(row.id).ciphertext, null);
  } finally { await f.close(); }
});

test("direct APNs uses production ActivityKit headers, P-256 authentication and safe outcome codes", async () => {
  assert.equal(loadOrderLiveActivityConfig({}).enabled, false);
  assert.throws(() => loadOrderLiveActivityConfig({ CALAI_ORDER_LIVE_ACTIVITIES_ENABLED: "true" }), /private Apple sender/);
  assert.throws(() => loadOrderLiveActivityConfig({ CALAI_APNS_PRIVATE_KEY: "RAW_SECRET_INVALID_KEY" }), /private P-256/);
  const calls = [], responses = [{ status: 200, apnsId: randomUUID() }, { status: 403, reason: "TopicDisallowed" }, { status: 410, reason: "Unregistered" }, { status: 429 }, { status: 503 }, { status: 400, reason: "PRIVATE_RAW_ERROR_MARKER" }];
  const adapter = createAPNsLiveActivityAdapter(sender, { now: () => Date.parse("2026-01-01T10:00:00Z"), requestImpl: async (request, beforeSend) => { if (!beforeSend()) return { cancelled: true }; calls.push(request); return responses.shift(); } });
  const token = "ad".repeat(32), payload = { aps: { timestamp: 1767261600, event: "update", "stale-date": 1767265200, "content-state": { name: LIVE_ACTIVITY_NAME, props: "{}" } } };
  assert.equal((await adapter.send(token, payload, { beforeSend: () => false })).status, "cancelled");
  assert.equal((await adapter.send(token, payload, { beforeSend: () => true })).status, "accepted");
  const request = calls[0]; assert.equal(request.path, `/3/device/${token}`); assert.equal(request.headers["apns-topic"], LIVE_ACTIVITY_TOPIC); assert.equal(request.headers["apns-push-type"], "liveactivity"); assert.equal(request.headers["apns-priority"], "5");
  const jwt = request.headers.authorization.slice(7).split("."); assert.deepEqual(JSON.parse(Buffer.from(jwt[0], "base64url")), { alg: "ES256", kid: sender.keyId }); assert.equal(JSON.parse(Buffer.from(jwt[1], "base64url")).iss, sender.teamId);
  assert.equal(verify("sha256", Buffer.from(`${jwt[0]}.${jwt[1]}`), { key: keys.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(jwt[2], "base64url")), true);
  assert.equal((await adapter.send(token, payload, { beforeSend: () => true })).errorCode, "LIVE_ACTIVITY_TOPIC_DISALLOWED");
  assert.equal((await adapter.send(token, payload, { beforeSend: () => true })).status, "invalid_activity");
  assert.equal((await adapter.send(token, payload, { beforeSend: () => true })).status, "retry");
  assert.equal((await adapter.send(token, payload, { beforeSend: () => true })).status, "retry");
  assert.equal((await adapter.send(token, payload, { beforeSend: () => true })).errorCode, "LIVE_ACTIVITY_PROVIDER_REJECTED");
});
