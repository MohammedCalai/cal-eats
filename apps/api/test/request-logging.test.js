import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

function request(app, url, extraHeaders = {}) {
  const req = Readable.from([]);
  Object.assign(req, { method: "GET", url, socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:4310", ...extraHeaders } });
  return new Promise(resolve => {
    const headers = new Map();
    const res = { headersSent: false, statusCode: 200, setHeader(key, value) { headers.set(key.toLowerCase(), value); }, writeHead(status) { this.statusCode = status; this.headersSent = true; }, end(value) { resolve({ status: this.statusCode, body: JSON.parse(value), headers }); } };
    void app(req,res);
  });
}

test("server errors have a generated correlation ID without sensitive log content", async () => {
  const logs = [], secret = "customer-private-token-and-message";
  const db = { prepare() { throw new Error(secret); } };
  const app = createApp({ db, config: loadConfig(), logger: { error(value) { logs.push(value); } } });
  const response = await request(app, `/api/restaurants?token=${secret}`, { "x-request-id": secret, cookie: `calai_session=${secret}` });
  assert.equal(response.status, 500);
  assert.match(response.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0], new RegExp(secret));
  const log = JSON.parse(logs[0]);
  assert.equal(log.requestId, response.headers.get("x-request-id"));
  assert.equal(log.event, "request_failed");
  assert.equal(log.code, "INTERNAL_ERROR");
  assert.equal(log.method, "GET");
  assert.ok(log.durationMs >= 0);
  assert.deepEqual(Object.keys(log).sort(), ["code","durationMs","event","method","requestId","status"]);
  assert.equal(response.body.error.message,"Internal server error");
});

test("successful requests get distinct IDs and logging failures do not change error responses", async () => {
  const app = createApp({ db: { prepare() { throw new Error("private detail"); } }, config: loadConfig(), logger: { error() { throw new Error("logging unavailable"); } } });
  const first = await request(app,"/health/live"), second = await request(app,"/health/live");
  assert.equal(first.status,200); assert.equal(second.status,200);
  assert.notEqual(first.headers.get("x-request-id"),second.headers.get("x-request-id"));
  assert.equal((await request(app,"/api/restaurants")).status,500);
});
