import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import { formatReceipt } from "../../print-bridge/src/receipt.js";
import { requestAllowed } from "../../terminal-auth/src/protocol.js";
import { journeyFixture } from "./helpers.js";
import {enrolRegisteredTablet} from "./registered-tablet-fixture.js";
import { parseSessionCookie, readSession } from "../src/auth/sessions.js";
import { routeMarketplace } from "../src/marketplace.js";
import { thermalPaymentLabel } from "../src/thermal-receipt.js";

async function kitchen(f) {
  const owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310"), other = await f.login("restaurant2@calai.local", "LocalRestaurant2!4310"), customer = await f.login("customer@calai.local", "LocalCustomer!4310");
  const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0], root = `/api/restaurant/restaurants/${restaurant.id}`;
  const tablet = await enrolRegisteredTablet(f, {ownerCookie: owner});
  const response = await f.json(`${root}/printers`, { method: "POST", cookie: owner, body: { name: "Kitchen printer", enabled: true, ipAddress: "192.0.2.25" } });
  assert.equal(response.status, 201, response.text);
  const printer = response.body.data, printerPath = `${root}/printers/${printer.id}`;
  const pair = async (name) => {
    const codeResponse = await f.json(`${printerPath}/pairing-code`, { method: "POST", cookie: owner, body: {} });
    assert.equal(codeResponse.status, 201, codeResponse.text);
    const paired = await f.json("/api/devices/pair", { method: "POST", body: { code: codeResponse.body.data.code, name } });
    assert.equal(paired.status, 201, paired.text);
    return { data: paired.body.data, headers: { authorization: `Bearer ${paired.body.data.token}` } };
  };
  const first = await pair("First Windows tablet");
  const heartbeat = async (device = first, reachable = true) => {
    const result = await f.json("/api/devices/heartbeat", { method: "POST", headers: device.headers, body: { printerReachable: reachable, transport: "tcp-escpos" } });
    assert.equal(result.status, 200, result.text);
  };
  const claim = (device = first) => f.json("/api/devices/jobs/claim", { method: "POST", headers: device.headers, body: {} });
  const ack = (job, outcome = "uncertain", device = first) => f.json(`/api/devices/jobs/${job.id}/ack`, { method: "POST", headers: device.headers, body: { claimToken: job.claimToken, outcome } });
  const diagnostic = (requestId = randomUUID(), cookie) => cookie ? f.json(`${printerPath}/test-receipt`, { method: "POST", cookie, body: { requestId } }) : tablet.json(`${printerPath}/test-receipt`, {method: "POST", body: {requestId}});
  await heartbeat();
  return { owner, other, customer, restaurant, root, printer, printerPath, first, pair, heartbeat, claim, ack, diagnostic, tablet };
}

test("the reprint printer list exposes only eligible same-location names and IDs to the owner or signed tablet", async t => {
  const f = await journeyFixture();
  t.after(() => f.close());
  const k = await kitchen(f), restaurantId = k.restaurant.id, at = f.config.now().toISOString();
  const foreign = (await f.json("/api/restaurant/restaurants", { cookie: k.other })).body.data[0];
  function printer({ enabled = 1, revoked = null, location = restaurantId, deviceLocation = location, deviceRevoked = null, paired = true } = {}) {
    const id = randomUUID();
    f.db.prepare("INSERT INTO restaurant_printers(id,restaurant_id,name,enabled,revoked_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run(id, location, `Synthetic printer ${id.slice(0, 8)}`, enabled, revoked, at, at);
    if (paired) f.db.prepare("INSERT INTO printer_devices(id,printer_id,restaurant_id,name,token_hash,revoked_at,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(randomUUID(), id, deviceLocation, "Synthetic device", randomUUID(), deviceRevoked, at);
  }
  printer({ enabled: 0 });
  printer({ revoked: at });
  printer({ deviceRevoked: at });
  printer({ paired: false });
  printer({ location: foreign.id });
  printer({ deviceLocation: foreign.id });
  await k.pair("Second device for the same printer");

  const list = `${k.root}/printers?scope=reprint`;
  assert.equal(requestAllowed("GET", list, restaurantId, k.tablet.businessId), true);
  const owner = await f.json(list, { cookie: k.owner });
  assert.equal(owner.status, 200, owner.text);
  assert.equal((await f.json(list, { cookie: k.other })).status, 404);
  assert.equal((await k.tablet.json(`/api/restaurant/restaurants/${foreign.id}/printers?scope=reprint`)).status, 404);
  const result = await k.tablet.json(list);
  assert.equal(result.status, 200, result.text);
  assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(result.body.data, { items: [{ id: k.printer.id, name: k.printer.name }] });
  assert.deepEqual(owner.body.data, result.body.data);

  const ownerDetails = await f.json(`${k.root}/printers`, { cookie: k.owner });
  assert.equal(ownerDetails.status, 200, ownerDetails.text);
  assert.equal(ownerDetails.body.data.items.find(item => item.id === k.printer.id).ipAddress, "192.0.2.25");
  assert.equal((await k.tablet.json(`${k.root}/printers`)).status, 403);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM device_print_jobs").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM printer_test_jobs").get().n, 0);
});

