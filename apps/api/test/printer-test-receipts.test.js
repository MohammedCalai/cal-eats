import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { formatReceipt } from "../../print-bridge/src/receipt.js";
import { businessDeviceFixture } from "./business-device-fixture.js";

async function kitchen(f) {
  const owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310"), other = await f.login("restaurant2@calai.local", "LocalRestaurant2!4310"), customer = await f.login("customer@calai.local", "LocalCustomer!4310");
  const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0], root = `/api/restaurant/restaurants/${restaurant.id}`;
  const response = await f.json(`${root}/printers`, { method: "POST", cookie: owner, body: { name: "Kitchen printer", enabled: true, ipAddress: "192.0.2.25" } });
  assert.equal(response.status, 201, response.text);
  const printer = response.body.data, printerPath = `${root}/printers/${printer.id}`;
  const pair = async (name) => {
    const codeResponse = await f.json(`${printerPath}/pairing-code`, { method: "POST", cookie: owner, body: {} });
    assert.equal(codeResponse.status, 201, codeResponse.text);
    const paired = await f.signed("/api/devices/pair", { code: codeResponse.body.data.code, name });
    assert.equal(paired.status, 201, paired.text);
    return { data: paired.body.data, headers: { authorization: `Bearer ${paired.body.data.token}` } };
  };
  const first = await pair("First Windows tablet");
  const heartbeat = async (device = first, reachable = true) => {
    const result = await f.signed("/api/devices/heartbeat", { printerReachable: reachable, transport: "tcp-escpos" }, { headers: device.headers });
    assert.equal(result.status, 200, result.text);
  };
  const claim = (device = first) => f.signed("/api/devices/jobs/claim", {}, { headers: device.headers });
  const submitting = (job, device = first) => f.signed(`/api/devices/jobs/${job.id}/submitting`, { claimToken: job.claimToken }, { headers: device.headers });
  const ack = (job, outcome = "uncertain", device = first) => f.signed(`/api/devices/jobs/${job.id}/ack`, { claimToken: job.claimToken, outcome }, { headers: device.headers });
  const diagnostic = (requestId = randomUUID(), cookie = owner) => cookie===owner ? f.signed(`${printerPath}/test-receipt`, { requestId }) : f.json(`${printerPath}/test-receipt`, { method:"POST",cookie,body:{requestId} });
  await heartbeat();
  return { owner, other, customer, restaurant, root, printer, printerPath, first, pair, heartbeat, claim, submitting, ack, diagnostic };
}

