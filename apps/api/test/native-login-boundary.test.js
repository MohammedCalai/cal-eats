import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword } from "../src/auth/passwords.js";
import { journeyFixture } from "./helpers.js";

test("native sign-in accepts an existing short password and keeps customer and business identities separate", async () => {
  const f = await journeyFixture({ rateLimit: { attempts: 100, windowMs: 60_000 } });
  const login = (email, password, path = "/api/native/auth/login") => f.json(path, { method: "POST", body: { email, password } });
  try {
    const email = "customer+app@example.test";
    f.db.prepare("UPDATE users SET email=?,password_hash=? WHERE email='customer@calai.local'").run(email, await hashPassword("123456"));
    const signed = await login(" Customer+App@Example.Test ", "123456");
    assert.equal(signed.status, 200);
    assert.equal(signed.body.data.user.email, email);
    assert.equal(signed.body.data.user.role, "customer");
    assert.equal((await f.json("/api/native/auth/me", { headers: { authorization: `Bearer ${signed.body.data.token}` } })).body.data.user.role, "customer");

    const initialSessions = f.db.prepare("SELECT COUNT(*) n FROM native_sessions").get().n;
    const wrongRole = await login("restaurant@calai.local", "LocalRestaurant!4310");
    assert.equal(wrongRole.status, 401);
    assert.equal(wrongRole.body.error.code, "CUSTOMER_ACCOUNT_REQUIRED");
    assert.match(wrongRole.body.error.message, /customer account/);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM native_sessions").get().n, initialSessions);
    assert.equal(wrongRole.headers.get("set-cookie"), undefined);

    const wrongPassword = await login("restaurant@calai.local", "incorrect-password");
    const missingAccount = await login("unknown@example.test", "incorrect-password");
    assert.equal(wrongPassword.status, 401);
    assert.deepEqual(wrongPassword.body, missingAccount.body);
    assert.equal(wrongPassword.body.error.code, "INVALID_CREDENTIALS");
    const wrongBusinessRole = await login(email, "123456", "/api/native/business/auth/login");
    assert.equal(wrongBusinessRole.status, 401);
    assert.equal(wrongBusinessRole.body.error.code, "BUSINESS_ACCOUNT_REQUIRED");
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM native_business_sessions").get().n, 0);

    const registration = await f.json("/api/native/auth/register", { method: "POST", body: { name: "New Customer", email: "new@example.test", password: "123456" } });
    assert.equal(registration.status, 400, "registration keeps the stronger new-password requirement");
  } finally { await f.close(); }
});