test("a current website owner can queue a confirmed copy without pairing a tablet, with no wider power", async t => {
  const f = await journeyFixture();
  t.after(() => f.close());
  const owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310"), admin = await f.login("admin@calai.local", "LocalAdmin!4310");
  const other = await f.login("restaurant2@calai.local", "LocalRestaurant2!4310"), customer = await f.login("customer@calai.local", "LocalCustomer!4310");
  const auth = await f.json("/api/native/business/auth/login", { method: "POST", body: { email: "restaurant@calai.local", password: "LocalRestaurant!4310" } });
  assert.equal(auth.status, 200, auth.text);
  const native = { headers: { authorization: `Bearer ${auth.body.data.token}` } };
  const session = readSession(f.db, parseSessionCookie(owner), f.config), staff = readSession(f.db, parseSessionCookie(other), f.config);
  const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0];
  const root = `/api/restaurant/restaurants/${restaurant.id}`, now = f.config.now().toISOString();
  const nativeBusiness = f.db.prepare("SELECT business_id FROM business_product_links WHERE product='cal-eats' AND restaurant_id=?").get(restaurant.id);
  const createPrinter = async name => {
    const response = await f.json(`${root}/printers`, { method: "POST", cookie: owner, body: { name, enabled: true } });
    assert.equal(response.status, 201, response.text);
    return response.body.data.id;
  };
  const printer = await createPrinter("Kitchen receipt"), unpairedPrinter = await createPrinter("Unpaired device");
  const printerPath = `${root}/printers/${printer}`, list = `${root}/printers?scope=reprint`;
  const code = await f.json(`${printerPath}/pairing-code`, { method: "POST", cookie: owner, body: {} });
  const paired = await f.json("/api/devices/pair", { method: "POST", body: { code: code.body.data.code, name: "Synthetic printer connection" } });
  assert.equal(paired.status, 201, paired.text);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM business_terminals").get().n, 0);
  const available = await f.json(list, { cookie: owner });
  assert.equal(available.status, 200, available.text);
  assert.equal(available.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(available.body.data, { items: [{ id: printer, name: "Kitchen receipt" }] });

  const menuItem = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
  const placed = await f.json("/api/orders", { method: "POST", cookie: customer, headers: { "Idempotency-Key": "remote-copy-fixture" },
    body: { restaurantId: restaurant.id, items: [{ menuItemId: menuItem.id, quantity: 1 }], paymentMethod: "cash", fulfillment: "collection" } });
  assert.equal(placed.status, 201, placed.text);
  const orderId = placed.body.data.id, path = `${printerPath}/reprints`;
  const body = { orderId, requestId: randomUUID(), intent: "labelled_copy" };
  const print = (credentials = { cookie: owner }, payload = body, target = path) => f.json(target, { method: "POST", body: payload, ...credentials });
  assert.equal((await print()).body.error.code, "ORDER_NOT_CONFIRMED");
  for (const [url, method, data] of [
    [`${printerPath}/test-receipt`, "POST", { requestId: randomUUID() }],
    [`${printerPath}/jobs/${randomUUID()}/check`, "POST", {}],
    [`/api/restaurant/orders/${orderId}/status`, "PATCH", { status: "accepted" }],
    [`/api/restaurant/orders/${orderId}/preparation`, "PATCH", { estimatedReadyAt: now }],
    [`/api/business/accounts/${nativeBusiness.business_id}/surface/heartbeat`, "POST", { sequence: 1, state: "active" }]
  ]) assert.equal((await f.json(url, { method, cookie: owner, body: data })).status, 403, url);

  f.db.prepare("UPDATE orders SET status='completed',confirmed_at=?,payment_method='card',payment_status='stripe_captured' WHERE id=?").run(now, orderId);
  f.db.prepare("INSERT INTO stripe_order_payments(order_id,provider_mode,status,created_at,updated_at) VALUES(?,'stripe_live','captured',?,?)")
    .run(orderId, now, now);
  assert.equal((await print({ cookie: other })).status, 404);
  f.db.prepare("INSERT INTO restaurant_memberships(restaurant_id,user_id,permission,created_at,can_view_devices) VALUES(?,?,'staff',?,1)")
    .run(restaurant.id, staff.user.id, now);
  for (const credentials of [native, { cookie: admin }, { cookie: customer }, { cookie: other }]) {
    assert.equal((await f.json(list, credentials)).status, 403);
    assert.equal((await print(credentials)).status, 403);
  }
  for (const malformed of [
    { orderId, requestId: body.requestId, checkedOriginal: false },
    { orderId, requestId: body.requestId },
    { ...body, checkedOriginal: true },
    { ...body, intent: "original" },
    { ...body, requestId: "invalid" },
    { ...body, force: true }
  ]) assert.equal((await print(undefined, malformed)).status, 400);
  assert.equal((await print(undefined, { ...body, orderId: null })).status, 400);
  assert.equal((await print(undefined, body, `${root}/printers/${unpairedPrinter}/reprints`)).body.error.code, "PRINTER_DEVICE_REQUIRED");
  assert.equal((await print(undefined, { ...body, orderId: randomUUID() })).status, 404);
  const link = f.db.prepare("SELECT * FROM business_account_memberships WHERE business_id=? AND user_id=?").get(nativeBusiness.business_id, session.user.id);
  f.db.prepare("UPDATE business_account_memberships SET permission='staff',membership_source='master' WHERE business_id=? AND user_id=?").run(nativeBusiness.business_id, session.user.id);
  assert.equal((await print()).status, 403, "Current business owner permission is required as well as native membership");
  f.db.prepare("UPDATE business_account_memberships SET permission=?,membership_source=? WHERE business_id=? AND user_id=?").run(link.permission, link.membership_source, nativeBusiness.business_id, session.user.id);
  f.db.prepare("UPDATE business_product_permissions SET allowed=0 WHERE business_id=? AND product='cal-eats'").run(nativeBusiness.business_id);
  assert.equal((await f.json(list, { cookie: owner })).status, 403);
  assert.equal((await print()).status, 403);
  f.db.prepare("UPDATE business_product_permissions SET allowed=1 WHERE business_id=? AND product='cal-eats'").run(nativeBusiness.business_id);

  const copies = await Promise.all([print(), print()]);
  assert.deepEqual(copies.map(copy => copy.status).sort(), [200, 201]);
  const id = copies[0].body.data.id;
  assert.equal(copies[1].body.data.id, id);
  const legacyReplay = await print(undefined, { orderId, requestId: body.requestId, checkedOriginal: true });
  assert.equal(legacyReplay.status, 200, legacyReplay.text);
  assert.equal(legacyReplay.body.data.id, id);
  assert.equal((await print(undefined, { ...body, requestId: randomUUID() })).body.error.code, "PRINT_ALREADY_QUEUED");
  const job = f.db.prepare("SELECT status,manual_reprint,receipt FROM device_print_jobs WHERE id=?").get(id);
  assert.equal(job.status, "queued");
  assert.equal(job.manual_reprint, 1);
  const audit = f.db.prepare("SELECT actor_user_id,details FROM audit_events WHERE action='deliberate_labelled_reprint' AND entity_id=?").get(id);
  assert.equal(audit.actor_user_id, session.user.id);
  const details = JSON.parse(audit.details);
  assert.equal(details.terminalId, null);
  assert.equal(details.requestedFrom, "business_website");
  assert.equal(details.intent, "labelled_copy");
  assert.equal(Object.hasOwn(details, "checkedOriginal"), false);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM business_terminals").get().n, 0);

  // An already-queued legacy job still carries the raw value in storage.
  assert.equal(JSON.parse(job.receipt).paymentStatus, "stripe_captured");
  const claim = await f.json("/api/devices/jobs/claim", { method: "POST", headers: { authorization: `Bearer ${paired.body.data.token}` }, body: {} });
  assert.equal(claim.status, 200, claim.text);
  const claimed = claim.body.data.job;
  assert.equal(claimed.id, id);
  assert.equal(claimed.receipt.paymentStatus, "Paid by card");
  assert.match(formatReceipt(claimed.receipt, { manualReprint: claimed.manualReprint }).text, /Payment: Paid by card/);
  assert.equal(f.db.prepare("SELECT receipt FROM device_print_jobs WHERE id=?").get(id).receipt, job.receipt);
  assert.equal(f.db.prepare("SELECT payment_status FROM orders WHERE id=?").get(orderId).payment_status, "stripe_captured");

  const tablet = await enrolRegisteredTablet(f, { ownerCookie: owner, businessId: nativeBusiness.business_id });
  f.db.prepare("UPDATE admin_tablets SET application_products='calai' WHERE terminal_id=?").run(tablet.terminalId);
  assert.equal((await print()).body.error.code, "PRODUCT_INACTIVE");
  f.db.prepare("UPDATE admin_tablets SET application_products=NULL WHERE terminal_id=?").run(tablet.terminalId);
  const req = Readable.from((async function* () {
    f.db.prepare("UPDATE sessions SET revoked_at=? WHERE id=?").run(now, session.sessionId);
    yield Buffer.from(JSON.stringify({ ...body, requestId: randomUUID() }));
  })());
  Object.assign(req, { method: "POST", url: path, headers: { "content-type": "application/json" } });
  await assert.rejects(routeMarketplace({ req, res: {}, url: new URL(path, f.config.origin), db: f.db, config: f.config, session }),
    error => error.code === "RECEIPT_OWNER_REQUIRED");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM device_print_jobs").get().n, 1);
});