test("sample receipts are owner-only, idempotent and separate from real orders, customer data and money", async () => {
  let now = Date.parse("2026-01-01T01:00:00Z");
  const f = await businessDeviceFixture({ now: () => new Date(now) });
  f.db.prepare('DELETE FROM restaurant_printers WHERE id=?').run(f.printerId);
  try {
    const k = await kitchen(f);
    const counts = () => Object.fromEntries(["orders", "order_events", "marketplace_operations", "journal_postings", "stripe_order_payments"].map((table) => [table, f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));
    const before = counts();
    assert.equal((await k.diagnostic(randomUUID(), k.other)).status, 403);
    assert.equal((await k.diagnostic(randomUUID(), k.customer)).status, 403);
    assert.equal((await f.signed(`${k.printerPath}/test-receipt`, {})).status, 400);
    const requestId = randomUUID(), queued = await k.diagnostic(requestId);
    assert.equal(queued.status, 201, queued.text); assert.equal(queued.body.data.testReceipt, true); assert.match(queued.body.data.id, /^test-print-/);
    const replay = await k.diagnostic(requestId); assert.equal(replay.status, 200); assert.deepEqual(replay.body.data, queued.body.data);
    assert.equal((await k.diagnostic()).status, 409);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM printer_test_jobs").get().n, 1);
    assert.deepEqual(counts(), before);
    const claimed = await k.claim(); assert.equal(claimed.status, 200, claimed.text);
    const job = claimed.body.data.job; assert.equal(job.testReceipt, true); assert.equal(job.id, queued.body.data.id); assert.equal(job.receipt.testReceipt, true);
    const paper = formatReceipt(job.receipt).text;
    assert.match(paper, /PRINTER TEST - SAMPLE ONLY/); assert.match(paper, /DO NOT PREPARE OR DELIVER/); assert.match(paper, /PRINTER TEST - NO ORDER OR PAYMENT/);
    assert.match(paper, /Sample Customer/); assert.match(paper, /10 Sample Street/); assert.match(paper, /TE57 1NG/); assert.match(paper, /Chicken Tikka Masala/); assert.match(paper, /TOTAL\s+£27\.50/);
    assert.equal((await k.ack(job, "printed")).status, 200); assert.equal((await k.ack(job, "printed")).status, 200); assert.equal((await k.ack(job, "uncertain")).status, 409);
    assert.deepEqual(counts(), before);
    const expiring = await k.diagnostic(); assert.equal(expiring.status, 201, expiring.text);
    f.advance(5 * 60000 + 1); await k.heartbeat();
    assert.equal((await k.claim()).body.data.job, null);
    assert.equal(f.db.prepare("SELECT status FROM printer_test_jobs WHERE id=?").get(expiring.body.data.id).status, "cancelled");
    await f.pulse();
    assert.equal((await k.diagnostic()).status, 201);
    const last = (await k.claim()).body.data.job;
    await k.submitting(last); f.advance(30001);
    const late = await k.ack(last, "printed"); assert.equal(late.status, 409, late.text);
    assert.equal(f.db.prepare("SELECT status FROM printer_test_jobs WHERE id=?").get(last.id).status, "uncertain");
    assert.equal((await k.ack(last, "uncertain")).status, 200);
    assert.equal((await k.claim()).body.data.job, null);
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { await f.close(); }
});

test("one printer serialises real receipts and diagnostics across devices, prioritises orders and never redispatches expired claims", async () => {
  let now = Date.parse("2026-01-01T01:00:00Z");
  const f = await businessDeviceFixture({ now: () => new Date(now) });
  f.db.prepare('DELETE FROM restaurant_printers WHERE id=?').run(f.printerId);
  try {
    const k = await kitchen(f), second = await k.pair("Second Windows tablet");
    await k.heartbeat(second);
    const diagnostic = await k.diagnostic(); assert.equal(diagnostic.status, 201, diagnostic.text);
    const item = (await f.json(`/api/restaurants/${k.restaurant.id}/menu`)).body.data.items[0];
    let sequence = 0;
    const acceptOrder = async () => {
      const placed = await f.json("/api/orders", { method: "POST", cookie: k.customer, headers: { "Idempotency-Key": `printer-serial-${sequence++}` }, body: { restaurantId: k.restaurant.id, items: [{ menuItemId: item.id, quantity: 2 }], paymentMethod: "cash", fulfillment: "delivery", deliveryAddress: { line1: "1 Main Street", line2: "Flat 2", city: "Luton", postcode: "LU1 1AA" } } });
      assert.equal(placed.status, 201, placed.text);
      const accepted = await f.signed(`/api/restaurant/orders/${placed.body.data.id}/status`, { status: "accepted" }, { method: "PATCH" });
      assert.equal(accepted.status, 200, accepted.text);
      return placed.body.data;
    };
    const order = await acceptOrder(), claimed = await k.claim(); assert.equal(claimed.status, 200, claimed.text);
    const job = claimed.body.data.job; assert.equal(job.testReceipt, false); assert.equal(job.receipt.orderNumber, order.id);
    assert.deepEqual(job.receipt.deliveryAddress, { line1: "1 Main Street", line2: "Flat 2", city: "Luton", postcode: "LU1 1AA" });
    const paper = formatReceipt(job.receipt).text;
    assert.match(paper, /1 Main Street/); assert.match(paper, /Flat 2/); assert.match(paper, /Luton\s+LU1 1AA/); assert.equal(paper.includes("[object Object]"), false); assert.equal(paper.includes("PRINTER TEST"), false);
    const replay = (await k.claim()).body.data.job; assert.equal(replay.id, job.id); assert.notEqual(replay.claimToken, job.claimToken);
    assert.equal((await k.claim(second)).body.data.job, null);
    assert.equal((await k.ack(job, "printed", second)).status, 401);
    assert.equal((await f.signed(`/api/devices/jobs/${job.id}/ack`, { claimToken: "incorrect_claim_token_abcdefghijklmnopqrstuvwxyz", outcome: "printed" }, { headers: k.first.headers })).status, 401);
    assert.equal((await k.ack(job)).status, 200);
    const next = (await k.claim(second)).body.data.job; assert.equal(next.id, diagnostic.body.data.id); assert.equal(next.testReceipt, true);
    assert.equal((await k.claim()).body.data.job, null);
    await k.submitting(next, second); f.advance(30001); await k.heartbeat();
    assert.equal((await k.claim()).body.data.job, null);
    assert.equal(f.db.prepare("SELECT status FROM printer_test_jobs WHERE id=?").get(next.id).status, "uncertain");
    assert.equal((await k.ack(next, "printed", second)).status, 409);
    assert.equal((await k.ack(next, "uncertain", second)).status, 200);
    const oldOrder = await acceptOrder();
    f.db.prepare("UPDATE orders SET status='completed' WHERE id=?").run(oldOrder.id);
    assert.equal((await k.claim()).body.data.job, null);
    assert.equal(f.db.prepare("SELECT status FROM device_print_jobs WHERE order_id=?").get(oldOrder.id).status, "cancelled");
    const freshOrder = await acceptOrder(), physical = (await k.claim()).body.data.job;
    assert.equal(physical.receipt.orderNumber, freshOrder.id);
    await k.submitting(physical); f.advance(30001);
    const another = await k.claim(second); assert.equal(another.body.data.job, null);
    assert.equal(f.db.prepare("SELECT status FROM device_print_jobs WHERE id=?").get(physical.id).status, "uncertain");
    assert.equal((await k.ack(physical, "printed")).status, 409);
    assert.equal((await k.ack(physical, "uncertain")).status, 200);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM device_print_jobs WHERE status='claimed'").get().n, 0);
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { await f.close(); }
});
