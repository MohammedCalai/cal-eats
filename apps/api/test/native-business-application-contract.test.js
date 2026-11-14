import assert from "node:assert/strict";
import test from "node:test";
import { businessApplicationPayload } from "../../mobile/src/business-application.ts";
import { journeyFixture } from "./helpers.js";

test("the native application payload works without collecting credentials and preserves server contact validation", async () => {
  const f = await journeyFixture();
  try {
    const fields = { name: " Native Owner ", email: " NATIVE-CONTRACT@EXAMPLE.TEST ", restaurantName: " Native Market Kitchen ", address: " 12 Market Street, London E1 1AA ", mobile: " 07700 900123 ", password: "NeverSendThisPassword!123" };
    const body = businessApplicationPayload(fields);
    assert.equal(Object.hasOwn(body, "password"), false);
    const count = () => f.db.prepare("SELECT COUNT(*) n FROM users").get().n, before = count();
    const invalid = await f.json("/api/native/business/auth/apply", { method: "POST", body: { ...body, address: "No postcode" } });
    assert.equal(invalid.status, 400, invalid.text); assert.equal(count(), before);
    const options = { method: "POST", headers: { "Idempotency-Key": "native-contract-application-001" }, body };
    const created = await f.json("/api/native/business/auth/apply", options);
    assert.equal(created.status, 201, created.text); assert.equal(created.body.data.loginPreparedByAdmin, true);
    assert.equal(created.headers.has("set-cookie"), false); assert.equal(Object.hasOwn(created.body.data, "token"), false);
    const applicant = f.db.prepare("SELECT id,account_enabled,email FROM users WHERE email=?").get("native-contract@example.test");
    assert.equal(applicant.account_enabled, 0);
    for (const table of ["sessions", "native_sessions", "native_business_sessions"]) assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get(applicant.id).n, 0);
    const replay = await f.json("/api/native/business/auth/apply", options);
    assert.equal(replay.status, 200, replay.text); assert.equal(replay.body.data.restaurantId, created.body.data.restaurantId); assert.equal(count(), before + 1);
  } finally { await f.close(); }
});
