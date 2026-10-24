import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { closeDatabase, migrateDatabase, openDatabase } from "../src/db/index.js";
import { seedDemoData } from "../src/seed.js";
import { closeServer, createServer } from "../src/server.js";

const directory = await mkdtemp(path.join(tmpdir(), "calai-eats-smoke-"));
const dbPath = path.join(directory, "smoke.sqlite");
let db = openDatabase(dbPath);
let server;
try {
  migrateDatabase(db);
  await seedDemoData(db);
  const config = loadConfig({ dbPath, port: 4310 });
  server = createServer(createApp({ db, config }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.expectedHost = `127.0.0.1:${server.address().port}`;
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  assert.doesNotMatch(page.headers.get("content-security-policy"), /unsafe-inline/);
  async function call(route, { method = "GET", body, cookie, headers = {} } = {}) {
    const response = await fetch(base + route, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}), ...(method === "GET" ? {} : { Origin: config.origin }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    assert.ok(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(data)}`);
    return { response, data: data.data };
  }
  async function login(email, password) {
    const result = await call("/api/auth/login", { method: "POST", body: { email, password } });
    return result.response.headers.get("set-cookie").split(";", 1)[0];
  }
  const customer = await login("customer@calai.local", "LocalCustomer!4310");
  const owner = await login("restaurant2@calai.local", "LocalRestaurant2!4310");
  const admin = await login("admin@calai.local", "LocalAdmin!4310");
  const restaurant = (await call("/api/restaurant/restaurants", { cookie: owner })).data[0];
  assert.equal(restaurant.status, "pending");
  const item = (await call(`/api/restaurant/restaurants/${restaurant.id}/menu`, { method: "POST", cookie: owner, body: { name: "Smoke meal", description: "End-to-end fixture", priceMinor: 1200 } })).data;
  await call(`/api/admin/restaurants/${restaurant.id}/approval`, { method: "PATCH", cookie: admin, body: { status: "approved" } });
  assert.equal((await call(`/api/restaurants/${restaurant.id}/menu`)).data.items.length, 1);
  const order = (await call("/api/orders", { method: "POST", cookie: customer, headers: { "Idempotency-Key": "smoke-order" }, body: { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], paymentMethod: "mock_card", fulfillment: "delivery", deliveryAddress: { line1: "1 Smoke Road", city: "Luton", postcode: "LU1 1AA" } } })).data;
  await call(`/api/restaurant/orders/${order.id}/status`, { method: "PATCH", cookie: owner, body: { status: "accepted" } });
  assert.equal((await call(`/api/orders/${order.id}`, { cookie: customer })).data.status, "accepted");
  assert.equal((await call("/api/admin/ledger", { cookie: admin })).data.length, 1);
  const printJob = (await call(`/api/orders/${order.id}/print-jobs`, { method: "POST", cookie: customer, body: {} })).data;
  await call(`/api/print-jobs/${printJob.id}`, { method: "PATCH", cookie: customer, body: { status: "browser_opened" } });
  const receipt = await fetch(`${base}${printJob.receiptUrl}`, { headers: { Cookie: customer } });
  assert.equal(receipt.status, 200);
  assert.match(await receipt.text(), /Mock card — no real payment processed/);
  const refunded = (await call(`/api/admin/orders/${order.id}/refunds`, { method: "POST", cookie: admin, headers: { "Idempotency-Key": "smoke-refund" }, body: { foodAmountMinor: 1200, deliveryAmountMinor: 250, reason: "Full local smoke refund" } })).data;
  assert.equal(refunded.order.paymentStatus, "mock_refunded");
  assert.equal((await fetch(`${base}/api/admin/reports/orders.csv`, { headers: { Cookie: admin } })).status, 200);
  await closeServer(server); server = null;
  closeDatabase(db); db = null;
  db = openDatabase(dbPath);
  migrateDatabase(db);
  assert.equal(db.prepare("SELECT status FROM orders WHERE id=?").get(order.id).status, "accepted");
  assert.equal(db.prepare("SELECT payment_status FROM orders WHERE id=?").get(order.id).payment_status, "mock_refunded");
  assert.equal(db.prepare("SELECT count(*) AS n FROM ledger_entries WHERE order_id=?").get(order.id).n, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM refunds WHERE order_id=?").get(order.id).n, 1);
  console.log("Smoke journey passed with persisted approval, order, print job, refund and balanced commission after database reopen.");
} finally {
  if (server) await closeServer(server);
  if (db) closeDatabase(db);
  await rm(directory, { recursive: true, force: true });
}
