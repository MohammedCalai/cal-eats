import assert from "node:assert/strict";
import test from "node:test";
import { journeyFixture } from "./helpers.js";

test("customers can request an internal account review without supplying a reason", async () => {
  const f = await journeyFixture();
  try {
    const cookie = await f.login("customer@calai.local", "LocalCustomer!4310");
    const native = await f.json("/api/native/auth/login", { method: "POST", body: { email: "customer@calai.local", password: "LocalCustomer!4310" } });
    assert.equal(native.status, 200, native.text);
    const userId = native.body.data.user.id;
    for (const request of [
      { route: "/api/account/deletion-requests", cookie, body: {} },
      { route: "/api/native/account/deletion-request", headers: { authorization: `Bearer ${native.body.data.token}` }, body: { reason: "   " } }
    ]) {
      const result = await f.json(request.route, { method: "POST", ...request });
      assert.equal(result.status, 201, result.text);
      assert.equal(result.body.data.reason, "");
      assert.equal(result.body.data.status, "requested");
      assert.equal(result.body.data.userId, userId);
    }
    assert.equal(f.db.prepare("SELECT account_enabled FROM users WHERE id=?").get(userId).account_enabled, 1);
    assert.equal((await f.json("/api/account/deletion-requests", { method: "POST", body: {} })).status, 401);
    for (const reason of ["x".repeat(1001), 123]) {
      const rejected = await f.json("/api/account/deletion-requests", { method: "POST", cookie, body: { reason } });
      assert.equal(rejected.status, 400, rejected.text);
    }
    assert.equal(f.db.prepare("SELECT count(*) AS count FROM deletion_requests WHERE user_id=?").get(userId).count, 2);
  } finally {
    await f.close();
  }
});
