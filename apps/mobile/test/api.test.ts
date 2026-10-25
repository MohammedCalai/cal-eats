import assert from "node:assert/strict";
import test from "node:test";
import { validateBase } from "../src/api.ts";

test("permits explicit IPv4 and IPv6 loopback HTTP", () => {
  assert.equal(validateBase("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.equal(validateBase("http://[::1]:3000"), "http://[::1]:3000");
});
test("rejects cleartext remote APIs", () => assert.throws(() => validateBase("http://example.test"), /HTTPS/));
test("rejects original host regardless of case or trailing dot", () => {
  assert.throws(() => validateBase("https://CALAI.INFO./"), /original Calai host/);
  assert.throws(() => validateBase("https://api.CalAi.Info./"), /original Calai host/);
});
test("rejects URL credentials", () => assert.throws(() => validateBase("https://user:secret@example.test"), /credentials/));
