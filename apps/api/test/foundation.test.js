import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Readable } from "node:stream";
import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { closeDatabase, migrateDatabase, openDatabase } from "../src/db/index.js";
import { migrations } from "../src/db/migrations.js";
import { createServer, closeServer } from "../src/server.js";
import { calculateCommission } from "../../../packages/contracts/src/index.js";

async function fixture({ migrate = true, now = new Date("2026-01-01T00:00:00.000Z") } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "calai-eats-"));
  const dbPath = path.join(directory, "test.sqlite");
  const db = openDatabase(dbPath);
  if (migrate) migrateDatabase(db);
  const clock = { value: now };
  const config = loadConfig({ port: 4310, dbPath, now: () => clock.value });
  const app = createApp({ db, config });
  async function request(route, options = {}) {
    const headers = Object.fromEntries(Object.entries({ host: config.expectedHost, ...options.headers }).map(([key, value]) => [key.toLowerCase(), value]));
    let requestBody = "";
    if (options.body !== undefined) { headers["content-type"] ??= "application/json"; requestBody = JSON.stringify(options.body); }
    const req = Readable.from(requestBody ? [Buffer.from(requestBody)] : []);
    Object.assign(req, { method: options.method ?? "GET", url: route, headers, socket: { remoteAddress: "127.0.0.1" } });
    return await new Promise((resolve) => {
      const responseHeaders = new Map();
      const chunks = [];
      const res = {
        headersSent: false,
        statusCode: 200,
        setHeader(name, value) { responseHeaders.set(name.toLowerCase(), value); },
        writeHead(status, moreHeaders = {}) { this.statusCode = status; this.headersSent = true; for (const [key, value] of Object.entries(moreHeaders)) responseHeaders.set(key.toLowerCase(), value); },
        end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.statusCode, headers: { get: (name) => responseHeaders.get(name.toLowerCase()) ?? null }, json: async () => JSON.parse(Buffer.concat(chunks).toString("utf8")) }); },
        destroy() { resolve({ status: this.statusCode, headers: { get: () => null }, json: async () => ({}) }); }
      };
      app(req, res);
    });
  }
  return { db, dbPath, directory, request, clock, async close() { closeDatabase(db); await rm(directory, { recursive: true, force: true }); } };
}

async function json(response) {
  const setCookie = response.headers.get("set-cookie") ?? undefined;
  return { status: response.status, body: await response.json(), cookie: setCookie?.split(";", 1)[0], setCookie };
}

test("migrations are repeatable and persisted after reopen", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "calai-eats-persist-"));
  const dbPath = path.join(directory, "test.sqlite");
  let db = openDatabase(dbPath);
  try {
    assert.equal(migrateDatabase(db), 6);
    assert.equal(migrateDatabase(db), 6);
    db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)").run("u1", "Saved", "saved@example.test", "hash", "customer", new Date().toISOString());
    closeDatabase(db);
    db = openDatabase(dbPath);
    migrateDatabase(db);
    assert.equal(db.prepare("SELECT name FROM users WHERE id='u1'").get().name, "Saved");
  } finally { closeDatabase(db); await rm(directory, { recursive: true, force: true }); }
});

test("v1 to v2 migration preserves existing journey records", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "calai-eats-v1-"));
  const db = openDatabase(path.join(directory, "test.sqlite"));
  try {
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    db.exec(migrations[0].sql);
    db.prepare("INSERT INTO schema_migrations VALUES(1,'initial_schema',?)").run(new Date().toISOString());
    const now = new Date().toISOString();
    db.prepare("INSERT INTO users VALUES(?,?,?,?,?,?)").run("u", "User", "u@example.test", "hash", "customer", now);
    db.prepare("INSERT INTO restaurants VALUES(?,?,?,?)").run("r", "Restaurant", "approved", now);
    db.prepare("INSERT INTO menu_items VALUES(?,?,?,?,?,?,?,?)").run("m", "r", "Meal", "", 1000, 1, now, now);
    db.prepare("INSERT INTO orders VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("o", "r", "Restaurant", "u", "accepted", "GBP", 1000, 70, "mock_card", "mock_captured", "collection", "key", "hash", now, now);
    db.prepare("INSERT INTO order_items VALUES(?,?,?,?,?,?)").run("i", "o", "m", "Meal", 1000, 1);
    db.prepare("INSERT INTO order_events VALUES(?,?,?,?,?,?,?)").run("e", "o", "u", "status_changed", "placed", "accepted", now);
    db.prepare("INSERT INTO ledger_entries VALUES(?,?,?,?,?,?,?)").run("l", "o", "r", "commission_mock", 70, "GBP", now);
    migrateDatabase(db);
    const order = db.prepare("SELECT * FROM orders WHERE id='o'").get();
    assert.equal(order.total_minor, 1000);
    assert.equal(order.delivery_fee_minor, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM order_items WHERE order_id='o'").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM order_events WHERE order_id='o'").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM ledger_entries WHERE order_id='o'").get().n, 1);
  } finally { closeDatabase(db); await rm(directory, { recursive: true, force: true }); }
});

