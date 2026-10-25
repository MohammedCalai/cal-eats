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
