import assert from "node:assert/strict";
import test from "node:test";
import { ApiClient } from "../src/api-client.js";

test("uses bearer authentication and the frozen empty claim body", async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, authorization: options.headers.authorization, body: options.body });
    return new Response(JSON.stringify({ data: { job: null } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new ApiClient({ baseUrl: "http://127.0.0.1:3000", token: "opaque_test_token_abcdefghijklmnopqrstuvwxyz", timeoutMs: 1000, retry: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 }, fetchImpl });
  assert.equal(await client.claim(), null);
  assert.deepEqual(seen, [{ url: "http://127.0.0.1:3000/api/devices/jobs/claim", authorization: "Bearer opaque_test_token_abcdefghijklmnopqrstuvwxyz", body: "{}" }]);
});

test("durable client-token pairing retries a lost response with exactly the same anonymous request", async () => {
  const token = "A".repeat(43);
  const seen = [];
  const client = new ApiClient({ baseUrl: "http://127.0.0.1:3000", timeoutMs: 1000, retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 }, sleep: async () => {}, fetchImpl: async (_url, options) => {
    seen.push({ body: options.body, authentication: options.headers.authorization });
    if (seen.length === 1) throw new Error("response lost");
    return new Response(JSON.stringify({ data: { token } }), { status: 200 });
  } });
  assert.deepEqual(await client.pair("one-use-code", "Kitchen", token), { token });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], seen[1]);
  assert.equal(seen[0].authentication, undefined);
  assert.deepEqual(JSON.parse(seen[0].body), { code: "one-use-code", name: "Kitchen", clientToken: token });
});

test("legacy manual pairing is not replayed automatically, and heartbeat sends explicit reachability", async () => {
  let attempts = 0;
  let seen;
  const client = new ApiClient({ baseUrl: "http://127.0.0.1:3000", token: "opaque_test_token_abcdefghijklmnopqrstuvwxyz", timeoutMs: 1000, retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 }, fetchImpl: async (url, options) => {
    attempts += 1;
    if (url.endsWith("/pair")) throw new Error("response lost");
    seen = JSON.parse(options.body);
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  } });
  await assert.rejects(client.pair("one-use-code", "Kitchen"), /unavailable/);
  assert.equal(attempts, 1);
  await client.heartbeat({ printerReachable: false, transport: "tcp-escpos" });
  assert.deepEqual(seen, { printerReachable: false, transport: "tcp-escpos" });
});
