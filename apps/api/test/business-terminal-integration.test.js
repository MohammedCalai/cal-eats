import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { journeyFixture } from "./helpers.js";
import { pairingCanonical, requestCanonical } from "../../terminal-auth/src/protocol.js";

// Software P256 keys are a test adapter for the Windows CNG companion. These
// tests exercise createApp, persisted pairing/grants and real signatures; they
// do not establish physical Windows, tablet or printer behaviour.
async function fixture(t) {
  let captureCount = 0;
  const f = await journeyFixture({
    now: () => new Date("2026-01-01T01:00:00.000Z"),
    rateLimit: { attempts: 500, windowMs: 60_000 },
    mockCapture: () => { captureCount += 1; return { ok: true }; }
  });
  t.after(() => f.close());
  const owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310");
  const otherOwner = await f.login("restaurant2@calai.local", "LocalRestaurant2!4310");
  const admin = await f.login("admin@calai.local", "LocalAdmin!4310");
  const customer = await f.login("customer@calai.local", "LocalCustomer!4310");
  const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0];
  const otherRestaurant = (await f.json("/api/restaurant/restaurants", { cookie: otherOwner })).body.data[0];
  const readyProfile = await f.json(`/api/restaurant/restaurants/${restaurant.id}/profile`, { method: "PATCH", cookie: owner, body: { phone: "01632 960001", address: "10 Synthetic Street, Example Town", alwaysOpen: true, collectionEnabled: true } });
  assert.equal(readyProfile.status, 200, readyProfile.text);
  async function account(cookie) {
    const response = await f.json("/api/business/context", { cookie });
    assert.equal(response.status, 200, response.text);
    return response.body.data;
  }
  const business = await account(owner), otherBusiness = await account(otherOwner);
  async function allow(allowed, id = business.id) {
    return f.json(`/api/admin/business/accounts/${id}/products/cal-eats`, { method: "PATCH", cookie: admin, body: { allowed } });
  }
  assert.equal((await allow(true)).status, 200);
  assert.equal((await allow(true, otherBusiness.id)).status, 200);
  const printerResponse = await f.json(`/api/restaurant/restaurants/${restaurant.id}/printers`, { method: "POST", cookie: owner, body: { name: "Synthetic kitchen printer", enabled: true, ipAddress: "192.0.2.25" } });
  assert.equal(printerResponse.status, 201, printerResponse.text);
  const printer = printerResponse.body.data;
  const item = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
  const native = await f.json("/api/native/business/auth/login", { method: "POST", body: { email: "restaurant@calai.local", password: "LocalRestaurant!4310" } });
  assert.equal(native.status, 200, native.text);
  const phoneHeaders = { authorization: `Bearer ${native.body.data.token}` };
  async function place() {
    return f.json("/api/orders", { method: "POST", cookie: customer, headers: { "Idempotency-Key": `terminal-test-${crypto.randomUUID()}` }, body: { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], paymentMethod: "mock_card", fulfillment: "collection" } });
  }
  async function order() {
    const response = await place();
    assert.equal(response.status, 201, response.text);
    return response.body.data;
  }
  async function setup({ cookie = owner, businessId = business.id, replace = false } = {}) {
    const response = await f.json(`/api/business/accounts/${businessId}/terminals/setup`, { method: "POST", cookie, body: { deviceName: "Synthetic P256 Surface", ...(replace ? { replace: true } : {}) } });
    assert.equal(response.status, 201, response.text);
    return response.body.data;
  }
  function signer(setupData) {
    const keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicKeySpki = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const sign = value => crypto.sign("sha256", Buffer.from(value), { key: keys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    let grant = null;
    const pairBody = { terminalId: setupData.terminalId, code: setupData.code, deviceName: "Synthetic P256 Surface", publicKeySpki, challengeSignature: sign(pairingCanonical({ ...setupData, publicKeySpki })) };
    function signedOptions(target, { method = "GET", body, headers = {}, useGrant = true } = {}) {
      const timestamp = String(f.config.now().getTime()), nonce = crypto.randomBytes(24).toString("base64url");
      const canonical = requestCanonical({ terminalId: setupData.terminalId, timestamp, nonce, method, target, body: body === undefined ? "" : JSON.stringify(body) });
      return { method, ...(body === undefined ? {} : { body }), headers: {
        "X-Cal-Eats-Terminal-Id": setupData.terminalId,
        "X-Cal-Eats-Terminal-Timestamp": timestamp,
        "X-Cal-Eats-Terminal-Nonce": nonce,
        "X-Cal-Eats-Terminal-Signature": sign(canonical),
        ...(useGrant && grant ? { "X-Cal-Eats-Terminal-Session": grant.token } : {}), ...headers
      } };
    }
    const send = (target, options) => f.json(target, signedOptions(target, options));
    async function session() {
      const response = await send(`/api/terminal-devices/${setupData.terminalId}/operator-session`, { method: "POST", body: {}, useGrant: false });
      assert.equal(response.status, 201, response.text);
      grant = response.body.data;
      return grant;
    }
    return { setupData, publicKeySpki, pairBody, signedOptions, send, session, token: () => grant?.token };
  }
  async function enrol(options) {
    const tablet = signer(await setup(options));
    const paired = await f.json("/api/terminal-devices/pair", { method: "POST", body: tablet.pairBody });
    assert.equal(paired.status, 201, paired.text);
    await tablet.session();
    return tablet;
  }
  const count = (table, where = "", ...params) => f.db.prepare(`SELECT COUNT(*) n FROM ${table}${where ? ` WHERE ${where}` : ""}`).get(...params).n;
  return { ...f, owner, otherOwner, admin, customer, restaurant, otherRestaurant, business, otherBusiness, printer, phoneHeaders, place, order, allow, setup, signer, enrol, count, captureCount: () => captureCount };
}

const decision = { status: "accepted", estimatedReadyAt: "2026-01-01T01:30:00.000Z" };
const orderPath = id => `/api/restaurant/orders/${id}/status`;

test("real router denies browser and native phone operational requests while preserving authorised read access", async t => {
  const f = await fixture(t), order = await f.order();
  const printerPath = `/api/restaurant/restaurants/${f.restaurant.id}/printers/${f.printer.id}`;
  const writes = [
    [orderPath(order.id), "PATCH", decision],
    [orderPath(order.id), "PATCH", { status: "rejected" }],
    [orderPath(order.id), "PATCH", { status: "preparing" }],
    [`/api/restaurant/orders/${order.id}/preparation`, "PATCH", { estimatedReadyAt: decision.estimatedReadyAt }],
    [`${printerPath}/test-receipt`, "POST", { requestId: crypto.randomUUID() }],
    [`${printerPath}/reprints`, "POST", { orderId: order.id }],
    [`/api/orders/${order.id}/print`, "POST", {}],
    [`/api/print-jobs/${crypto.randomUUID()}/retry`, "POST", {}],
    [`/api/print-jobs/${crypto.randomUUID()}/status`, "PATCH", { status: "queued" }]
  ];
  for (const authority of [{ cookie: f.owner }, { headers: f.phoneHeaders }]) {
    for (const [route, method, body] of writes) {
      const response = await f.json(route, { ...authority, method, body });
      assert.equal(response.status, 403, `${method} ${route}: ${response.text}`);
      assert.equal(response.body.error.code, "REGISTERED_TABLET_REQUIRED");
    }
    assert.equal((await f.json(`/api/orders/${order.id}`, authority)).status, 200);
  }
  const forgedBrowser = await f.json(orderPath(order.id), { method: "PATCH", cookie: f.owner, headers: { origin: f.config.origin, "X-Registered-Tablet": "true", "X-Device-Id": crypto.randomUUID() }, body: decision });
  assert.equal(forgedBrowser.status, 403);
  assert.equal(f.captureCount(), 0);
  assert.equal(f.count("device_print_jobs"), 0);
  assert.equal(f.db.prepare("SELECT status FROM orders WHERE id=?").get(order.id).status, "placed");
  assert.equal((await f.json(`/api/orders/${order.id}`, { cookie: f.otherOwner })).status, 404);
});

test("standalone Windows installer requires current owner scope and contains no operational credentials", async t=>{
  const f=await fixture(t),root=`/api/business/accounts/${f.business.id}/terminals/installer`;
  const download=await f.request(root,{cookie:f.owner});
  assert.equal(download.status,200,download.text);
  assert.match(download.headers.get("content-disposition"),/CalEats-Tablet-Setup\.ps1/);
  assert.match(download.text,/CalEatsTerminalAuth/);
  assert.doesNotMatch(download.text,/"code"\s*:\s*"[A-Za-z0-9_-]{32}"/);
  assert.equal((await f.request(root)).status,401);
  assert.ok([403,404].includes((await f.request(root,{cookie:f.otherOwner})).status));
  const staff=await f.json(`/api/restaurant/restaurants/${f.restaurant.id}/staff`,{method:"POST",cookie:f.owner,body:{name:"Synthetic device observer",email:"device-observer@example.invalid",password:"Synthetic observer!4310"}});
  assert.equal(staff.status,201,staff.text);
  const staffCookie=await f.login("device-observer@example.invalid","Synthetic observer!4310");
  assert.equal((await f.request(root,{cookie:staffCookie})).status,403);
  assert.equal((await f.request(root,{headers:f.phoneHeaders})).status,403,"Native business phone must not administer Windows setup");
  const tablet=await f.enrol();
  assert.equal((await tablet.send(root)).status,403);
});

test("enrolled signed Surface accepts atomically once across retries and separates print outcomes", async t => {
  const f = await fixture(t), tablet = await f.enrol(), order = await f.order();
  const grant = (await tablet.send("/api/auth/me")).body.data;
  assert.equal(grant.principalKind, "terminal");
  assert.equal(grant.restaurantId, f.restaurant.id);
  assert.equal(f.count("device_print_jobs"), 0, "Pairing, reads and checkout must never enqueue a receipt");
  const responses = await Promise.all(Array.from({ length: 5 }, () => tablet.send(orderPath(order.id), { method: "PATCH", body: decision })));
  for (const response of responses) assert.equal(response.status, 200, response.text);
  assert.equal(f.captureCount(), 1);
  assert.equal(f.count("order_events", "order_id=? AND to_status='accepted'", order.id), 1);
  assert.equal(f.count("ledger_entries", "order_id=? AND kind='commission_mock'", order.id), 1);
  const jobs = f.db.prepare("SELECT * FROM device_print_jobs WHERE order_id=?").all(order.id);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "queued");
  assert.equal(jobs[0].manual_reprint, 0);
  assert.equal(JSON.parse(jobs[0].receipt).paymentStatus, "mock_captured");
  assert.equal((await tablet.send(`/api/restaurant/orders/${order.id}/preparation`, { method: "PATCH", body: { estimatedReadyAt: "2026-01-01T01:40:00.000Z" } })).status, 200);
  for (const status of ["preparing", "ready", "completed"]) {
    const response = await tablet.send(orderPath(order.id), { method: "PATCH", body: { status } });
    assert.equal(response.status, 200, response.text);
  }
  assert.equal(f.count("device_print_jobs"), 1, "Fulfilment updates must not duplicate the original receipt");
  assert.equal(f.captureCount(), 1);
  assert.equal(f.db.prepare("SELECT payment_status FROM orders WHERE id=?").get(order.id).payment_status, "mock_captured");
  assert.equal((await tablet.send(`/api/orders/${order.id}`)).status, 200);
  assert.equal((await tablet.send(`/api/restaurant/restaurants/${f.restaurant.id}/bank-details`)).status, 403, "Device-only principal must not acquire owner financial access");
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("signed requests enforce tenant, device, grant, freshness and replay boundaries", async t => {
  const f = await fixture(t), tablet = await f.enrol(), otherTablet = await f.enrol({ cookie: f.otherOwner, businessId: f.otherBusiness.id }), order = await f.order();
  assert.equal((await otherTablet.send(orderPath(order.id), { method: "PATCH", body: decision })).status, 404);
  assert.equal((await tablet.send(`/api/restaurant/restaurants/${f.otherRestaurant.id}/orders`)).status, 404);
  assert.equal((await tablet.send(`/api/restaurant/orders/pending-confirmation?restaurantId=${f.otherRestaurant.id}`)).status, 404);
  const target = `/api/orders/${order.id}`, replay = tablet.signedOptions(target);
  assert.equal((await f.json(target, replay)).status, 200);
  const repeated = await f.json(target, replay);
  assert.equal(repeated.status, 409);
  assert.equal(repeated.body.error.code, "TERMINAL_REQUEST_REPLAYED");
  const wrongDevice = tablet.signedOptions(target);
  wrongDevice.headers["X-Cal-Eats-Terminal-Id"] = otherTablet.setupData.terminalId;
  assert.equal((await f.json(target, wrongDevice)).status, 401);
  const wrongGrant = tablet.signedOptions(target);
  wrongGrant.headers["X-Cal-Eats-Terminal-Session"] = otherTablet.token();
  assert.equal((await f.json(target, wrongGrant)).status, 401);
  const alteredBody = tablet.signedOptions(orderPath(order.id), { method: "PATCH", body: decision });
  alteredBody.body = { status: "rejected" };
  assert.equal((await f.json(orderPath(order.id), alteredBody)).status, 401);
  const mixed = tablet.signedOptions(target);
  mixed.cookie = f.owner;
  assert.equal((await f.json(target, mixed)).body.error.code, "MIXED_TERMINAL_AUTHORITY");
  const expired = tablet.signedOptions(target);
  expired.headers["X-Cal-Eats-Terminal-Timestamp"] = String(f.config.now().getTime() - 60_001);
  assert.equal((await f.json(target, expired)).body.error.code, "TERMINAL_SIGNATURE_EXPIRED");
  assert.equal((await tablet.send("/api/admin/restaurants")).status, 403);
  assert.equal(f.captureCount(), 0);
  assert.equal(f.count("device_print_jobs"), 0);
});

test("tablet-only diagnostic and deliberate labelled copies deduplicate safely after a bridge reports uncertainty", async t => {
  const f = await fixture(t), tablet = await f.enrol(), order = await f.order();
  const printerPath = `/api/restaurant/restaurants/${f.restaurant.id}/printers/${f.printer.id}`;
  assert.equal((await tablet.send(orderPath(order.id), { method: "PATCH", body: decision })).status, 200);
  const pairing = await f.json(`${printerPath}/pairing-code`, { method: "POST", cookie: f.owner, body: {} });
  assert.equal(pairing.status, 201, pairing.text);
  const paired = await f.json("/api/devices/pair", { method: "POST", body: { code: pairing.body.data.code, name: "Synthetic transport adapter, no physical printer" } });
  assert.equal(paired.status, 201, paired.text);
  const bridgeHeaders = { authorization: `Bearer ${paired.body.data.token}` };
  assert.equal((await f.json("/api/devices/heartbeat", { method: "POST", headers: bridgeHeaders, body: { printerReachable: true, transport: "tcp-escpos" } })).status, 200);
  const testBody = { requestId: crypto.randomUUID() };
  const diagnostics = await Promise.all(Array.from({ length: 3 }, () => tablet.send(`${printerPath}/test-receipt`, { method: "POST", body: testBody })));
  assert.deepEqual(diagnostics.map(row => row.status).sort(), [200, 200, 201]);
  assert.equal(new Set(diagnostics.map(row => row.body.data.id)).size, 1);
  assert.equal(f.count("printer_test_jobs"), 1);
  const reprint = { orderId: order.id, requestId: crypto.randomUUID(), checkedOriginal: true };
  const queued = await tablet.send(`${printerPath}/reprints`, { method: "POST", body: reprint });
  assert.equal(queued.status, 409);
  assert.equal(queued.body.error.code, "PRINT_ALREADY_QUEUED");
  const claim = await f.json("/api/devices/jobs/claim", { method: "POST", headers: bridgeHeaders, body: {} });
  assert.equal(claim.status, 200, claim.text);
  assert.equal(claim.body.data.job.testReceipt, false);
  const original = claim.body.data.job;
  const acknowledgement = await f.json(`/api/devices/jobs/${original.id}/ack`, { method: "POST", headers: bridgeHeaders, body: { claimToken: original.claimToken, outcome: "uncertain" } });
  assert.equal(acknowledgement.status, 200, acknowledgement.text);
  assert.equal(f.db.prepare("SELECT status FROM orders WHERE id=?").get(order.id).status, "accepted");
  assert.equal(f.db.prepare("SELECT status FROM device_print_jobs WHERE id=?").get(original.id).status, "uncertain");
  assert.equal((await tablet.send(`${printerPath}/reprints`, { method: "POST", body: { ...reprint, checkedOriginal: false } })).body.error.code, "REPRINT_CHECK_REQUIRED");
  const copies = await Promise.all(Array.from({ length: 3 }, () => tablet.send(`${printerPath}/reprints`, { method: "POST", body: reprint })));
  assert.deepEqual(copies.map(row => row.status).sort(), [200, 200, 201]);
  assert.equal(new Set(copies.map(row => row.body.data.id)).size, 1);
  assert.equal(f.count("device_print_jobs", "order_id=? AND manual_reprint=1", order.id), 1);
  assert.equal(f.count("audit_events", "action='deliberate_labelled_reprint'"), 1);
  assert.equal(f.captureCount(), 1);
  assert.equal((await tablet.send(`/api/orders/${order.id}`)).status, 200);
  assert.equal(f.count("device_print_jobs", "order_id=?", order.id), 2, "Viewing or reconnecting must not blindly retry the uncertain original");
});

test("replacement and revocation invalidate old signatures and grants immediately without account-login enrolment", async t => {
  const f = await fixture(t), oldTablet = await f.enrol(), order = await f.order();
  const duplicateSetup = await f.json(`/api/business/accounts/${f.business.id}/terminals/setup`, { method: "POST", cookie: f.owner, body: {} });
  assert.equal(duplicateSetup.status, 409);
  const replacementSetup = await f.setup({ cookie: f.admin, replace: true });
  assert.equal((await oldTablet.send(`/api/orders/${order.id}`)).status, 200, "Issuing replacement setup alone must not retire a working tablet");
  const replacement = f.signer(replacementSetup);
  const tamperedPair = await f.json("/api/terminal-devices/pair", { method: "POST", body: { ...replacement.pairBody, challengeSignature: "A".repeat(86) } });
  assert.equal(tamperedPair.status, 401);
  assert.equal((await f.json("/api/terminal-devices/pair", { method: "POST", body: replacement.pairBody })).status, 201);
  await replacement.session();
  assert.equal((await oldTablet.send(orderPath(order.id), { method: "PATCH", body: decision })).body.error.code, "TERMINAL_REVOKED");
  const stolenConsumedSetup = f.signer(replacementSetup);
  assert.equal((await f.json("/api/terminal-devices/pair", { method: "POST", body: stolenConsumedSetup.pairBody })).status, 401);
  assert.equal((await replacement.send(`/api/orders/${order.id}`)).status, 200);
  const revoked = await f.json(`/api/business/accounts/${f.business.id}/terminals/revoke`, { method: "POST", cookie: f.owner, body: {} });
  assert.equal(revoked.status, 200, revoked.text);
  assert.equal((await replacement.send(orderPath(order.id), { method: "PATCH", body: decision })).body.error.code, "TERMINAL_REVOKED");
  assert.equal(f.count("business_terminals", "revoked_at IS NULL"), 0);
  assert.equal(f.count("business_terminal_grants", "revoked_at IS NULL"), 0);
  assert.equal(f.count("audit_events", "action='terminal_enrolled'"), 2);
  assert.equal(f.captureCount(), 0);
});

test("delayed pairing rechecks native restaurant ownership even when combined-account ownership survives", async t => {
  const f = await fixture(t);
  const ownerId=f.db.prepare("SELECT id FROM users WHERE email='restaurant@calai.local'").get().id;
  const remainingOwnerId=f.db.prepare("SELECT id FROM users WHERE email='restaurant2@calai.local'").get().id;
  // A master association represents independently retained combined-account
  // rights; it must not substitute for current native Cal-Eats ownership.
  f.db.prepare("UPDATE business_account_memberships SET membership_source='master' WHERE business_id=? AND user_id=?").run(f.business.id,ownerId);
  const setup=await f.setup(),tablet=f.signer(setup);
  const root=`/api/admin/governance/restaurants/${f.restaurant.id}/memberships`;
  const added=await f.json(root,{method:"POST",cookie:f.admin,body:{userId:remainingOwnerId,permission:"owner",reason:"Synthetic delayed-pair ownership transfer"}});
  assert.equal(added.status,201,added.text);
  const removed=await f.json(`${root}/${ownerId}`,{method:"DELETE",cookie:f.admin,body:{reason:"Synthetic native ownership removed after setup"}});
  assert.equal(removed.status,200,removed.text);
  assert.equal(f.db.prepare("SELECT permission FROM business_account_memberships WHERE business_id=? AND user_id=?").get(f.business.id,ownerId).permission,"owner");
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM restaurant_memberships WHERE restaurant_id=? AND permission='owner'").get(f.restaurant.id).n,1,"Another native owner must remain, so this exercises issuer authority rather than an ownerless account");
  const response=await f.json("/api/terminal-devices/pair",{method:"POST",body:tablet.pairBody});
  assert.equal(response.status,401,response.text);
  assert.equal(response.body.error.code,"TERMINAL_PAIRING_INVALID");
  assert.equal(f.count("business_terminals"),0);
  assert.equal(f.count("audit_events","action='terminal_enrolled'"),0);
});

test("administrator service disable blocks new checkout but preserves enrolled fulfilment and order history", async t => {
  const f = await fixture(t), tablet = await f.enrol(), order = await f.order();
  assert.equal((await tablet.send(orderPath(order.id), { method: "PATCH", body: decision })).status, 200);
  assert.equal((await f.allow(false)).status, 200);
  const disabledCheckout = await f.place();
  assert.equal(disabledCheckout.status, 409);
  assert.equal(disabledCheckout.body.error.code, "CAL_EATS_DISABLED");
  const renewed = await tablet.session();
  assert.equal(renewed.products["cal-eats"].active, false);
  assert.equal(renewed.products["cal-eats"].linked, true);
  for (const status of ["preparing", "ready", "completed"]) {
    const response = await tablet.send(orderPath(order.id), { method: "PATCH", body: { status } });
    assert.equal(response.status, 200, response.text);
  }
  assert.equal((await tablet.send(`/api/orders/${order.id}`)).status, 200);
  assert.equal((await f.json(`/api/orders/${order.id}`, { cookie: f.owner })).status, 200);
  assert.equal(f.captureCount(), 1);
  assert.equal(f.count("device_print_jobs", "order_id=?", order.id), 1);
});

test("signed Surface logout revokes its operational grant and fresh automatic grant can resume without reenrolment", async t => {
  const f = await fixture(t), tablet = await f.enrol(), order = await f.order();
  const path = `/api/business/accounts/${f.business.id}/surface/heartbeat`;
  assert.equal((await tablet.send(`/api/restaurant/orders/pending-confirmation?restaurantId=${f.restaurant.id}`)).status, 200);
  assert.equal((await tablet.send(path, { method: "POST", body: { sequence: 1, state: "active" } })).status, 200);
  assert.equal((await tablet.send(path, { method: "POST", body: { sequence: 2, state: "signed_out" } })).status, 200);
  const oldToken = tablet.token();
  assert.equal((await tablet.send(orderPath(order.id), { method: "PATCH", body: decision })).body.error.code, "TERMINAL_SESSION_EXPIRED");
  const resumed = await tablet.session();
  assert.notEqual(resumed.token, oldToken);
  assert.equal((await tablet.send(path, { method: "POST", body: { sequence: 1, state: "active" } })).status, 200, "A new grant starts a fresh monotonic presence sequence");
  assert.equal(f.count("business_terminals"), 1);
  assert.equal(f.count("audit_events", "action='terminal_enrolled'"), 1);
});
