// Opt-in, local-only directory capacity exercise. Every row is synthetic.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { openDatabase, migrateDatabase, closeDatabase, withTransaction } from "../apps/api/src/db/index.js";
import { discoverRestaurants } from "../apps/api/src/restaurant-discovery.js";

const filename = fileURLToPath(import.meta.url);
export const DIRECTORY_NOW = new Date("2026-11-08T12:00:00.000Z");
export const directoryId = index => `directory-${String(index).padStart(5, "0")}`;
const stats = values => {
  if (!values.length) return { count: 0 };
  const sorted = [...values].sort((a, b) => a - b), at = p => Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)].toFixed(2));
  return { count: sorted.length, p50: at(.5), p95: at(.95), max: at(1) };
};

export function seedDirectoryFixture(db, { restaurants = 10_000, menuItemsPerRestaurant = 20, historyPerRestaurant = 5 } = {}) {
  for (const [value, maximum] of [[restaurants, 10_000], [menuItemsPerRestaurant, 50], [historyPerRestaurant, 20]]) if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("Directory fixture size is outside its local safety bounds");
  const stamp = DIRECTORY_NOW.toISOString(), customerId = "directory-customer";
  const restaurant = db.prepare("INSERT INTO restaurants(id,name,status,created_at,cuisine,description,collection_enabled,delivery_enabled,delivery_outcodes,delivery_fee_minor,estimated_delivery_minutes,always_open) VALUES(?,?,'approved',?,?,?,1,1,?,?,?,1)");
  const item = db.prepare("INSERT INTO menu_items(id,restaurant_id,name,description,price_minor,available,created_at,updated_at,category,sort_order) VALUES(?,?,?,?,1000,1,?,?,?,?)");
  const order = db.prepare("INSERT INTO orders(id,restaurant_id,restaurant_name,customer_id,status,currency,subtotal_minor,delivery_fee_minor,total_minor,commission_minor,payment_method,payment_status,fulfillment,idempotency_key,request_hash,created_at,updated_at) VALUES(?,?,?,?,'completed','GBP',1000,0,1000,70,'mock_card','mock_captured','collection',?,?,?,?)");
  const rating = db.prepare("INSERT INTO restaurant_order_ratings(order_id,restaurant_id,customer_id,stars,created_at) VALUES(?,?,?,?,?)");
  withTransaction(db, () => {
    // This invalid hash cannot authenticate. No real customer/owner identities exist.
    db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,'directory@load.invalid','invalid-synthetic-hash','customer',?)").run(customerId, "Synthetic directory customer", stamp);
    for (let index = 0; index < restaurants; index++) {
      const id = directoryId(index), name = `Synthetic restaurant ${String(index).padStart(5, "0")}`;
      restaurant.run(id, name, stamp, `Synthetic ${index % 20}`, "Synthetic capacity fixture only", JSON.stringify([index % 2 ? "N1" : "LU1"]), index % 5 ? 199 : 0, 20 + index % 20);
      for (let dish = 0; dish < menuItemsPerRestaurant; dish++) item.run(`${id}-item-${dish}`, id, index === restaurants - 1 && dish === menuItemsPerRestaurant - 1 ? "Rare capers finale" : `Synthetic dish ${dish}`, "Synthetic menu fixture", stamp, stamp, dish % 2 ? "Sides" : "Mains", dish);
      for (let history = 0; history < historyPerRestaurant; history++) {
        const orderId = `${id}-history-${history}`, recent = history < 1 + index % 5;
        const created = new Date(DIRECTORY_NOW.getTime() - (recent ? history : 40 + history) * 86400000).toISOString();
        order.run(orderId, id, name, customerId, orderId, "synthetic-directory-only", created, created);
        if (history < 2) rating.run(orderId, id, customerId, 1 + (index + history) % 5, created);
      }
    }
  });
  return { restaurants, menuItems: restaurants * menuItemsPerRestaurant, historicalOrders: restaurants * historyPerRestaurant, ratings: restaurants * Math.min(historyPerRestaurant, 2), syntheticAccounts: 1, images: 0 };
}

function observedQuery(db, query, url) {
  let preparedStatements = 0, executedStatements = 0;
  const counted = { prepare(sql) {
    preparedStatements++; const statement = db.prepare(sql);
    return { all(...args) { executedStatements++; return statement.all(...args); }, get(...args) { executedStatements++; return statement.get(...args); } };
  } };
  const start = performance.now(), result = query(counted, new URL(url, "http://127.0.0.1"), DIRECTORY_NOW);
  return { result, ms: performance.now() - start, preparedStatements, executedStatements };
}

