import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { createApp } from "../src/app.js";
import { createInitialAdmin } from "../src/admin-bootstrap.js";
import { loadConfig } from "../src/config.js";
import { migrateDatabase, openDatabase, closeDatabase } from "../src/db/index.js";
import { assertHostedPreviewSafe, seedDemoData } from "../src/seed.js";
import { closeServer, createServer } from "../src/server.js";
import { journeyFixture } from "./helpers.js";

function invoke(app, config, route, { method = "GET", body, headers = {} } = {}) {
  const allHeaders = { host: config.expectedHost, ...headers }; const input = body === undefined ? "" : JSON.stringify(body); if (body !== undefined) allHeaders["content-type"] = "application/json";
  const req = Readable.from(input ? [Buffer.from(input)] : []); Object.assign(req, { method, url: route, headers: allHeaders, socket: { remoteAddress: "127.0.0.9" } });
  return new Promise((resolve) => { const responseHeaders = new Map(); const chunks = []; const res = { headersSent: false, statusCode: 200, setHeader(k, v) { responseHeaders.set(k.toLowerCase(), v); }, writeHead(status, values = {}) { this.statusCode = status; this.headersSent = true; for (const [k, v] of Object.entries(values)) responseHeaders.set(k.toLowerCase(), v); }, end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.statusCode, headers: responseHeaders, body: JSON.parse(Buffer.concat(chunks).toString()) }); }, destroy() { resolve({ status: this.statusCode, headers: responseHeaders, body: null }); } }; app(req, res); });
}

test("hosted preview requires HTTPS, exact write origins and secure cookies", async () => {
  assert.throws(() => loadConfig({ runMode: "hosted-preview", hostname: "0.0.0.0" }), /CALAI_ORIGIN/);
  assert.throws(() => loadConfig({ runMode: "hosted-preview", hostname: "0.0.0.0", origin: "http://preview.example" }), /HTTPS/);
  assert.throws(() => loadConfig({ runMode: "local", nodeEnv: "production" }), /hosted-preview/);
  const f = await journeyFixture({ runMode: "hosted-preview", hostname: "0.0.0.0", origin: "https://preview.example", expectedHost: "preview.example", secureCookies: true, demoShortcuts: false, healthcheckHost: "healthcheck.railway.app", rateLimit: { attempts: 20, windowMs: 60_000 } });
  try {
    assert.deepEqual((await f.json("/api/runtime")).body.data, { mode: "hosted-preview", demoShortcuts: false, simulatedPayments: true });
    assert.equal((await f.json("/health/ready", { headers: { host: "healthcheck.railway.app" } })).status, 200); assert.equal((await f.json("/api/runtime", { headers: { host: "healthcheck.railway.app" } })).status, 403);
    assert.equal((await f.json("/api/auth/login", { method: "POST", body: { email: "customer@calai.local", password: "LocalCustomer!4310" } })).body.error.code, "INVALID_ORIGIN");
    const login = await f.json("/api/auth/login", { method: "POST", headers: { origin: "https://preview.example" }, body: { email: "customer@calai.local", password: "LocalCustomer!4310" } }); assert.equal(login.status, 200); assert.match(login.headers.get("set-cookie"), /; Secure;/);
  } finally { await f.close(); }
});

test("hosted seed and reserved fixtures are refused while initial admin never changes accounts", async () => {
  const db = openDatabase(":memory:"); migrateDatabase(db);
  try {
    await assert.rejects(seedDemoData(db, new Date(), { runMode: "hosted-preview" }), /local mode/); assert.equal(db.prepare("SELECT COUNT(*) count FROM users").get().count, 0);
    const admin = await createInitialAdmin(db, { name: "Preview Admin", email: "admin@example.test", password: "a long private password", runMode: "hosted-preview" }); assert.equal(admin.role, "admin");
    await assert.rejects(createInitialAdmin(db, { name: "Other", email: "other@example.test", password: "a second private password", runMode: "hosted-preview" }), /already exists/);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM users").get().count, 1); assert.doesNotThrow(() => assertHostedPreviewSafe(db, { runMode: "hosted-preview" }));
    db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES('reserved','Reserved','customer@calai.local','x','customer','2026-01-01T00:00:00Z')").run(); assert.throws(() => assertHostedPreviewSafe(db, { runMode: "hosted-preview" }), /reserved demo/);
  } finally { closeDatabase(db); }
});

test("authentication throttle persists when the app instance restarts", async () => {
  const db = openDatabase(":memory:"); migrateDatabase(db); const config = loadConfig({ rateLimit: { attempts: 1, windowMs: 60_000 }, now: () => new Date("2026-01-01T00:00:00Z") });
  try {
    const first = await invoke(createApp({ db, config }), config, "/api/auth/login", { method: "POST", body: { email: "absent@example.test", password: "invalid password" } }); assert.equal(first.status, 401);
    const second = await invoke(createApp({ db, config }), config, "/api/auth/login", { method: "POST", body: { email: "absent@example.test", password: "invalid password" } }); assert.equal(second.body.error.code, "RATE_LIMITED"); assert.ok(db.prepare("SELECT COUNT(*) count FROM auth_rate_limits").get().count > 0);
  } finally { closeDatabase(db); }
});

test("HTTP server exposes bounded timeouts and reports handlers held past shutdown grace", async () => {
  let release; const held = new Promise((resolve) => { release = resolve; });
  const server = createServer(async (_req, res) => { await held; res.end("ok"); });
  assert.equal(server.headersTimeout, 15_000); assert.equal(server.requestTimeout, 30_000); assert.equal(server.keepAliveTimeout, 5_000);
  server.emit("request", {}, { headersSent: false, end() {}, destroy() {} }); await Promise.resolve();
  const forced = await closeServer(server, { graceMs: 5 }); assert.equal(forced.drained, false); assert.equal(forced.pendingHandlers, 1);
  release(); await new Promise((resolve) => setTimeout(resolve, 0)); assert.deepEqual(await closeServer(server, { graceMs: 5 }), { drained: true, pendingHandlers: 0 });
});