test("thermal labels distinguish payment states and keep sandbox charges clearly marked", () => {
  assert.equal(thermalPaymentLabel("stripe_captured", "stripe_live"), "Paid by card");
  assert.equal(thermalPaymentLabel("stripe_captured", "stripe_test"), "Test card payment - no money charged");
  assert.equal(thermalPaymentLabel("stripe_captured"), "Status unavailable");
  assert.equal(thermalPaymentLabel("stripe_authorized", "stripe_live"), "Card authorised - payment pending");
  assert.equal(thermalPaymentLabel("stripe_pending", "stripe_live"), "Card payment pending");
  assert.equal(thermalPaymentLabel("stripe_partially_refunded", "stripe_live"), "Card payment partially refunded");
  assert.equal(thermalPaymentLabel("stripe_refunded", "stripe_live"), "Card payment refunded");
  assert.equal(thermalPaymentLabel("cash_due"), "Cash due");
  assert.equal(thermalPaymentLabel("cash_paid"), "Paid in cash");
  assert.equal(thermalPaymentLabel("voucher_redeemed"), "Paid with a Cal-Eats voucher");
  assert.equal(thermalPaymentLabel("mock_captured"), "Test card payment - no money charged");
  assert.equal(thermalPaymentLabel("unrecognised_value"), "Status unavailable");
});

