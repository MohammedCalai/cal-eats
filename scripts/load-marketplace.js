// Isolated, synthetic HTTP load exercise. Never reads the normal application DB.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { openDatabase, migrateDatabase, closeDatabase, withTransaction } from '../apps/api/src/db/index.js';
import { loadConfig } from '../apps/api/src/config.js';
import { createSession } from '../apps/api/src/auth/sessions.js';

const filename = fileURLToPath(import.meta.url);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

if (process.argv[2] === '--worker') {
  const { createApp } = await import('../apps/api/src/app.js');
  const { createServer, closeServer } = await import('../apps/api/src/server.js');
  const { runOperationsCycle } = await import('../apps/api/src/operations.js');
  const { runMarketplaceWorker } = await import('../apps/api/src/marketplace.js');
  const db = openDatabase(process.argv[3]);
  migrateDatabase(db);
  const config = loadConfig({ dbPath: process.argv[3], rateLimit: { attempts: 100_000, windowMs: 60_000 } });
  const server = createServer(createApp({ db, config }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.port = server.address().port;
  config.origin = `http://127.0.0.1:${config.port}`;
  config.expectedHost = `127.0.0.1:${config.port}`;
  const timer = setInterval(() => {
    try { runOperationsCycle(db, config); runMarketplaceWorker(db, config); }
    catch (error) { process.send?.({ workerError: error.message }); }
  }, 500);
  process.send?.({ origin: config.origin });
  process.on('message', async message => {
    if (message !== 'stop') return;
    clearInterval(timer);
    await closeServer(server);
    closeDatabase(db);
    process.disconnect();
  });
} else {
  await run();
}

async function run() {
  const started = new Date();
  const directory = path.resolve('artifacts', `marketplace-load-${started.toISOString().replaceAll(':', '-')}`);
  await fs.mkdir(directory, { recursive: true });
  const databasePath = path.join(directory, 'synthetic.sqlite');
  const db = openDatabase(databasePath);
  migrateDatabase(db);
  const config = loadConfig();
  const fixture = seed(db, config);
  closeDatabase(db);
  const children = [], workerErrors = [], measurements = [], failures = [];
  const origins = [];
  let requestIndex = 0, completedOrders = 0;
  async function request(route, { method = 'GET', body, cookie, token, key, label = route } = {}) {
    const origin = origins[requestIndex++ % origins.length];
    const before = performance.now();
    const response = await fetch(origin + route, {
      method, signal: AbortSignal.timeout(20_000),
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }), ...(key ? { 'Idempotency-Key': key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const result = await response.json();
    measurements.push({ label, ms: performance.now() - before, status: response.status });
    if (!response.ok) throw new Error(`${label}: HTTP ${response.status} ${result.error?.code ?? ''}`);
    return result.data;
  }
  try {
    for (let i = 0; i < 2; i++) {
      const child = fork(filename, ['--worker', databasePath], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      children.push(child);
      child.stderr.on('data', chunk => { if (!String(chunk).includes('ExperimentalWarning') && !String(chunk).includes('--trace-warnings')) workerErrors.push(String(chunk).trim()); });
      const origin = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Load worker startup timed out')), 20_000);
        child.on('message', message => { if (message.origin) { clearTimeout(timeout); resolve(message.origin); } if (message.workerError) workerErrors.push(message.workerError); });
        child.once('error', reject);
        child.once('exit', code => { if (code) reject(new Error(`Load worker exited ${code}`)); });
      });
      origins.push(origin);
    }
    const deviceTokens = [];
    for (const restaurant of fixture.restaurants.slice(0, 20)) {
      const base = `/api/restaurant/restaurants/${restaurant.id}`;
      await request(`${base}/contract/accept`, { method: 'POST', cookie: restaurant.cookie, body: {}, label: 'setup fixture agreement' });
      await request(`${base}/finance/commission-policy/accept`, { method: 'POST', cookie: restaurant.cookie, body: {}, key: `load-policy-${restaurant.id}`, label: 'setup development policy' });
      const printer = await request(`${base}/printers`, { method: 'POST', cookie: restaurant.cookie, body: { name: 'Synthetic printer', enabled: true }, label: 'setup printer' });
      const pair = await request(`${base}/printers/${printer.id}/pairing-code`, { method: 'POST', cookie: restaurant.cookie, body: {}, label: 'setup pairing' });
      const device = await request('/api/devices/pair', { method: 'POST', body: { code: pair.code, name: 'Synthetic bridge' }, label: 'setup device' });
      deviceTokens.push(device.token);
    }
    measurements.length = 0;
    const beginning = performance.now();
    let next = 0;
    const concurrentClients = 20, plannedOrders = 120;
    await Promise.all(Array.from({ length: concurrentClients }, async () => {
      while (next < plannedOrders) {
        const index = next++;
        const restaurant = fixture.restaurants[index % 20];
        const customer = fixture.customers[index % fixture.customers.length];
        try {
          await request('/api/restaurants?postcode=LU1%201AA', { label: 'browse' });
          await request(`/api/restaurants/${restaurant.id}/menu`, { label: 'menu' });
          const delivery = index % 2 === 0;
          const body = { restaurantId: restaurant.id, items: [{ menuItemId: restaurant.itemId, quantity: 1 }], paymentMethod: index % 3 ? 'mock_card' : 'cash', fulfillment: delivery ? 'delivery' : 'collection', ...(delivery ? { deliveryAddress: { line1: '1 Synthetic Road', city: 'Luton', postcode: 'LU1 1AA' } } : {}) };
          const options = { method: 'POST', cookie: customer.cookie, body, key: `load-${index}`, label: 'checkout' };
          const [order, replay] = await Promise.all([request('/api/orders', options), request('/api/orders', { ...options, label: 'checkout replay' })]);
          if (order.id !== replay.id) throw new Error('Duplicate checkout produced different order IDs');
          for (const status of ['accepted', 'preparing', 'ready', ...(delivery ? ['out_for_delivery'] : []), 'completed']) {
            await request(`/api/restaurant/orders/${order.id}/status`, { method: 'PATCH', cookie: restaurant.cookie, body: { status }, label: `order ${status}` });
          }
          await request(`/api/restaurant/restaurants/${restaurant.id}/finance/summary`, { cookie: restaurant.cookie, label: 'finance summary' });
          await request('/api/devices/heartbeat', { method: 'POST', token: deviceTokens[index % 20], body: {}, label: 'printer heartbeat' });
          completedOrders++;
        } catch (error) { failures.push({ scenario: index, message: error.message }); }
      }
    }));
    // One loop per device; concurrent clients must not impersonate one bridge.
    await Promise.all(deviceTokens.map(async token => {
      try {
        for (;;) {
          const { job } = await request('/api/devices/jobs/claim', { method: 'POST', token, body: {}, label: 'printer claim' });
          if (!job) break;
          await request(`/api/devices/jobs/${job.id}/ack`, { method: 'POST', token, body: { claimToken: job.claimToken, outcome: 'printed', detail: 'Synthetic load simulator only; no physical printer' }, label: 'printer acknowledgement' });
        }
      } catch (error) { failures.push({ scenario: 'device', message: error.message }); }
    }));
    await request('/api/admin/finance/workers/run', { method: 'POST', cookie: fixture.adminCookie, body: {}, label: 'financial worker' });
    await pause(600);
    const elapsedMs = performance.now() - beginning;
    const check = openDatabase(databasePath);
    const actualOrders = check.prepare('SELECT COUNT(*) count FROM orders').get().count;
    const unbalancedGroups = check.prepare("SELECT group_id FROM journal_postings GROUP BY group_id HAVING SUM(CASE direction WHEN 'debit' THEN amount_minor ELSE -amount_minor END) <> 0").all().length;
    const duplicateOperations = check.prepare('SELECT operation_key FROM marketplace_operations GROUP BY operation_key HAVING COUNT(*) > 1').all().length;
    const printStates = check.prepare('SELECT status,COUNT(*) count FROM device_print_jobs GROUP BY status').all();
    const queueRows = check.prepare("SELECT (julianday(updated_at)-julianday(created_at))*86400000 ms FROM device_print_jobs WHERE status='printed'").all();
    const unresolved = check.prepare("SELECT COUNT(*) count FROM marketplace_operations WHERE status IN ('failed','delayed','held')").get().count;
    const foreignKeyErrors = check.prepare('PRAGMA foreign_key_check').all().length;
    closeDatabase(check);
    if (actualOrders !== plannedOrders || unbalancedGroups || duplicateOperations || foreignKeyErrors) failures.push({ scenario: 'invariants', actualOrders, plannedOrders, unbalancedGroups, duplicateOperations, foreignKeyErrors });
    const labels = [...new Set(measurements.map(row => row.label))];
    const report = {
      timestamp: started.toISOString(), environment: { node: process.version, platform: process.platform, architecture: process.arch, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryGiB: Math.round(os.totalmem() / 1024 ** 3), persistence: 'SQLite WAL on one local disk', apiProcesses: 2, workerProcesses: 2 },
      dataset: { accounts: 10_001, customers: 9_900, restaurantAccounts: 100, admins: 1, restaurants: 100, menuItems: 2_000, activeDevices: 20, historicalOrdersBeforeRun: 0 },
      workload: { concurrentClients, plannedOrders, completedOrders, elapsedMs: Math.round(elapsedMs), ordersPerMinute: Number((completedOrders * 60_000 / elapsedMs).toFixed(2)), httpRequests: measurements.length, httpErrors: measurements.filter(row => row.status >= 400).length },
      latencyMs: Object.fromEntries(labels.map(label => [label, stats(measurements.filter(row => row.label === label).map(row => row.ms))])),
      printCompletionDelayMs: stats(queueRows.map(row => row.ms)), printStates,
      correctness: { actualOrders, unbalancedGroups, duplicateOperations, foreignKeyErrors, financialExceptions: unresolved }, failures, workerErrors,
      limitations: ['Synthetic short local run; not 10,000 concurrent users or a production capacity guarantee.', 'No remote network, real provider, physical printer, login/password throughput, multi-node database, or long order history exercised.', 'Printer jobs are drained after the order burst, so print delay includes intentional harness queueing.', 'Authentication rate limit is raised only in these isolated worker processes; this is not an abuse-resistance test.', 'One host with shared local WAL only. Do not use a network filesystem.']
    };
    await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ results: path.join(directory, 'results.json'), ...report.workload, correctness: report.correctness, failureCount: failures.length, failures: failures.slice(0, 5), workerErrors: workerErrors.slice(0, 5) }, null, 2));
    if (failures.length || workerErrors.length) process.exitCode = 1;
  } finally {
    await Promise.all(children.map(child => new Promise(resolve => {
      if (!child.connected) return resolve();
      const timeout = setTimeout(() => { child.kill(); resolve(); }, 10_000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
      child.send('stop');
    })));
  }
}

function stats(values) {
  if (!values.length) return { count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = p => Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)].toFixed(2));
  return { count: values.length, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: Number(sorted.at(-1).toFixed(2)) };
}

