import assert from "node:assert/strict";
import test from "node:test";
import { journeyFixture } from "./helpers.js";

test("business browser and native confirmations queue one original receipt per enabled restaurant printer", async () => {
  let rejectCapture = false;
  const f = await journeyFixture({ now: () => new Date("2026-01-01T01:00:00.000Z"), mockCapture: () => ({ ok: !rejectCapture }) });
  try {
    const owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310");
    const otherOwner = await f.login("restaurant2@calai.local", "LocalRestaurant2!4310");
    const customer = await f.login("customer@calai.local", "LocalCustomer!4310");
    const native = await f.json("/api/native/business/auth/login", { method: "POST", body: { email: "restaurant@calai.local", password: "LocalRestaurant!4310" } });
    assert.equal(native.status, 200, native.text);
    const nativeHeaders = { authorization: `Bearer ${native.body.data.token}` };
    const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0];
    const otherRestaurant = (await f.json("/api/restaurant/restaurants", { cookie: otherOwner })).body.data[0];
    const root = `/api/restaurant/restaurants/${restaurant.id}`;
    const item = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
    async function printer(name, enabled = true, path = root, cookie = owner) {
      const response = await f.json(`${path}/printers`, { method: "POST", cookie, body: { name, enabled } });
      assert.equal(response.status, 201, response.text);
      return response.body.data;
    }
    const front = await printer("Front counter"), kitchen = await printer("Kitchen"), disabled = await printer("Disabled", false), revoked = await printer("Revoked");
    await f.json(`${root}/printers/${revoked.id}`, { method: "PATCH", cookie: owner, body: { revoked: true } });
    await printer("Other restaurant", true, `/api/restaurant/restaurants/${otherRestaurant.id}`, otherOwner);
    let sequence = 0;
    async function place(paymentMethod = "mock_card") {
      const response = await f.json("/api/orders", { method: "POST", cookie: customer, headers: { "Idempotency-Key": `print-order-${sequence++}` }, body: { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], paymentMethod, fulfillment: "collection" } });
      assert.equal(response.status, 201, response.text);
      return response.body.data;
    }
    const count = () => f.db.prepare("SELECT COUNT(*) AS count FROM device_print_jobs").get().count;
    const order = await place(), route = `/api/restaurant/orders/${order.id}/status`, decision = { status: "accepted", estimatedReadyAt: "2026-01-01T01:30:00.000Z" };
    assert.equal(count(), 0, "Checkout alone must not print a kitchen receipt");
    assert.equal((await f.json(`${root}/printers/${front.id}/reprints`, { method: "POST", cookie: owner, body: { orderId: order.id } })).body.error.code, "ORDER_NOT_CONFIRMED");
    assert.equal((await f.json(route, { method: "PATCH", cookie: customer, body: decision })).status, 403);
    assert.equal((await f.json(route, { method: "PATCH", cookie: otherOwner, body: decision })).status, 404);
    assert.equal((await f.json(route, { method: "PATCH", cookie: owner, body: { ...decision, estimatedReadyAt: "invalid" } })).status, 400);
    rejectCapture = true;
    const failed = await f.json(route, { method: "PATCH", cookie: owner, body: decision });
    assert.equal(failed.body.error.code, "PAYMENT_CAPTURE_FAILED");
    assert.equal(count(), 0, "Failed confirmation must not create print jobs");
    rejectCapture = false;
    assert.equal((await f.json(route, { method: "PATCH", cookie: owner, body: decision })).status, 200);
    const originals = f.db.prepare("SELECT * FROM device_print_jobs ORDER BY printer_id").all();
    assert.equal(originals.length, 2);
    assert.deepEqual(originals.map(row => row.printer_id).sort(), [front.id, kitchen.id].sort());
    for (const row of originals) {
      assert.equal(row.status, "queued"); assert.equal(row.manual_reprint, 0);
      const receipt = JSON.parse(row.receipt);
      assert.equal(receipt.orderNumber, order.id); assert.equal(receipt.totalMinor, order.totalMinor);
      assert.equal(receipt.paymentStatus, "mock_captured");
    }
    const replays = await Promise.all([
      f.json(route, { method: "PATCH", cookie: owner, body: decision }),
      f.json(route, { method: "PATCH", headers: nativeHeaders, body: decision })
    ]);
    assert.ok(replays.every(row => row.status === 200)); assert.equal(count(), 2);
    for (const status of ["preparing", "ready", "completed"]) assert.equal((await f.json(route, { method: "PATCH", headers: nativeHeaders, body: { status } })).status, 200);
    assert.equal(count(), 2, "Later order updates must not print another original");
    const next = await place("cash");
    assert.equal((await f.json(`/api/restaurant/orders/${next.id}/status`, { method: "PATCH", headers: nativeHeaders, body: decision })).status, 200);
    assert.equal(count(), 4, "A new native business confirmation must print both configured copies");
    const rejected = await place("cash");
    assert.equal((await f.json(`/api/restaurant/orders/${rejected.id}/status`, { method: "PATCH", cookie: owner, body: { status: "rejected" } })).status, 200);
    assert.equal((await f.request(`/api/orders/${order.id}/receipt`, { cookie: owner })).status, 200);
    assert.equal((await f.request(`/api/orders/${order.id}/receipt`, { cookie: owner })).status, 200);
    assert.equal(count(), 4, "Rejected orders and receipt views must not enqueue receipts");
    assert.equal((await f.json(`${root}/printers/${disabled.id}/reprints`, { method: "POST", cookie: owner, body: { orderId: order.id } })).body.error.code, "PRINTER_DISABLED");
    const copy = await f.json(`${root}/printers/${front.id}/reprints`, { method: "POST", cookie: owner, body: { orderId: order.id } });
    assert.equal(copy.status, 201, copy.text); assert.equal(copy.body.data.manualReprint, true);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM device_print_jobs WHERE manual_reprint=0").get().n, 4);
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { await f.close(); }
});

