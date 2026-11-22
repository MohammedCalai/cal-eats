import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { journeyFixture } from "./helpers.js";
import { hashPassword } from "../src/auth/passwords.js";
import { quarantineLegacyCustomerPasswords } from "../src/auth/customer-password-quarantine.js";

const weak = "123456", replacement = "NewCustomerPassword2026!";
test("the quarantine maintenance entry point imports in a fresh process before database bootstrap", () => {
  const module = new URL("../src/auth/customer-password-quarantine.js", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `const value=await import(${JSON.stringify(module)}); if(typeof value.quarantineLegacyCustomerPasswords!=="function")process.exit(2);`], { encoding: "utf8", timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
async function setup() {
  const f = await journeyFixture({ rateLimit: { attempts: 200, windowMs: 60000 } });
  const first = f.db.prepare("SELECT id,email FROM users WHERE email='customer@calai.local'").get(), admin = f.db.prepare("SELECT id,role FROM users WHERE role='admin'").get();
  const passwordHash = await hashPassword(weak), second = { id: randomUUID(), email: "legacy-second@example.test" }, reviewer = { id: randomUUID(), email: "reviewer-strong@example.test" };
  f.db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(passwordHash, first.id);
  for (const user of [second, reviewer]) f.db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?, 'customer',?)").run(user.id, "Synthetic account", user.email, user === second ? passwordHash : await hashPassword("ReviewerStrong2026!"), f.config.now().toISOString());
  const request = { userIds: [first.id, second.id], knownWeakPassword: weak, reason: "Retire known weak testing credentials before public release", requestKey: "fixture-customer-security-1" };
  const adminSession = { user: admin };
  const login = (email, password, native = false) => f.json(native ? "/api/native/auth/login" : "/api/auth/login", { method: "POST", body: { email, password } });
  return { ...f, first, second, reviewer, request, adminSession, login, flag: () => quarantineLegacyCustomerPasswords(f.db, f.config, adminSession, request) };
}
const status = (f, id) => f.db.prepare("SELECT account_enabled,password_reset_required FROM users WHERE id=?").get(id);
function resetToken(f, email) { return f.db.prepare("SELECT body FROM local_mail_sink WHERE recipient=? AND kind='password_reset' ORDER BY rowid DESC LIMIT 1").get(email)?.body.match(/#reset-password=([A-Za-z0-9_-]+)/)?.[1]; }

test("scoped customer quarantine revokes every session, rejects old login and restores only through a strong ordinary reset", async () => {
  const f = await setup();
  try {
    const browser = await f.login(f.first.email, weak), cookie = browser.headers.get("set-cookie").split(";", 1)[0];
    const native = await f.login(f.first.email, weak, true), token = native.body.data.token, nativeHeaders = { authorization: `Bearer ${token}` };
    const reviewer = await f.login(f.reviewer.email, "ReviewerStrong2026!", true);
    const pushDevices = new Map();
    for(const id of [f.first.id,f.reviewer.id]){
      const deviceId=randomUUID(),stamp=f.config.now().toISOString(),sessionId=f.db.prepare("SELECT id FROM native_sessions WHERE user_id=? ORDER BY rowid DESC LIMIT 1").get(id).id;
      f.db.prepare("INSERT INTO customer_push_devices(id,installation_id,user_id,session_id,token_hash,ciphertext,nonce,auth_tag,key_version,platform,project_id,generation,sound_enabled,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,'synthetic encrypted token','nonce','tag','fixture','android','fixture-project',1,0,'2030-01-01T00:00:00Z',?,?)").run(deviceId,randomUUID(),id,sessionId,randomUUID(),stamp,stamp);
      f.db.prepare("INSERT INTO user_notifications(id,user_id,type,title,message,event_key,created_at) VALUES(?,?,'support_reply','Fixture update','Synthetic message',?,?)").run(randomUUID(),id,randomUUID(),stamp);
      pushDevices.set(id,deviceId);
    }
    const owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310");
    const ownerCookie = owner.headers.get("set-cookie").split(";", 1)[0], restaurant = (await f.json("/api/restaurant/restaurants", { cookie: ownerCookie })).body.data[0], item = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
    const order = await f.json("/api/orders", { method: "POST", cookie, headers: { "Idempotency-Key": "security-preserved-order" }, body: { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], fulfillment: "collection", paymentMethod: "cash" } });
    assert.equal(order.status, 201, order.text);
    const before = f.db.prepare("SELECT * FROM orders WHERE id=?").get(order.body.data.id), usersBefore = f.db.prepare("SELECT COUNT(*) n FROM users").get().n;
    const legacyBusinessToken = "legacy_misclassified_session_abcdefghijklmnopqrstuvwxyz";
    f.db.prepare("INSERT INTO native_business_sessions VALUES(?,?,?,?,?,NULL)").run(randomUUID(), f.first.id, createHash("sha256").update(legacyBusinessToken).digest("hex"), f.config.now().toISOString(), "2030-01-01T00:00:00Z");
    const result = await f.flag(); assert.equal(result.accountsChanged, 2); assert.ok(result.revokedSessions >= 3);
    const retired=f.db.prepare("SELECT revoked_at,ciphertext,nonce,auth_tag FROM customer_push_devices WHERE id=?").get(pushDevices.get(f.first.id));assert.ok(retired.revoked_at);assert.equal(retired.ciphertext,null);assert.equal(retired.nonce,null);assert.equal(retired.auth_tag,null);
    assert.equal(f.db.prepare("SELECT status FROM customer_push_outbox WHERE device_id=?").get(pushDevices.get(f.first.id)).status,"cancelled");
    const retained=f.db.prepare("SELECT revoked_at,ciphertext FROM customer_push_devices WHERE id=?").get(pushDevices.get(f.reviewer.id));assert.equal(retained.revoked_at,null);assert.ok(retained.ciphertext);
    assert.equal(f.db.prepare("SELECT status FROM customer_push_outbox WHERE device_id=?").get(pushDevices.get(f.reviewer.id)).status,"pending");
    for (const table of ["sessions", "native_sessions", "native_business_sessions"]) assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=? AND revoked_at IS NULL`).get(f.first.id).n, 0);
    assert.equal((await f.json("/api/auth/me", { cookie })).status, 401); assert.equal((await f.json("/api/native/auth/me", { headers: nativeHeaders })).status, 401);
    // Even an erroneously restored old session cannot bypass the database flag.
    f.db.prepare("UPDATE sessions SET revoked_at=NULL WHERE user_id=?").run(f.first.id); f.db.prepare("UPDATE native_sessions SET revoked_at=NULL WHERE user_id=?").run(f.first.id);
    assert.equal((await f.json("/api/auth/me", { cookie })).status, 401); assert.equal((await f.json("/api/native/auth/me", { headers: nativeHeaders })).status, 401);
    for (const nativeMode of [false, true]) {
      const blocked = await f.login(f.first.email, weak, nativeMode); assert.equal(blocked.status, 403); assert.equal(blocked.body.error.code, "PASSWORD_RESET_REQUIRED"); assert.match(blocked.body.error.message, /Forgot password/);
      assert.equal((await f.login(f.first.email, "incorrect-password", nativeMode)).body.error.code, "INVALID_CREDENTIALS");
    }
    assert.equal((await f.json("/api/native/auth/me", { headers: { authorization: `Bearer ${reviewer.body.data.token}` } })).status, 200);
    assert.equal((await f.json("/api/auth/me", { cookie: ownerCookie })).status, 200);
    assert.equal(status(f, f.first.id).account_enabled, 1); assert.equal(f.db.prepare("SELECT COUNT(*) n FROM users").get().n, usersBefore);
    assert.deepEqual(f.db.prepare("SELECT * FROM orders WHERE id=?").get(order.body.data.id), before);
    const forgot = await f.json("/api/native/auth/forgot-password", { method: "POST", body: { email: f.first.email } }); assert.equal(forgot.status, 202);
    const reset = resetToken(f, f.first.email); assert.ok(reset);
    const weakReplacement = await f.json("/api/native/auth/reset-password", { method: "POST", body: { token: reset, password: "123456123456" } }); assert.equal(weakReplacement.status, 400); assert.equal(status(f, f.first.id).password_reset_required, 1);
    const success = await f.json("/api/native/auth/reset-password", { method: "POST", body: { token: reset, password: replacement } }); assert.equal(success.status, 200, success.text);
    assert.equal(status(f, f.first.id).password_reset_required, 0); assert.equal(status(f, f.second.id).password_reset_required, 1);
    assert.equal((await f.login(f.first.email, replacement)).status, 200); assert.equal((await f.login(f.first.email, replacement, true)).status, 200);
    assert.equal((await f.login(f.first.email, weak, true)).status, 401);
    assert.equal((await f.json("/api/auth/password/reset", { method: "POST", body: { token: reset, password: replacement } })).body.error.code, "TOKEN_INVALID");
    assert.equal((await f.flag()).alreadyApplied, true); assert.equal(status(f, f.first.id).password_reset_required, 0);
    const events = f.db.prepare("SELECT action,details FROM audit_events WHERE action IN ('legacy_customer_password_quarantined','customer_password_reset_completed')").all();
    assert.equal(events.length, 2); assert.equal(JSON.stringify(events).includes(weak), false); assert.equal(JSON.stringify(events).includes("password_hash"), false);
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { await f.close(); }
});

test("quarantine rejects customers, privileged or strong-password targets and changed request scope without partial writes", async () => {
  const f = await setup();
  try {
    await assert.rejects(quarantineLegacyCustomerPasswords(f.db, f.config, { user: { id: f.first.id, role: "customer" } }, f.request), e => e.status === 403);
    await assert.rejects(quarantineLegacyCustomerPasswords(f.db, f.config, f.adminSession, { ...f.request, userIds: [f.first.id, f.adminSession.user.id] }), e => e.code === "CUSTOMER_SECURITY_SCOPE_MISMATCH");
    await assert.rejects(quarantineLegacyCustomerPasswords(f.db, f.config, f.adminSession, { ...f.request, userIds: [f.first.id, f.reviewer.id] }), e => e.code === "CUSTOMER_SECURITY_SCOPE_MISMATCH");
    assert.equal(status(f, f.first.id).password_reset_required, 0); assert.equal(status(f, f.second.id).password_reset_required, 0);
    await Promise.all([f.flag(), f.flag()]);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='legacy_customer_password_quarantined'").get().n, 1);
    await assert.rejects(quarantineLegacyCustomerPasswords(f.db, f.config, f.adminSession, { ...f.request, userIds: [f.first.id] }), e => e.code === "IDEMPOTENCY_CONFLICT");
    assert.equal((await f.login("admin@calai.local", "LocalAdmin!4310")).status, 200); assert.equal((await f.login("restaurant@calai.local", "LocalRestaurant!4310")).status, 200);
    assert.equal(status(f, f.reviewer.id).password_reset_required, 0);
  } finally { await f.close(); }
});

test("an ordinary reset completed before quarantine preflight rejects the stale reviewed scope without partial changes", async () => {
  const f = await setup();
  try {
    await f.json("/api/auth/password/forgot", { method: "POST", body: { email: f.first.email } }); const token = resetToken(f, f.first.email);
    const reset = await f.json("/api/auth/password/reset", { method: "POST", body: { token, password: replacement } });
    assert.equal(reset.status, 200, reset.text);
    // Deliberate barrier: reset has committed before the maintenance preflight
    // may read a customer. This is one legal ordering of the overlap below.
    await assert.rejects(f.flag(), error => error.code === "CUSTOMER_SECURITY_SCOPE_MISMATCH");
    assert.equal(status(f, f.first.id).password_reset_required, 0); assert.equal(status(f, f.second.id).password_reset_required, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='legacy_customer_password_quarantined'").get().n, 0);
    assert.equal((await f.login(f.first.email, replacement, true)).status, 200); assert.equal((await f.login(f.first.email, weak, true)).status, 401);
  } finally { await f.close(); }
});

test("a simultaneous ordinary reset and quarantine cannot authenticate the old password or re-quarantine a newly reset account", async () => {
  const f = await setup();
  try {
    await f.json("/api/auth/password/forgot", { method: "POST", body: { email: f.first.email } }); const token = resetToken(f, f.first.email);
    const [reset, quarantine] = await Promise.all([
      f.json("/api/auth/password/reset", { method: "POST", body: { token, password: replacement } }),
      f.flag().then(value => ({ value }), error => ({ error }))
    ]);
    assert.equal(reset.status, 200, reset.text);
    if (quarantine.error) {
      // Reset can win before initial scope verification, or after its weak
      // hash snapshot and before the transactional recheck. Both fail closed;
      // no other error or partial maintenance outcome is acceptable.
      assert.ok(["CUSTOMER_SECURITY_SCOPE_MISMATCH", "CUSTOMER_SECURITY_SCOPE_CHANGED"].includes(quarantine.error.code), quarantine.error.code);
      assert.equal(status(f, f.second.id).password_reset_required, 0);
      assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='legacy_customer_password_quarantined'").get().n, 0);
    } else {
      assert.equal(quarantine.value.accountsChanged, 2);
      assert.equal(status(f, f.second.id).password_reset_required, 1);
    }
    assert.equal(status(f, f.first.id).password_reset_required, 0); assert.equal((await f.login(f.first.email, replacement, true)).status, 200); assert.equal((await f.login(f.first.email, weak, true)).status, 401);
  } finally { await f.close(); }
});