function seed(db, config) {
  const now = config.now().toISOString(), restaurants = [], customers = [];
  const cookie = id => `calai_session=${createSession(db, id, config).token}`;
  const insertUser = db.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)');
  let adminCookie;
  withTransaction(db, () => {
    const adminId = randomUUID();
    // Invalid password hash makes these synthetic fixtures impossible to log in to.
    insertUser.run(adminId, 'Load admin', 'admin@load.invalid', 'invalid-load-fixture', 'admin', now);
    adminCookie = cookie(adminId);
    for (let i = 0; i < 100; i++) {
      const userId = randomUUID(), id = randomUUID();
      insertUser.run(userId, `Load owner ${i}`, `owner${i}@load.invalid`, 'invalid-load-fixture', 'restaurant', now);
      db.prepare("INSERT INTO restaurants(id,name,status,created_at,delivery_enabled,delivery_outcodes,delivery_fee_minor,min_delivery_subtotal_minor,always_open,phone,address,cuisine) VALUES(?,?,'approved',?,1,?,250,1000,1,'07000000000','Synthetic Luton address','Synthetic')").run(id, `Load restaurant ${i}`, now, JSON.stringify(['LU1', 'LU2']));
      db.prepare("INSERT INTO restaurant_memberships(restaurant_id,user_id,created_at,permission) VALUES(?,?,?,'owner')").run(id, userId, now);
      db.prepare('INSERT INTO contracts VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), id, 700, 24, 'demo-v1', 1, null, null, now);
      let itemId;
      for (let j = 0; j < 20; j++) {
        const item = randomUUID();
        db.prepare("INSERT INTO menu_items(id,restaurant_id,name,description,price_minor,available,created_at,updated_at,category) VALUES(?,?,?,?,?,1,?,?,?)").run(item, id, `Synthetic dish ${j}`, 'Load fixture only; no dietary claims', 1200 + j * 25, now, now, j < 10 ? 'Mains' : 'Sides');
        itemId ??= item;
      }
      restaurants.push({ id, itemId, cookie: cookie(userId) });
    }
    for (let i = 0; i < 9_900; i++) {
      const id = randomUUID();
      insertUser.run(id, `Load customer ${i}`, `customer${i}@load.invalid`, 'invalid-load-fixture', 'customer', now);
      if (i < 120) customers.push({ id, cookie: cookie(id) });
    }
  });
  return { restaurants, customers, adminCookie };
}