test("health reports liveness and migration readiness", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await json(await f.request("/health/live")), { status: 200, body: { data: { status: "ok", service: "calai-eats-api" } }, cookie: undefined, setCookie: undefined });
    assert.equal((await f.request("/health/ready")).status, 200);
  } finally { await f.close(); }
  const unready = await fixture({ migrate: false });
  try { assert.equal((await unready.request("/health/ready")).status, 503); } finally { await unready.close(); }
});

test("customer registration, login, expiry and logout lifecycle", async () => {
  const f = await fixture();
  try {
    const credentials = { name: "Ada Customer", email: "ADA@example.test", password: "a sufficiently long passphrase" };
    const registered = await json(await f.request("/api/auth/register", { method: "POST", body: credentials, headers: { Origin: "http://127.0.0.1:4310" } }));
    assert.equal(registered.status, 201);
    assert.equal(registered.body.data.user.role, "customer");
    assert.match(registered.setCookie, /HttpOnly/);
    assert.match(registered.setCookie, /SameSite=Strict/);
    assert.match(registered.setCookie, /Max-Age=86400/);
    assert.equal((await f.request("/api/auth/me", { headers: { Cookie: registered.cookie } })).status, 200);
    f.clock.value = new Date("2026-01-02T00:00:01.000Z");
    assert.equal((await f.request("/api/auth/me", { headers: { Cookie: registered.cookie } })).status, 401);
    f.clock.value = new Date("2026-01-01T00:01:00.000Z");
    const loggedIn = await json(await f.request("/api/auth/login", { method: "POST", body: { email: credentials.email, password: credentials.password } }));
    assert.equal(loggedIn.status, 200);
    assert.equal((await f.request("/api/auth/logout", { method: "POST", body: {}, headers: { Cookie: loggedIn.cookie } })).status, 200);
    assert.equal((await f.request("/api/auth/me", { headers: { Cookie: loggedIn.cookie } })).status, 401);
  } finally { await f.close(); }
});

test("registration blocks role escalation and requests enforce origin and host", async () => {
  const f = await fixture();
  try {
    const badRole = await f.request("/api/auth/register", { method: "POST", body: { name: "Mallory", email: "mallory@example.test", password: "a sufficiently long passphrase", role: "admin" } });
    assert.equal(badRole.status, 400);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM users").get().n, 0);
    const badOrigin = await f.request("/api/auth/login", { method: "POST", body: { email: "nobody@example.test", password: "some password" }, headers: { Origin: "http://evil.test" } });
    assert.equal(badOrigin.status, 403);
    assert.equal((await f.request("/api/future", { method: "PATCH", body: {}, headers: { Origin: "http://evil.test" } })).status, 403);
    const badHost = await f.request("/health/live", { headers: { Host: "localhost:4310" } });
    assert.equal(badHost.status, 403);
  } finally { await f.close(); }
});

test("invalid login is generic and commission rounding is precise", async () => {
  const f = await fixture();
  try {
    const response = await json(await f.request("/api/auth/login", { method: "POST", body: { email: "missing@example.test", password: "irrelevant password" } }));
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect" } });
    assert.equal(calculateCommission(1999), 140);
    assert.equal(calculateCommission(Number.MAX_SAFE_INTEGER), Number((BigInt(Number.MAX_SAFE_INTEGER) * 700n + 5000n) / 10000n));
  } finally { await f.close(); }
});

test("successful legacy scrypt login upgrades the stored hash", async () => {
  const f = await fixture();
  try {
    const password = "legacy local password"; const salt = randomBytes(16);
    const derived = await promisify(scryptCallback)(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const legacy = `scrypt$16384$8$1$${salt.toString("hex")}$${derived.toString("hex")}`;
    f.db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)").run("legacy", "Legacy", "legacy@example.test", legacy, "customer", new Date().toISOString());
    const response = await f.request("/api/auth/login", { method: "POST", body: { email: "legacy@example.test", password } });
    assert.equal(response.status, 200);
    assert.match(f.db.prepare("SELECT password_hash FROM users WHERE id='legacy'").get().password_hash, /^scrypt\$32768\$8\$3\$/);
  } finally { await f.close(); }
});

test("HTTP server carries cookies across the real loopback transport", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "calai-eats-http-"));
  const db = openDatabase(path.join(directory, "test.sqlite"));
  migrateDatabase(db);
  const config = loadConfig({ port: 4310, dbPath: path.join(directory, "test.sqlite") });
  const server = createServer(createApp({ db, config }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.expectedHost = `127.0.0.1:${server.address().port}`;
  try {
    const registered = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { Origin: config.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Transport User", email: "transport@example.test", password: "transport passphrase" })
    });
    assert.equal(registered.status, 201);
    const cookie = registered.headers.get("set-cookie").split(";", 1)[0];
    const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).data.user.email, "transport@example.test");
  } finally {
    await closeServer(server);
    closeDatabase(db);
    await rm(directory, { recursive: true, force: true });
  }
});