test("printer connection and queue summaries stay scoped and never expose device secrets", async () => {
  let now = Date.parse("2026-01-01T01:00:00.000Z");
  const f = await journeyFixture({ now: () => new Date(now) });
  try {
    const owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310"), customer = await f.login("customer@calai.local", "LocalCustomer!4310"), other = await f.login("restaurant2@calai.local", "LocalRestaurant2!4310");
    const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0], root = `/api/restaurant/restaurants/${restaurant.id}`;
    const printer = (await f.json(`${root}/printers`, { method: "POST", cookie: owner, body: { name: "Kitchen", enabled: true } })).body.data;
    const state = async () => (await f.json(`${root}/printers`, { cookie: owner })).body.data.items[0];
    assert.equal((await state()).status, "awaiting_device");
    const code = (await f.json(`${root}/printers/${printer.id}/pairing-code`, { method: "POST", cookie: owner, body: {} })).body.data.code;
    const paired = (await f.json("/api/devices/pair", { method: "POST", body: { code, name: "File-sink simulator" } })).body.data;
    const headers = { authorization: `Bearer ${paired.token}` };
    assert.equal((await state()).status, "offline"); assert.equal((await state()).pairedDeviceCount, 1);
    await f.json("/api/devices/heartbeat", { method: "POST", headers, body: {} });
    assert.equal((await state()).status, "online");
    now += 60001; assert.equal((await state()).status, "offline");
    const item = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
    const order = (await f.json("/api/orders", { method: "POST", cookie: customer, headers: { "Idempotency-Key": "health-print" }, body: { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], paymentMethod: "cash", fulfillment: "collection" } })).body.data;
    assert.equal((await f.json(`/api/restaurant/orders/${order.id}/status`, { method: "PATCH", cookie: owner, body: { status: "accepted" } })).status, 200);
    assert.equal((await state()).jobs.queued, 1);
    const claim = (await f.json("/api/devices/jobs/claim", { method: "POST", headers, body: {} })).body.data.job;
    assert.equal((await state()).jobs.claimed, 1);
    await f.json(`/api/devices/jobs/${claim.id}/ack`, { method: "POST", headers, body: { claimToken: claim.claimToken, outcome: "uncertain" } });
    const summary = await state(); assert.equal(summary.jobs.uncertain, 1); assert.equal(summary.jobs.claimed, 0);
    const serialized = JSON.stringify(summary);
    for (const secret of [paired.token, claim.claimToken, "token_hash", "receipt", "customerName"]) assert.equal(serialized.includes(secret), false);
    assert.equal((await f.json(`${root}/printers`, { cookie: customer })).status, 403);
    assert.equal((await f.json(`${root}/printers`, { cookie: other })).status, 404);
    await f.json(`${root}/printers/${printer.id}`, { method: "PATCH", cookie: owner, body: { enabled: false } });
    assert.equal((await state()).status, "disabled");
    await f.json(`${root}/printers/${printer.id}`, { method: "PATCH", cookie: owner, body: { revoked: true } });
    assert.equal((await state()).status, "revoked"); assert.equal((await state()).pairedDeviceCount, 0);
  } finally { await f.close(); }
});
