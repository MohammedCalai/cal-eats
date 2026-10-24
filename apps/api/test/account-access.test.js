import assert from "node:assert/strict";
import test from "node:test";
import { journeyFixture } from "./helpers.js";

const customer = ["customer@calai.local", "LocalCustomer!4310"];
function latestToken(db, kind, email) {
  const row = db.prepare("SELECT body FROM local_mail_sink WHERE kind=? AND recipient=? ORDER BY rowid DESC LIMIT 1").get(kind, email);
  const match = row?.body.match(/#(?:reset-password|verify-email)=([A-Za-z0-9_-]+)/); assert.ok(match, "local sink should contain a token link"); return match[1];
}

test("password recovery is generic, single use and revokes every existing session", async () => {
  const f = await journeyFixture({ rateLimit: { attempts: 100, windowMs: 60_000 } });
  try {
    const oldSession = await f.login(...customer); const secondSession = await f.login(...customer);
    const unknown = await f.json("/api/auth/password/forgot", { method: "POST", body: { email: "unknown@example.test" } });
    const known = await f.json("/api/auth/password/forgot", { method: "POST", body: { email: customer[0] } });
    assert.equal(unknown.status, 202); assert.deepEqual(unknown.body, known.body); assert.equal(f.db.prepare("SELECT COUNT(*) count FROM local_mail_sink WHERE recipient='unknown@example.test'").get().count, 0);
    const token = latestToken(f.db, "password_reset", customer[0]); const stored = f.db.prepare("SELECT token_hash FROM account_access_tokens WHERE purpose='password_reset' ORDER BY rowid DESC LIMIT 1").get(); assert.notEqual(stored.token_hash, token);
    const reset = await f.json("/api/auth/password/reset", { method: "POST", body: { token, password: "A new local password 4310" } }); assert.equal(reset.status, 200); assert.equal(reset.body.data.passwordReset, true); assert.equal(reset.headers.get("set-cookie"), undefined);
    assert.equal((await f.json("/api/auth/me", { cookie: oldSession })).status, 401); assert.equal((await f.json("/api/auth/me", { cookie: secondSession })).status, 401);
    assert.equal((await f.json("/api/auth/password/reset", { method: "POST", body: { token, password: "Another valid password" } })).body.error.code, "TOKEN_INVALID");
    assert.equal((await f.json("/api/auth/login", { method: "POST", body: { email: customer[0], password: customer[1] } })).status, 401);
    assert.equal((await f.json("/api/auth/login", { method: "POST", body: { email: customer[0], password: "A new local password 4310" } })).status, 200);
  } finally { await f.close(); }
});

test("expired and concurrently consumed reset tokens cannot be reused", async () => {
  const f = await journeyFixture({ rateLimit: { attempts: 100, windowMs: 60_000 } });
  try {
    await f.json("/api/auth/password/forgot", { method: "POST", body: { email: customer[0] } }); let token = latestToken(f.db, "password_reset", customer[0]);
    f.db.prepare("UPDATE account_access_tokens SET expires_at='2025-01-01T00:00:00.000Z' WHERE token_hash IS NOT NULL").run();
    assert.equal((await f.json("/api/auth/password/reset", { method: "POST", body: { token, password: "A safe replacement password" } })).body.error.code, "TOKEN_INVALID");
    await f.json("/api/auth/password/forgot", { method: "POST", body: { email: customer[0] } }); token = latestToken(f.db, "password_reset", customer[0]);
    const results = await Promise.all(["Concurrent password one", "Concurrent password two"].map((password) => f.json("/api/auth/password/reset", { method: "POST", body: { token, password } })));
    assert.deepEqual(results.map((row) => row.status).sort(), [200, 400]); assert.equal(results.find((row) => row.status === 400).body.error.code, "TOKEN_INVALID");
  } finally { await f.close(); }
});

test("local email verification updates only its account and never appears in exports", async () => {
  const f = await journeyFixture({ rateLimit: { attempts: 100, windowMs: 60_000 } });
  try {
    const first = await f.login(...customer); const registration = await f.json("/api/auth/register", { method: "POST", body: { name: "Other customer", email: "verify-other@example.test", password: "another local password" } }); const other = registration.headers.get("set-cookie").split(";", 1)[0];
    assert.equal((await f.json("/api/account", { cookie: first })).body.data.emailVerified, false);
    assert.equal((await f.json("/api/auth/email-verification/send", { method: "POST", cookie: first, body: {} })).status, 202);
    const token = latestToken(f.db, "email_verification", customer[0]); const confirmed = await f.json("/api/auth/email-verification/confirm", { method: "POST", body: { token } }); assert.equal(confirmed.body.data.emailVerified, true);
    assert.equal((await f.json("/api/account", { cookie: first })).body.data.emailVerified, true); assert.equal((await f.json("/api/account", { cookie: other })).body.data.emailVerified, false);
    assert.equal((await f.json("/api/auth/email-verification/confirm", { method: "POST", body: { token } })).body.error.code, "TOKEN_INVALID");
    const exported = await f.json("/api/account/export", { cookie: first }); const serialized = JSON.stringify(exported.body); assert.equal(serialized.includes(token), false); assert.equal(serialized.includes("local_mail_sink"), false); assert.equal(exported.body.data.account.emailVerified, true);
  } finally { await f.close(); }
});

test("a concurrent reset cannot leave a session authenticated by the old password", async () => {
  const f = await journeyFixture({ rateLimit: { attempts: 100, windowMs: 60_000 } });
  try {
    await f.json("/api/auth/password/forgot", { method: "POST", body: { email: customer[0] } }); const token = latestToken(f.db, "password_reset", customer[0]);
    const [login, reset] = await Promise.all([
      f.json("/api/auth/login", { method: "POST", body: { email: customer[0], password: customer[1] } }),
      f.json("/api/auth/password/reset", { method: "POST", body: { token, password: "Concurrent replacement password" } })
    ]);
    assert.equal(reset.status, 200);
    if (login.status === 200) { const cookie = login.headers.get("set-cookie").split(";", 1)[0]; assert.equal((await f.json("/api/auth/me", { cookie })).status, 401); }
    else assert.equal(login.body.error.code, "INVALID_CREDENTIALS");
    assert.equal((await f.json("/api/auth/login", { method: "POST", body: { email: customer[0], password: "Concurrent replacement password" } })).status, 200);
  } finally { await f.close(); }
});
