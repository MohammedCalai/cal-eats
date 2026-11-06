import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { journeyFixture } from "./helpers.js";
import { createApp } from "../src/app.js";

test("support-verified customer login closure is guarded, idempotent and preserves history", async () => {
  let stamp = "2026-01-01T01:00:00.000Z";
  const f = await journeyFixture({ now: () => new Date(stamp), rateLimit: { attempts: 100, windowMs: 60000 } });
  try {
    const admin = await f.login("admin@calai.local", "LocalAdmin!4310"), owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310");
    const email = "customer@calai.local", password = "LocalCustomer!4310", customer = await f.login(email, password), otherBrowser = await f.login(email, password);
    const native = await f.json("/api/native/auth/login", { method: "POST", body: { email, password } }); assert.equal(native.status, 200, native.text);
    const userId = native.body.data.user.id, nativeHeaders = { authorization: `Bearer ${native.body.data.token}` };
    const request = await f.json("/api/account/deletion-requests", { method: "POST", cookie: customer, body: { reason: "Please close my login after support verifies this request." } }); assert.equal(request.status, 201, request.text);
    const id = request.body.data.id, route = `/api/admin/deletion-requests/${id}/close-account`, note = "Support verified the customer identity and closure request using the approved support conversation.";
    const close = (cookie = admin, body = { note }) => f.json(route, { method: "POST", cookie, body });
    assert.equal((await f.json(route, { method: "POST", body: { note } })).status, 401);
    assert.equal((await close(owner)).status, 403); assert.equal((await close(customer)).status, 403);
    assert.equal((await close(admin, { note: "yes" })).status, 400);
    for (const cookie of [owner, admin]) {
      const businessRequest = await f.json("/api/account/deletion-requests", { method: "POST", cookie, body: { reason: "Review this noncustomer account." } }); assert.equal(businessRequest.status, 201, businessRequest.text);
      const denied = await f.json(`/api/admin/deletion-requests/${businessRequest.body.data.id}/close-account`, { method: "POST", cookie: admin, body: { note } }); assert.equal(denied.status, 409, denied.text); assert.equal(denied.body.error.code, "CUSTOMER_CLOSURE_ONLY");
    }
    const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0], item = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
    const placed = await f.json("/api/orders", { method: "POST", cookie: customer, headers: { "Idempotency-Key": "verified-closure-order" }, body: { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], paymentMethod: "cash", fulfillment: "collection" } }); assert.equal(placed.status, 201, placed.text);
    const orderId = placed.body.data.id;
    let blocked = await close(); assert.equal(blocked.status, 409, blocked.text); assert.equal(blocked.body.error.code, "ACCOUNT_CLOSURE_BLOCKED");
    assert.equal(f.db.prepare("SELECT account_enabled FROM users WHERE id=?").get(userId).account_enabled, 1);
    for (const status of ["accepted", "preparing", "ready", "completed"]) { const changed = await f.json(`/api/restaurant/orders/${orderId}/status`, { method: "PATCH", cookie: owner, body: { status } }); assert.equal(changed.status, 200, changed.text); }
    // A terminal order can still have unsettled payment work; no provider is called.
    const operationId = randomUUID();
    f.db.prepare("INSERT INTO marketplace_operations(id,operation_key,restaurant_id,order_id,kind,status,amount_minor,currency,provider_mode,metadata,created_at,updated_at) VALUES(?,?,?,?,?,'pending',100,'GBP','local_simulator','{}',?,?)").run(operationId, "closure-pending-payment", restaurant.id, orderId, "order_refund", stamp, stamp);
    blocked = await close(); assert.equal(blocked.status, 409, blocked.text); assert.equal(blocked.body.error.code, "ACCOUNT_CLOSURE_BLOCKED");
    f.db.prepare("UPDATE marketplace_operations SET status='cancelled' WHERE id=?").run(operationId);
    f.db.prepare("UPDATE users SET merchant_offers=1 WHERE id=?").run(userId);
    f.db.prepare("INSERT INTO marketing_preferences(user_id,in_app_promotions,push_promotions,consent_version,consent_source,consented_at,updated_at) VALUES(?,1,1,'loyalty-v1','fixture-opt-in',?,?) ON CONFLICT(user_id) DO UPDATE SET in_app_promotions=1,push_promotions=1").run(userId,stamp,stamp);
    const address = await f.json("/api/account/addresses", { method: "POST", cookie: customer, body: { label: "Home", line1: "10 Test Street", city: "Luton", postcode: "LU1 1AA" } }); assert.equal(address.status, 201, address.text);
    const oldBusinessToken = "fixture-legacy-business-session-for-customer";
    f.db.prepare("INSERT INTO native_business_sessions VALUES(?,?,?,?,?,NULL)").run(randomUUID(), userId, createHash("sha256").update(oldBusinessToken).digest("hex"), stamp, "2026-02-01T01:00:00.000Z");
    assert.equal((await f.json("/api/auth/password/forgot", { method: "POST", body: { email } })).status, 202);
    assert.equal((await f.json("/api/auth/email-verification/send", { method: "POST", cookie: customer, body: {} })).status, 202);
    const tokenFor = kind => f.db.prepare("SELECT body FROM local_mail_sink WHERE recipient=? AND kind=? ORDER BY rowid DESC LIMIT 1").get(email, kind).body.match(/#(?:reset-password|verify-email)=([A-Za-z0-9_-]+)/)[1];
    const resetToken = tokenFor("password_reset"), verificationToken = tokenFor("email_verification");
    const history = () => Object.fromEntries(["orders", "order_items", "order_events", "marketplace_operations", "ledger_entries", "journal_postings", "saved_addresses"].map(table => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const beforeHistory = history(), accountBefore = f.db.prepare("SELECT name,email,password_hash,phone FROM users WHERE id=?").get(userId);
    const [first, concurrent] = await Promise.all([close(), close()]); assert.equal(first.status, 200, first.text); assert.deepEqual(concurrent.body, first.body);
    const closure = first.body.data; assert.deepEqual(closure, { requestId: id, userId, status: "login_closed", accountEnabled: false, dataReviewStatus: "under_review", closedAt: stamp, note, retainedRecords: true });
    assert.deepEqual(history(), beforeHistory); assert.deepEqual(f.db.prepare("SELECT name,email,password_hash,phone FROM users WHERE id=?").get(userId), accountBefore);
    assert.equal(f.db.prepare("SELECT account_enabled FROM users WHERE id=?").get(userId).account_enabled, 0);
    for (const table of ["sessions", "native_sessions", "native_business_sessions"]) assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=? AND revoked_at IS NULL`).get(userId).n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM account_access_tokens WHERE user_id=? AND consumed_at IS NULL").get(userId).n, 0);
    const marketing = f.db.prepare("SELECT in_app_promotions,push_promotions FROM marketing_preferences WHERE user_id=?").get(userId); assert.equal(marketing.in_app_promotions, 0); assert.equal(marketing.push_promotions, 0);
    assert.equal(f.db.prepare("SELECT merchant_offers FROM users WHERE id=?").get(userId).merchant_offers, 0);
    assert.equal(f.db.prepare("SELECT status FROM deletion_requests WHERE id=?").get(id).status, "under_review");
    const closureState = () => ({ audit: f.db.prepare("SELECT * FROM audit_events WHERE entity_id=? AND action='account_login_closed_verified'").all(id), request: f.db.prepare("SELECT * FROM deletion_requests WHERE id=?").get(id), sessions: ["sessions", "native_sessions", "native_business_sessions"].map(table => f.db.prepare(`SELECT * FROM ${table} WHERE user_id=? ORDER BY rowid`).all(userId)), tokens: f.db.prepare("SELECT * FROM account_access_tokens WHERE user_id=? ORDER BY rowid").all(userId) });
    const once = closureState(); assert.equal(once.audit.length, 1);
    stamp = "2026-01-01T01:01:00.000Z";
    const retry = await close(admin, { note: "This later retry must retain the original verification evidence." }); assert.equal(retry.status, 200, retry.text); assert.deepEqual(retry.body, first.body); assert.deepEqual(closureState(), once);
    assert.equal((await f.json("/api/auth/me", { cookie: customer })).status, 401); assert.equal((await f.json("/api/auth/me", { cookie: otherBrowser })).status, 401); assert.equal((await f.json("/api/native/auth/me", { headers: nativeHeaders })).status, 401);
    assert.equal((await f.json("/api/auth/login", { method: "POST", body: { email, password } })).status, 401);
    assert.equal((await f.json("/api/auth/password/reset", { method: "POST", body: { token: resetToken, password: "Replacement password 4310!" } })).body.error.code, "TOKEN_INVALID");
    assert.equal((await f.json("/api/auth/email-verification/confirm", { method: "POST", body: { token: verificationToken } })).body.error.code, "TOKEN_INVALID");
    const directory = await f.json("/api/admin/workspace/operations?kind=deletions", { cookie: admin }); assert.equal(directory.status, 200, directory.text);
    const summary = directory.body.data.items.find(row => row.id === id); assert.equal(summary.userRole, "customer"); assert.equal(summary.accountEnabled, false); assert.equal(summary.loginClosedAt, closure.closedAt); assert.equal(summary.closureNote, note);
    assert.deepEqual(history(), beforeHistory);
    // Reopening remains an explicit admin action; replaying the old closure cannot undo it.
    const reopened = await f.json(`/api/admin/governance/accounts/${userId}`, { method: "PATCH", cookie: admin, body: { enabled: true, reason: "Support explicitly reopened this login after reviewing the customer's request." } }); assert.equal(reopened.status, 200, reopened.text);
    const oldReplay = await close(); assert.equal(oldReplay.status, 409, oldReplay.text); assert.equal(oldReplay.body.error.code, "ACCOUNT_REOPENED"); assert.equal(f.db.prepare("SELECT account_enabled FROM users WHERE id=?").get(userId).account_enabled, 1); assert.equal(closureState().audit.length, 1);
    assert.deepEqual(history(), beforeHistory); assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { await f.close(); }
});

test("an order authenticated before verified closure cannot commit after its delayed body arrives", async () => {
  const stamp = "2026-01-01T01:00:00.000Z", f = await journeyFixture({ now: () => new Date(stamp), rateLimit: { attempts: 100, windowMs: 60000 } });
  let releaseBody;
  try {
    const customer = await f.login("customer@calai.local", "LocalCustomer!4310"), owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310"), admin = await f.login("admin@calai.local", "LocalAdmin!4310");
    const userId = f.db.prepare("SELECT id FROM users WHERE email='customer@calai.local'").get().id, ownerId = f.db.prepare("SELECT id FROM users WHERE email='restaurant@calai.local'").get().id;
    const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0], item = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
    const originalBody = { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], paymentMethod: "cash", fulfillment: "collection" };
    const original = await f.json("/api/orders", { method: "POST", cookie: customer, headers: { "Idempotency-Key": "pre-closure-history" }, body: originalBody }); assert.equal(original.status, 201, original.text);
    for (const status of ["accepted", "preparing", "ready", "completed"]) { const changed = await f.json(`/api/restaurant/orders/${original.body.data.id}/status`, { method: "PATCH", cookie: owner, body: { status } }); assert.equal(changed.status, 200, changed.text); }
    const campaignId = randomUUID(), offerId = randomUUID();
    f.db.prepare("INSERT INTO offer_campaigns(id,restaurant_id,created_by_user_id,idempotency_key,request_hash,title,message,menu_item_id,item_name,item_value_minor,min_subtotal_minor,expires_at,created_at,offer_type,offer_value) VALUES(?,?,?,?,?,?,?,?,?,?,0,'2026-02-01T01:00:00.000Z',?,'fixed_off',100)").run(campaignId, restaurant.id, ownerId, campaignId, campaignId, "Customer offer", "A pound off your next meal", item.id, item.name, item.priceMinor, stamp);
    f.db.prepare("INSERT INTO offer_grants(id,campaign_id,restaurant_id,customer_id,status,created_at,updated_at) VALUES(?,?,?,?,'available',?,?)").run(offerId, campaignId, restaurant.id, userId, stamp, stamp);
    const issued = await f.json(`/api/admin/customers/${userId}/vouchers`, { method: "POST", cookie: admin, headers: { "Idempotency-Key": "closure-race-voucher" }, body: { title: "Customer care", message: "Credit for your next meal", amountMinor: 2000, expiresAt: "2026-01-30T01:00:00.000Z", reason: "Isolated closure race fixture" } }); assert.equal(issued.status, 201, issued.text);
    const createdRequest = await f.json("/api/account/deletion-requests", { method: "POST", cookie: customer, body: { reason: "Close my login after verification." } }); assert.equal(createdRequest.status, 201, createdRequest.text);
    const app = createApp({ db: f.db, config: f.config }), waiting = [];
    const bodyGate = new Promise(resolve => { releaseBody = resolve; });
    function delayedOrder(body, key) {
      let bodyStarted;
      const started = new Promise(resolve => { bodyStarted = resolve; });
      const req = Readable.from((async function* () { bodyStarted(); await bodyGate; yield Buffer.from(JSON.stringify(body)); })());
      Object.assign(req, { method: "POST", url: "/api/orders", headers: { host: f.config.expectedHost, cookie: customer, "content-type": "application/json", "idempotency-key": key }, socket: { remoteAddress: "127.0.0.1" } });
      const response = new Promise(resolve => {
        const chunks = [], res = { headersSent: false, statusCode: 200, setHeader() {}, writeHead(status) { this.statusCode = status; this.headersSent = true; }, end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); } };
        void app(req, res);
      });
      waiting.push(response); return started;
    }
    await Promise.all([
      delayedOrder({ ...originalBody, paymentMethod: "voucher", offerId, voucherId: issued.body.data.id }, "closure-race-new"),
      delayedOrder(originalBody, "pre-closure-history")
    ]);
    // Both handlers have read the old authenticated session and are waiting in readJson.
    const snapshot = () => Object.fromEntries(["orders", "order_items", "order_events", "offer_grants", "platform_vouchers", "platform_voucher_redemptions", "marketplace_operations", "ledger_entries", "journal_postings"].map(table => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const before = snapshot();
    const closed = await f.json(`/api/admin/deletion-requests/${createdRequest.body.data.id}/close-account`, { method: "POST", cookie: admin, body: { note: "Support verified the customer's identity and request in the approved conversation." } }); assert.equal(closed.status, 200, closed.text);
    releaseBody();
    const results = await Promise.all(waiting);
    for (const result of results) { assert.equal(result.status, 401, JSON.stringify(result.body)); assert.equal(result.body.error.code, "AUTH_REQUIRED"); }
    assert.deepEqual(snapshot(), before); assert.equal(f.db.prepare("SELECT status FROM offer_grants WHERE id=?").get(offerId).status, "available"); assert.equal(f.db.prepare("SELECT COUNT(*) n FROM platform_voucher_redemptions").get().n, 0);
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { releaseBody?.(); await f.close(); }
});