test("sample receipts are registered-tablet-only, idempotent and separate from real orders, customer data and money", async () => {
  let now = Date.parse("2026-01-01T01:00:00Z");
  const f = await journeyFixture({ now: () => new Date(now) });
  try {
    const k = await kitchen(f);
    const counts = () => Object.fromEntries(["orders", "order_events", "marketplace_operations", "journal_postings", "stripe_order_payments"].map((table) => [table, f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));
    const before = counts();
    assert.equal((await k.diagnostic(randomUUID(), k.other)).status, 403);
    assert.equal((await k.diagnostic(randomUUID(), k.customer)).status, 403);
    assert.equal((await k.diagnostic(randomUUID(), k.owner)).status, 403);
    assert.equal((await k.tablet.json(`${k.printerPath}/test-receipt`, { method: "POST", body: {} })).status, 400);
    const requestId = randomUUID(), queued = await k.diagnostic(requestId);
    assert.equal(queued.status, 201, queued.text); assert.equal(queued.body.data.testReceipt, true); assert.match(queued.body.data.id, /^test-print-/);
    const replay = await k.diagnostic(requestId); assert.equal(replay.status, 200); assert.deepEqual(replay.body.data, queued.body.data);
    assert.equal((await k.diagnostic()).status, 409);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM printer_test_jobs").get().n, 1);
    assert.deepEqual(counts(), before);
    const claimed = await k.claim(); assert.equal(claimed.status, 200, claimed.text);
    const job = claimed.body.data.job; assert.equal(job.testReceipt, true); assert.equal(job.id, queued.body.data.id); assert.equal(job.receipt.testReceipt, true);
    const paper = formatReceipt(job.receipt).text;
    assert.match(paper, /Payment: TEST - no payment/);
    assert.match(paper, /PRINTER TEST - SAMPLE ONLY/); assert.match(paper, /DO NOT PREPARE OR DELIVER/); assert.match(paper, /PRINTER TEST - NO ORDER OR PAYMENT/);
    assert.match(paper, /Sample Customer/); assert.match(paper, /10 Sample Street/); assert.match(paper, /TE57 1NG/); assert.match(paper, /Chicken Tikka Masala/); assert.match(paper, /TOTAL\s+£27\.50/);
    assert.equal((await k.ack(job, "printed")).status, 200); assert.equal((await k.ack(job, "printed")).status, 200); assert.equal((await k.ack(job, "uncertain")).status, 409);
    assert.deepEqual(counts(), before);
    const expiring = await k.diagnostic(); assert.equal(expiring.status, 201, expiring.text);
    now += 5 * 60000 + 1; await k.heartbeat();
    assert.equal((await k.claim()).body.data.job, null);
    assert.equal(f.db.prepare("SELECT status FROM printer_test_jobs WHERE id=?").get(expiring.body.data.id).status, "failed");
    assert.equal((await k.diagnostic()).status, 201);
    const last = (await k.claim()).body.data.job;
    now += 30001;
    const late = await k.ack(last, "printed"); assert.equal(late.status, 409, late.text);
    assert.equal(f.db.prepare("SELECT status FROM printer_test_jobs WHERE id=?").get(last.id).status, "uncertain");
    assert.equal((await k.ack(last, "uncertain")).status, 200);
    assert.equal((await k.claim()).body.data.job, null);
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { await f.close(); }
});

test("one printer serialises real receipts and diagnostics across devices, prioritises orders and never redispatches expired claims", async () => {
  let now = Date.parse("2026-01-01T01:00:00Z");
  const f = await journeyFixture({ now: () => new Date(now) });
  try {
    const k = await kitchen(f), second = await k.pair("Second Windows tablet");
    await k.heartbeat(second);
    const diagnostic = await k.diagnostic(); assert.equal(diagnostic.status, 201, diagnostic.text);
    const item = (await f.json(`/api/restaurants/${k.restaurant.id}/menu`)).body.data.items[0];
    let sequence = 0;
    const acceptOrder = async () => {
      const placed = await f.json("/api/orders", { method: "POST", cookie: k.customer, headers: { "Idempotency-Key": `printer-serial-${sequence++}` }, body: { restaurantId: k.restaurant.id, items: [{ menuItemId: item.id, quantity: 2 }], paymentMethod: "cash", fulfillment: "delivery", deliveryAddress: { line1: "1 Main Street", line2: "Flat 2", city: "Luton", postcode: "LU1 1AA" } } });
      assert.equal(placed.status, 201, placed.text);
      const accepted = await k.tablet.json(`/api/restaurant/orders/${placed.body.data.id}/status`, { method: "PATCH", body: { status: "accepted" } });
      assert.equal(accepted.status, 200, accepted.text);
      return placed.body.data;
    };
    const order = await acceptOrder(), claimed = await k.claim(); assert.equal(claimed.status, 200, claimed.text);
    const job = claimed.body.data.job; assert.equal(job.testReceipt, false); assert.equal(job.receipt.orderNumber, order.id);
    assert.deepEqual(job.receipt.deliveryAddress, { line1: "1 Main Street", line2: "Flat 2", city: "Luton", postcode: "LU1 1AA" });
    const paper = formatReceipt(job.receipt).text;
    assert.match(paper, /1 Main Street/); assert.match(paper, /Flat 2/); assert.match(paper, /Luton\r?\nLU1 1AA/); assert.equal(paper.includes("[object Object]"), false); assert.equal(paper.includes("PRINTER TEST"), false);
    const replay = (await k.claim()).body.data.job; assert.equal(replay.id, job.id); assert.notEqual(replay.claimToken, job.claimToken);
    assert.equal((await k.claim(second)).body.data.job, null);
    assert.equal((await k.ack(job, "printed", second)).status, 401);
    assert.equal((await f.json(`/api/devices/jobs/${job.id}/ack`, { method: "POST", headers: k.first.headers, body: { claimToken: "incorrect_claim_token_abcdefghijklmnopqrstuvwxyz", outcome: "printed" } })).status, 401);
    assert.equal((await k.ack(job)).status, 200);
    const next = (await k.claim(second)).body.data.job; assert.equal(next.id, diagnostic.body.data.id); assert.equal(next.testReceipt, true);
    assert.equal((await k.claim()).body.data.job, null);
    now += 30001; await k.heartbeat();
    assert.equal((await k.claim()).body.data.job, null);
    assert.equal(f.db.prepare("SELECT status FROM printer_test_jobs WHERE id=?").get(next.id).status, "uncertain");
    assert.equal((await k.ack(next, "printed", second)).status, 409);
    assert.equal((await k.ack(next, "uncertain", second)).status, 200);
    const oldOrder = await acceptOrder();
    f.db.prepare("UPDATE device_print_jobs SET created_at=? WHERE order_id=?").run(new Date(now - 25 * 3600000).toISOString(), oldOrder.id);
    assert.equal((await k.claim()).body.data.job, null);
    assert.equal(f.db.prepare("SELECT status FROM device_print_jobs WHERE order_id=?").get(oldOrder.id).status, "failed");
    const freshOrder = await acceptOrder(), physical = (await k.claim()).body.data.job;
    assert.equal(physical.receipt.orderNumber, freshOrder.id);
    now += 30001;
    const another = await k.claim(second); assert.equal(another.body.data.job, null);
    assert.equal(f.db.prepare("SELECT status FROM device_print_jobs WHERE id=?").get(physical.id).status, "uncertain");
    assert.equal((await k.ack(physical, "printed")).status, 409);
    assert.equal((await k.ack(physical, "uncertain")).status, 200);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM device_print_jobs WHERE status='claimed'").get().n, 0);
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { await f.close(); }
});