export async function runDirectoryCapacity({ baselineDiscover = null, baselineLabel = null } = {}) {
  const started = new Date(), directory = path.resolve("artifacts", `restaurant-directory-capacity-${started.toISOString().replaceAll(":", "-")}`);
  await fs.mkdir(directory, { recursive: true });
  const databasePath = path.join(directory, "synthetic.sqlite"), db = openDatabase(databasePath);
  let child;
  const failures = [], httpMeasurements = [], queryMeasurements = [];
  try {
    migrateDatabase(db);
    const seedStarted = performance.now(), dataset = seedDirectoryFixture(db), seedMs = performance.now() - seedStarted;
    db.exec("ANALYZE");
    const ids = Array.from({ length: dataset.restaurants }, (_, index) => directoryId(index));
    const cases = [
      { label: "first page", route: "/api/restaurants?pageSize=50", expected: ids.slice(0, 50) },
      { label: "last page", route: "/api/restaurants?page=200&pageSize=50", expected: ids.slice(-50) },
      { label: "past last page", route: "/api/restaurants?page=201&pageSize=50", expected: [] },
      { label: "menu keyword beyond first page", route: "/api/restaurants?q=rare%20capers&pageSize=50", expected: ids.slice(-1) },
      { label: "cuisine", route: "/api/restaurants?cuisine=Synthetic%2019&pageSize=100", expected: ids.filter((_, index) => index % 20 === 19).slice(0, 100) },
      { label: "delivery postcode", route: "/api/restaurants?fulfillment=delivery&postcode=LU1%201AA&pageSize=50", expected: ids.filter((_, index) => index % 2 === 0).slice(0, 50) },
      { label: "popular ranking", route: "/api/restaurants?collection=popular&pageSize=50", expected: ids.filter((_, index) => index % 5 === 4).slice(0, 50) },
      { label: "free delivery", route: "/api/restaurants?collection=free-delivery&fulfillment=delivery&pageSize=50", expected: ids.filter((_, index) => index % 5 === 0).slice(0, 50) },
      { label: "quick ranking", route: "/api/restaurants?collection=quick&fulfillment=delivery&pageSize=50", expected: ids.filter((_, index) => index % 20 === 0).slice(0, 50) }
    ];
    for (const scenario of cases) {
      let latest;
      for (let iteration = 0; iteration < 3; iteration++) {
        const before = baselineDiscover && observedQuery(db, baselineDiscover, scenario.route);
        const after = observedQuery(db, discoverRestaurants, scenario.route); latest = after.result;
        if (before) assert.deepEqual(after.result, before.result, `Behavior changed: ${scenario.label}`);
        assert.deepEqual(after.result.rows.map(row => row.id), scenario.expected, scenario.label);
        queryMeasurements.push({ label: scenario.label, iteration, ...(before ? { before: { ms: before.ms, preparedStatements: before.preparedStatements, executedStatements: before.executedStatements } } : {}), after: { ms: after.ms, preparedStatements: after.preparedStatements, executedStatements: after.executedStatements } });
      }
      assert.ok(latest.rows.length <= Number(new URL(scenario.route, "http://127.0.0.1").searchParams.get("pageSize")));
    }
    closeDatabase(db);
    const allowedEnv = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATHEXT"];
    const env = Object.fromEntries(allowedEnv.filter(key => process.env[key]).map(key => [key, process.env[key]]));
    Object.assign(env, { NODE_ENV: "test", CALAI_RUN_MODE: "local", CALAI_PAYMENT_PROVIDER: "local_simulator" });
    const workerOutput = [];
    child = fork(filename, ["--worker", databasePath], { env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    child.stderr.on("data", chunk => { if (!String(chunk).includes("ExperimentalWarning")) workerOutput.push(String(chunk)); });
    const origin = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Directory HTTP worker startup timed out")), 20000);
      child.on("message", message => { if (message.origin) { clearTimeout(timeout); resolve(message.origin); } });
      child.once("error", reject); child.once("exit", code => { if (code) reject(new Error("Directory HTTP worker exited before startup")); });
    });
    assert.equal(new URL(origin).hostname, "127.0.0.1");
    const request = async (route, label) => {
      const before = performance.now(), response = await fetch(origin + route, { signal: AbortSignal.timeout(20000) }), text = await response.text();
      httpMeasurements.push({ label, ms: performance.now() - before, status: response.status, bytes: Buffer.byteLength(text) });
      assert.equal(response.status, 200, `${label}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    };
    const seen = new Set(); let next = 1;
    // Eight clients walk the entire 10,000-restaurant directory, fifty per page.
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (next <= 200) {
        const page = next++, body = await request(`/api/restaurants?page=${page}&pageSize=50`, "directory page");
        assert.equal(body.data.length, 50); assert.equal(body.pagination.hasNext, page < 200);
        assert.deepEqual(body.data.map(row => row.id), ids.slice((page - 1) * 50, page * 50));
        for (const row of body.data) { assert.ok(!seen.has(row.id), "Duplicate restaurant between pages"); seen.add(row.id); }
      }
    }));
    assert.equal(seen.size, 10000);
    for (const scenario of cases) {
      const body = await request(scenario.route, scenario.label);
      assert.deepEqual(body.data.map(row => row.id), scenario.expected, scenario.label);
    }
    const report = {
      createdAt: started.toISOString(), environment: { node: process.version, platform: process.platform, cpu: os.cpus()[0]?.model, persistence: "One isolated SQLite WAL file on this local machine", apiProcesses: 1, httpClients: 8, outboundProviders: "Disabled; worker receives a minimal environment and no provider keys" },
      dataset, seedMs: Number(seedMs.toFixed(2)), pagesWalked: 200, uniqueRestaurantsSeen: seen.size, baselineLabel,
      directQueryResults: Object.fromEntries(cases.map(scenario => { const rows = queryMeasurements.filter(row => row.label === scenario.label); return [scenario.label, { ...(baselineDiscover ? { before: { latencyMs: stats(rows.map(row => row.before.ms)), preparedStatements: rows[0].before.preparedStatements, executedStatements: rows[0].before.executedStatements } } : {}), after: { latencyMs: stats(rows.map(row => row.after.ms)), preparedStatements: rows[0].after.preparedStatements, executedStatements: rows[0].after.executedStatements } }]; })),
      http: { requests: httpMeasurements.length, errors: httpMeasurements.filter(row => row.status !== 200).length, latencyMs: stats(httpMeasurements.map(row => row.ms)), maximumResponseBytes: Math.max(...httpMeasurements.map(row => row.bytes)) },
      correctness: { stablePageBoundaries: true, allRestaurantIdsUnique: true, filtersBeforePagination: true, ...(baselineDiscover ? { baselineResultsIdentical: true } : {}) }, failures, workerOutput,
      limitations: ["This measures the real 10,000-restaurant directory, not 10,000 simultaneous businesses/customers.", "A short local warm-cache GET exercise, not sustainable production throughput, regional latency or checkout/worker capacity certification.", "No real identities, payments, mail, notifications, printing or provider calls. Historical orders are synthetic browse counters, not financial-ledger fixtures.", "No image bytes are allocated or downloaded: 100MB per business would be 1TB before overhead and backups, and requires separate storage/restore testing.", "Popularity sorting and substring menu search still inspect matching directory/history data before pagination. PostgreSQL/object-storage/multi-node rollout is not validated."]
    };
    await fs.writeFile(path.join(directory, "results.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ results: path.join(directory, "results.json"), dataset, pagesWalked: report.pagesWalked, uniqueRestaurantsSeen: seen.size, http: report.http, correctness: report.correctness }, null, 2));
    return report;
  } catch (error) {
    failures.push(error.message); await fs.writeFile(path.join(directory, "failure.json"), JSON.stringify({ failures }, null, 2)); throw error;
  } finally {
    try { closeDatabase(db); } catch { /* already closed before HTTP exercise */ }
    if (child?.connected) await new Promise(resolve => { const timeout = setTimeout(() => { child.kill(); resolve(); }, 5000); child.once("exit", () => { clearTimeout(timeout); resolve(); }); child.send("stop"); });
  }
}

async function directoryWorker() {
  const [{ createApp }, { loadConfig }, { createServer, closeServer }] = await Promise.all([import("../apps/api/src/app.js"), import("../apps/api/src/config.js"), import("../apps/api/src/server.js")]);
  const db = openDatabase(process.argv[3]);
  const config = loadConfig({ dbPath: process.argv[3], runMode: "local", nodeEnv: "test", paymentProviderMode: "local_simulator", now: () => DIRECTORY_NOW });
  const server = createServer(createApp({ db, config }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  config.port = server.address().port; config.origin = `http://127.0.0.1:${config.port}`; config.expectedHost = `127.0.0.1:${config.port}`;
  process.send?.({ origin: config.origin });
  process.on("message", async message => { if (message !== "stop") return; await closeServer(server); closeDatabase(db); process.disconnect(); });
}
if (process.argv[1] && path.resolve(process.argv[1]) === filename && process.argv[2] === "--worker") await directoryWorker();
