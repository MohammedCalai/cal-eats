// Opt-in isolated HTTP ordering exercise. Never opens the normal application DB.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { openDatabase, migrateDatabase, closeDatabase, withTransaction } from '../apps/api/src/db/index.js';
import { createSession } from '../apps/api/src/auth/sessions.js';
import { seedDirectoryFixture, directoryId, DIRECTORY_NOW } from './load-restaurant-directory.js';

const filename = fileURLToPath(import.meta.url);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const clock = () => new Date(DIRECTORY_NOW);
const allowedEnv = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT'];
const isolatedEnv = () => ({ ...Object.fromEntries(allowedEnv.filter(key => process.env[key]).map(key => [key, process.env[key]])), NODE_ENV: 'test', CALAI_RUN_MODE: 'local', CALAI_PAYMENT_PROVIDER: 'local_simulator' });
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)].toFixed(2)) : null;
};
const stats = values => ({ count: values.length, p50: percentile(values, .5), p95: percentile(values, .95), p99: percentile(values, .99), max: percentile(values, 1) });
const rounded = value => Number(value.toFixed(2));

async function worker() {
  // The child receives only an OS environment whitelist, never .env/provider keys.
  const [{ createApp }, { loadConfig }, { createServer, closeServer }, { runOperationsCycle }, { runMarketplaceWorker }] = await Promise.all([
    import('../apps/api/src/app.js'), import('../apps/api/src/config.js'), import('../apps/api/src/server.js'), import('../apps/api/src/operations.js'), import('../apps/api/src/marketplace.js')
  ]);
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    assert.equal(new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname, '127.0.0.1', 'Synthetic worker blocked outbound provider access');
    return nativeFetch(input, { ...options, redirect: 'error' });
  };
  const databasePath = path.resolve(process.argv[3]);
  assert.equal(path.basename(databasePath), 'synthetic.sqlite');
  assert.ok(path.basename(path.dirname(databasePath)).startsWith('order-capacity-'));
  const db = openDatabase(databasePath);
  const config = loadConfig({ dbPath: databasePath, runMode: 'local', nodeEnv: 'test', paymentProviderMode: 'local_simulator', now: clock, rateLimit: { attempts: 100_000, windowMs: 60_000 } });
  assert.equal(config.paymentProvider, null);
  assert.equal(config.livePaymentsEnabled, false);
  assert.equal(config.businessStatements.sendEnabled, false);
  const server = createServer(createApp({ db, config }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.port = server.address().port; config.origin = `http://127.0.0.1:${config.port}`; config.expectedHost = `127.0.0.1:${config.port}`;
  const workerIntervalMs = Number(process.argv[4]);
  assert.ok([500, 60_000].includes(workerIntervalMs));
  const cycle = () => {
    try {
      const operations = runOperationsCycle(db, config);
      if (operations.errors.length) process.send?.({ workerError: `Local operations: ${operations.errors.join(', ')}` });
      const financial = runMarketplaceWorker(db, config);
      if (financial.failed || financial.retried) process.send?.({ workerError: `Local financial worker: ${JSON.stringify(financial)}` });
      process.send?.({ workerCycle: { pid: process.pid, financial } });
    } catch (error) { process.send?.({ workerError: error.message }); }
  };
  cycle();
  const timer = setInterval(cycle, workerIntervalMs);
  process.send?.({ origin: config.origin, safety: { paymentProvider: 'local_simulator', credentialsInEnvironment: false }, sqlite: db.prepare('SELECT sqlite_version() version').get().version });
  process.on('message', async message => {
    if (message === 'metrics') process.send?.({ processMetrics: { pid: process.pid, cpuUsage: process.cpuUsage(), memory: process.memoryUsage() } });
    if (message !== 'stop') return;
    clearInterval(timer); await closeServer(server); closeDatabase(db); process.disconnect();
  });
}

async function seedActors(db, nativeCustomers) {
  const stamp = clock().toISOString(), config = { now: clock, sessionHours: 24 }, restaurants = [], customers = [];
  // A random, unrecorded password is used only to obtain real native sessions in this isolated fixture.
  const fixturePassword = nativeCustomers ? randomBytes(32).toString('base64url') : null;
  const customerHash = nativeCustomers ? await (await import('../apps/api/src/auth/passwords.js')).hashPassword(fixturePassword) : 'invalid-synthetic-hash';
  const insert = db.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at,email_verified_at) VALUES(?,?,?,?,?,?,?)');
  const cookie = id => `calai_session=${createSession(db, id, config).token}`;
  let adminCookie;
  withTransaction(db, () => {
    insert.run('order-load-admin', 'Synthetic administrator', 'admin@order-load.invalid', 'invalid-synthetic-hash', 'admin', stamp, stamp);
    adminCookie = cookie('order-load-admin');
    for (let i = 0; i < 50; i++) {
      const id = directoryId(i), user = `order-load-owner-${i}`;
      insert.run(user, `Synthetic owner ${i}`, `owner${i}@order-load.invalid`, 'invalid-synthetic-hash', 'restaurant', stamp, stamp);
      db.prepare("UPDATE restaurants SET delivery_outcodes='[\"LU1\"]',delivery_fee_minor=250,min_delivery_subtotal_minor=1000,cash_enabled=1,phone='07000000000',address='Synthetic Luton address' WHERE id=?").run(id);
      db.prepare("INSERT INTO restaurant_memberships(restaurant_id,user_id,created_at,permission) VALUES(?,?,?,'owner')").run(id, user, stamp);
      db.prepare('INSERT INTO contracts VALUES(?,?,?,?,?,?,?,?,?)').run(`order-load-contract-${i}`, id, 700, 24, 'development-load-fixture', 1, null, null, stamp);
      restaurants.push({ id, itemId: `${id}-item-0`, cookie: cookie(user) });
      const customer = `order-load-customer-${i}`;
      const email = `customer${i}@order-load.invalid`;
      insert.run(customer, `Synthetic customer ${i}`, email, customerHash, 'customer', stamp, stamp);
      customers.push({ id: customer, email, ...(nativeCustomers ? {} : { cookie: cookie(customer) }) });
    }
  });
  return { restaurants, customers, adminCookie, fixturePassword };
}

async function run() {
  assert.ok(process.argv.slice(2).every(arg => ['--smoke', '--native-customers'].includes(arg)), 'Only bounded --smoke / --native-customers options are supported');
  const nativeCustomers = process.argv.includes('--native-customers');
  const started = new Date(), directory = path.resolve('artifacts', `order-capacity-${started.toISOString().replaceAll(':', '-')}`);
  await fs.mkdir(directory, { recursive: true });
  const databasePath = path.join(directory, 'synthetic.sqlite');
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const trackedDirtyPaths = execFileSync('git', ['diff', 'HEAD', '--name-only', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  await fs.writeFile(path.join(directory, 'source-state-start.json'), JSON.stringify({ observedAt: new Date().toISOString(), parentCommit: sourceCommit, trackedDirtyPaths, note: 'The parent commit is a reference, not a claim of a clean checkout. Untracked harness/output files are not included in trackedDirtyPaths.' }, null, 2));
  const harnessSha256 = createHash('sha256').update(await fs.readFile(filename)).digest('hex');
  const nativeClientSha256 = nativeCustomers ? createHash('sha256').update(await fs.readFile(new URL('../apps/mobile/src/api.ts', import.meta.url))).digest('hex') : null;
  const initialDb = openDatabase(databasePath); migrateDatabase(initialDb);
  const seedStart = performance.now(), dataset = seedDirectoryFixture(initialDb), actors = await seedActors(initialDb, nativeCustomers), seedMs = performance.now() - seedStart;
  initialDb.exec('ANALYZE'); closeDatabase(initialDb);
  const smoke = process.argv.includes('--smoke'), workerIntervalMs = smoke ? 500 : 60_000, printerEmptyPollMs = 3000;
  const children = [], origins = [], workerErrors = [], processMetrics = [], allMeasurements = [], cases = [], workerCycles = [];
  let nextOrigin = 0, activeMeasurements = null, phase = 'setup', sqliteVersion;
  const nativeClients = new Map(), nativeContext = new AsyncLocalStorage(), originalFetch = globalThis.fetch;
  let nativeTransportRequests = 0;
  if (nativeCustomers) globalThis.fetch = async (input, options) => {
    const context = nativeContext.getStore();
    if (!context) return originalFetch(input, options);
    const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url), headers = new Headers(options?.headers);
    assert.equal(target.hostname, '127.0.0.1'); assert.equal(target.origin, context.origin);
    assert.equal(headers.has('Cookie'), false); assert.equal(headers.get('Accept'), 'application/json');
    assert.equal(headers.get('Authorization'), context.token ? `Bearer ${context.token}` : null);
    assert.equal(headers.get('Origin'), ['POST', 'PUT', 'PATCH', 'DELETE'].includes(options?.method ?? 'GET') ? context.origin : null);
    assert.equal(options?.credentials, 'omit'); assert.equal(options?.redirect, 'error');
    const response = await originalFetch(input, options);
    context.status = response.status; context.bytes = Number(response.headers.get('content-length') ?? 0); nativeTransportRequests++;
    return response;
  };
  const printObserved = new Map(), confirmationStarted = new Map();
  async function request(route, { method = 'GET', body, cookie, token, key, label = route, maxRows, nativeCustomer = false } = {}) {
    assert.ok(route.startsWith('/api/') && !route.startsWith('//'));
    const origin = origins[nextOrigin++ % origins.length]; assert.equal(new URL(origin).hostname, '127.0.0.1');
    const before = performance.now(); let status = 0, errorCode = null, bytes = 0;
    try {
      if (nativeCustomer) {
        assert.ok(nativeCustomers && !cookie, 'Native customer transport cannot use a browser cookie');
        const context = { origin, token, status: 0, bytes: 0 };
        try {
          const result = await nativeContext.run(context, () => nativeClients.get(origin).api(route, { method, ...(token ? { token } : {}), ...(key ? { idempotencyKey: key } : {}), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
          if (maxRows !== undefined) assert.ok(Array.isArray(result) && result.length <= maxRows, `${label} response exceeded its page bound`);
          return result;
        } finally { status = context.status; bytes = context.bytes; }
      }
      const response = await fetch(origin + route, { method, redirect: 'error', signal: AbortSignal.timeout(20_000), headers: {
        ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }), ...(key ? { 'Idempotency-Key': key } : {})
      }, body: body === undefined ? undefined : JSON.stringify(body) });
      status = response.status;
      const text = await response.text(); bytes = Buffer.byteLength(text);
      const result = JSON.parse(text); errorCode = result.error?.code ?? null;
      assert.ok(response.ok, `${label}: HTTP ${status} ${errorCode ?? ''}`);
      if (maxRows !== undefined) assert.ok(Array.isArray(result.data) && result.data.length <= maxRows, `${label} response exceeded its page bound`);
      return result.data;
    } catch (error) { errorCode ??= error.code ?? error.name; throw error; }
    finally {
      const sample = { phase, label, method, ...(nativeCustomer ? { transport: 'actual-mobile-api-client-bearer' } : {}), ms: rounded(performance.now() - before), status, errorCode, bytes };
      allMeasurements.push(sample); activeMeasurements?.push(sample);
    }
  }
  async function stopChildren() {
    await Promise.all(children.map(child => new Promise(resolve => {
      if (!child.connected) return resolve();
      const timeout = setTimeout(() => { child.kill(); resolve(); }, 10_000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); }); child.send('stop');
    })));
  }
  try {
    for (let i = 0; i < 2; i++) {
      const child = fork(filename, ['--worker', databasePath, String(workerIntervalMs)], { env: isolatedEnv(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); children.push(child);
      child.stderr.on('data', chunk => { const value = String(chunk); if (!value.includes('ExperimentalWarning') && !value.includes('--trace-warnings')) workerErrors.push(value.trim()); });
      const origin = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Local order HTTP worker startup timed out')), 20_000);
        child.on('message', message => {
          if (message.origin) { clearTimeout(timeout); sqliteVersion = message.sqlite; resolve(message.origin); }
          if (message.workerError) workerErrors.push(message.workerError);
          if (message.processMetrics) processMetrics.push(message.processMetrics);
          if (message.workerCycle) workerCycles.push({ ...message.workerCycle, observedAt: performance.now() });
        });
        child.once('error', reject); child.once('exit', code => { if (code) reject(new Error(`Local API worker exited ${code}`)); });
      }); origins.push(origin);
    }
    if (nativeCustomers) {
      const previousBase = process.env.EXPO_PUBLIC_API_BASE_URL;
      try {
        for (const origin of origins) {
          process.env.EXPO_PUBLIC_API_BASE_URL = origin;
          nativeClients.set(origin, await import(new URL(`../apps/mobile/src/api.ts?order-capacity=${encodeURIComponent(origin)}`, import.meta.url)));
        }
      } finally { if (previousBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL; else process.env.EXPO_PUBLIC_API_BASE_URL = previousBase; }
      for (const customer of actors.customers) {
        const session = await request('/api/native/auth/login', { method: 'POST', body: { email: customer.email, password: actors.fixturePassword }, nativeCustomer: true, label: 'setup native customer login' });
        customer.token = session.token;
        const me = await request('/api/native/auth/me', { token: customer.token, nativeCustomer: true, label: 'setup native customer identity' });
        assert.equal(me.user.id, customer.id);
      }
      delete actors.fixturePassword;
    }
    for (const restaurant of actors.restaurants) {
      const base = `/api/restaurant/restaurants/${restaurant.id}`;
      await request(`${base}/contract/accept`, { method: 'POST', cookie: restaurant.cookie, body: {}, label: 'setup agreement' });
      await request(`${base}/finance/commission-policy/accept`, { method: 'POST', cookie: restaurant.cookie, body: {}, key: `load-policy-${restaurant.id}`, label: 'setup commission policy' });
      const printer = await request(`${base}/printers`, { method: 'POST', cookie: restaurant.cookie, body: { name: 'Synthetic printer', enabled: true }, label: 'setup printer' });
      const pairing = await request(`${base}/printers/${printer.id}/pairing-code`, { method: 'POST', cookie: restaurant.cookie, body: {}, label: 'setup pairing' });
      const device = await request('/api/devices/pair', { method: 'POST', body: { code: pairing.code, name: 'Synthetic loopback bridge' }, label: 'setup device' });
      restaurant.deviceToken = device.token;
    }
    const plannedOrders = nativeCustomers ? 100 : 300;
    const levels = smoke ? [{ concurrentClients: 2, plannedOrders: 10 }] : [{ concurrentClients: 20, plannedOrders }, { concurrentClients: 50, plannedOrders }];
    for (const level of levels) {
      phase = `clients-${level.concurrentClients}`;
      const samples = [], workflowMs = [], failures = [], orderIds = [], printLatencies = [], settlementBefore = printObserved.size;
      activeMeasurements = samples;
      let next = 0, completedOrders = 0, clientsFinished = false;
      const before = performance.now();
      const cyclesBefore = workerCycles.length;
      // One bridge loop per restaurant, including empty polls. Never impersonate concurrent claims from one bridge.
      const printers = actors.restaurants.map(async restaurant => {
        try {
          let emptyAfterFinish = 0, heartbeatAfter = 0;
          while (!clientsFinished || emptyAfterFinish < 2) {
            if (performance.now() >= heartbeatAfter) {
              await request('/api/devices/heartbeat', { method: 'POST', token: restaurant.deviceToken, body: {}, label: 'printer heartbeat' });
              heartbeatAfter = performance.now() + 30_000;
            }
            const { job } = await request('/api/devices/jobs/claim', { method: 'POST', token: restaurant.deviceToken, body: {}, label: 'printer claim' });
            if (!job) { if (clientsFinished) emptyAfterFinish++; await pause(printerEmptyPollMs); continue; }
            emptyAfterFinish = 0;
            assert.equal(job.receipt.format, 'cal-eats-receipt-v1');
            const id = job.receipt.orderNumber; assert.ok(confirmationStarted.has(id), 'Unexpected non-load print job');
            await request(`/api/devices/jobs/${job.id}/ack`, { method: 'POST', token: restaurant.deviceToken, body: { claimToken: job.claimToken, outcome: 'printed', detail: 'Synthetic simulator acknowledgement; no physical printer' }, label: 'printer acknowledgement' });
            assert.ok(!printObserved.has(id), 'Duplicate original print acknowledgement'); printObserved.set(id, job.id);
            printLatencies.push(performance.now() - confirmationStarted.get(id));
          }
        } catch (error) { failures.push({ scenario: 'printer', restaurant: restaurant.id, message: error.message }); }
      });
      await Promise.all(Array.from({ length: level.concurrentClients }, (_, client) => (async () => {
        while (next < level.plannedOrders) {
          const index = next++, restaurant = actors.restaurants[index % actors.restaurants.length], customer = actors.customers[client], workflowStart = performance.now();
          const customerAccess = nativeCustomers ? { nativeCustomer: true, token: customer.token } : { cookie: customer.cookie };
          try {
            await request(`/api/restaurants?postcode=LU1%201AA&fulfillment=delivery&page=${1 + index % 100}&pageSize=50`, { ...(nativeCustomers ? customerAccess : {}), label: 'browse page (50 maximum)', maxRows: 50 });
            await request(`/api/restaurants/${restaurant.id}/menu`, { ...(nativeCustomers ? customerAccess : {}), label: 'restaurant menu' });
            const delivery = index % 2 === 0, paymentMethod = index % 3 ? 'mock_card' : 'cash';
            const draft = { restaurantId: restaurant.id, items: [{ menuItemId: restaurant.itemId, quantity: 1 }], paymentMethod, fulfillment: delivery ? 'delivery' : 'collection', ...(delivery ? { deliveryAddress: { line1: '1 Synthetic Road', city: 'Luton', postcode: 'LU1 1AA' } } : {}) };
            const quote = await request('/api/orders/quote', { method: 'POST', ...customerAccess, body: { ...draft, autoApplyOffers: true }, label: 'automatic price quote' });
            assert.equal(quote.totalMinor, delivery ? 1250 : 1000); assert.equal(quote.commissionMinor, delivery ? 88 : 70);
            const options = { method: 'POST', ...customerAccess, body: { ...draft, expectedTotalMinor: quote.totalMinor }, key: `order-capacity-${phase}-${index}`, label: 'create order' };
            const [order, replay] = await Promise.all([request('/api/orders', options), request('/api/orders', { ...options, label: 'simultaneous create replay' })]);
            assert.equal(order.id, replay.id, 'Duplicate checkout created different orders'); orderIds.push(order.id);
            confirmationStarted.set(order.id, performance.now());
            const eta = new Date(DIRECTORY_NOW.getTime() + 30 * 60_000).toISOString();
            for (const status of ['accepted', 'preparing', 'ready', ...(delivery ? ['out_for_delivery'] : []), 'completed']) {
              const updated = await request(`/api/restaurant/orders/${order.id}/status`, { method: 'PATCH', cookie: restaurant.cookie, body: { status, ...(status === 'accepted' ? { estimatedReadyAt: eta } : {}) }, label: `owner ${status}` });
              assert.equal(updated.status, status);
              if (status === 'accepted') assert.equal(updated.customerEtaAt, eta);
            }
            const finished = await request(`/api/orders/${order.id}`, { ...customerAccess, label: 'customer order detail' }); assert.equal(finished.status, 'completed');
            await request(`/api/restaurant/restaurants/${restaurant.id}/finance/summary`, { cookie: restaurant.cookie, label: 'owner finance summary' });
            completedOrders++; workflowMs.push(performance.now() - workflowStart);
          } catch (error) { failures.push({ scenario: index, message: error.message }); }
        }
      })()));
      const workflowElapsedMs = performance.now() - before;
      // Observe at least one real production-cadence tick. Do not hide queue capacity with manual drains.
      const observationTarget = before + (smoke ? 0 : workerIntervalMs + 1000);
      while (performance.now() < observationTarget) await pause(Math.min(1000, observationTarget - performance.now()));
      clientsFinished = true; await Promise.all(printers);
      const check = openDatabase(databasePath), prefix = `order-capacity-${phase}-%`;
      const correctness = inspect(check, prefix, level.plannedOrders, printObserved.size - settlementBefore);
      if (nativeCustomers) {
        correctness.nativeCustomerSessions = check.prepare("SELECT COUNT(*) count FROM native_sessions WHERE user_id LIKE 'order-load-customer-%'").get().count;
        correctness.browserCustomerSessions = check.prepare("SELECT COUNT(*) count FROM sessions WHERE user_id LIKE 'order-load-customer-%'").get().count;
        correctness.passed &&= correctness.nativeCustomerSessions === 50 && correctness.browserCustomerSessions === 0;
      }
      closeDatabase(check);
      if (!correctness.passed) failures.push({ scenario: 'database invariants', correctness });
      const labels = [...new Set(samples.map(row => row.label))];
      const result = { ...level, completedOrders, workflowElapsedMs: rounded(workflowElapsedMs), observationWindowMs: rounded(performance.now() - before), completedWorkflowsPerMinute: rounded(completedOrders * 60_000 / workflowElapsedMs), workflowLatencyMs: stats(workflowMs), http: { requests: samples.length, errors: samples.filter(row => row.status >= 400 || row.errorCode).length, latencyMs: stats(samples.map(row => row.ms)), byEndpoint: Object.fromEntries(labels.map(label => { const rows = samples.filter(row => row.label === label); return [label, { ...stats(rows.map(row => row.ms)), errors: rows.filter(row => row.status >= 400 || row.errorCode).length }]; })) }, confirmationToSimulatedPrintAckMs: stats(printLatencies), workerCyclesObserved: workerCycles.slice(cyclesBefore).map(row => ({ ...row, observedAfterStartMs: rounded(row.observedAt - before), observedAt: undefined })), correctness, failures };
      cases.push(result); activeMeasurements = null;
      await fs.writeFile(path.join(directory, `${phase}.json`), JSON.stringify(result, null, 2));
      console.log(JSON.stringify({ phase, completedOrders, plannedOrders: level.plannedOrders, p95Ms: result.http.latencyMs.p95, workflowP95Ms: result.workflowLatencyMs.p95, errors: result.http.errors, correctness: correctness.passed, failures: failures.slice(0, 3) }));
      if (failures.length) break;
    }
    for (const child of children) child.send('metrics'); await pause(100);
    const report = { createdAt: started.toISOString(), sourceCommit, harness: 'scripts/load-order-capacity.js', harnessSha256, smoke, nativeCustomers, nativeTransport: nativeCustomers ? { client: 'apps/mobile/src/api.ts', sha256: nativeClientSha256, requestsIncludingSetup: nativeTransportRequests, sessionIssuance: 'Real native login HTTP endpoint with an ephemeral synthetic password; setup excluded from load timings', assertions: ['Bearer authorization for signed-in customer requests', 'No Cookie header or customer browser sessions', 'Accept application/json', 'Origin for mutations', 'credentials omit', 'redirect error', 'Actual mobile-client 15-second timeout'] } : null, environment: { node: process.version, sqlite: sqliteVersion, platform: process.platform, architecture: process.arch, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryGiB: rounded(os.totalmem() / 1024 ** 3), persistence: 'One isolated SQLite WAL file on the local disk', apiProcesses: 2, localWorkerIntervalMs: workerIntervalMs, jobsPerWorkerCycle: 25, printerEmptyPollMs, printerHeartbeatMs: 30_000, applicationClock: DIRECTORY_NOW.toISOString(), transport: 'Loopback HTTP only', providerCredentials: 'Not inherited; OS environment whitelist only', processMetrics }, dataset: { ...dataset, syntheticAccounts: 102, activeRestaurantsAndSimulatedPrinters: 50, seedMs: rounded(seedMs) }, cases, workerErrors, passed: cases.length === levels.length && cases.every(row => row.correctness.passed && !row.failures.length && !row.http.errors) && !workerErrors.length, queueDrainedWithinObservation: cases.every(row => row.correctness.dueWorkerJobs === 0), limitations: ['A bounded, warm local run with 20/50 virtual workflow clients, not 10,000 simultaneous users or active restaurants.', 'The 10,000 restaurants, 200,000 menu items, 50,000 historical browse orders and 20,000 ratings are synthetic. Historical orders have no financial ledger and are excluded from new-order invariant counts.', 'No real cards, Stripe calls, bank payouts, emails, push delivery, external network, image bytes, physical printers, native UI or password/login throughput tested.', 'Authentication sessions are synthetic and auth limits are raised in isolated children. This does not validate abuse resistance.', 'The application clock is fixed to avoid expiry/week rollover during the exercise. Latencies use monotonic wall time; future weekly payout jobs stay scheduled.', 'The final run uses the current 60-second marketplace/operations cadence with 25 jobs per process; --smoke accelerates it to 500ms. Only these local-safe workers are run, not every main.js maintenance/provider worker.', 'Simulated bridges use the example configuration idle poll (3s) and heartbeat (30s); no hardware execution or physical print time measured.', 'Two API processes share a single local WAL database; no multi-host, failover, backup restoration or sustained production capacity proven.'], rawMeasurements: 'measurements.json' };
    await fs.writeFile(path.join(directory, 'measurements.json'), JSON.stringify(allMeasurements, null, 2));
    await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ results: path.join(directory, 'results.json'), passed: report.passed, cases: cases.length, workerErrors }, null, 2));
    if (!report.passed) process.exitCode = 1;
    return report;
  } catch (error) {
    await fs.writeFile(path.join(directory, 'measurements.json'), JSON.stringify(allMeasurements, null, 2));
    await fs.writeFile(path.join(directory, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, workerErrors }, null, 2)); throw error;
  } finally { globalThis.fetch = originalFetch; await stopChildren(); }
}

function inspect(db, prefix, expected, acknowledgedPrints) {
  const count = (sql, ...args) => db.prepare(sql).get(...args).count;
  const scope = "idempotency_key LIKE ?", orders = db.prepare(`SELECT * FROM orders WHERE ${scope}`).all(prefix);
  const grouped = (table, key = 'status') => db.prepare(`SELECT ${key},COUNT(*) count FROM ${table} GROUP BY ${key}`).all();
  const actualOrders = orders.length, completed = orders.filter(row => row.status === 'completed').length;
  const commissionMismatches = orders.filter(row => row.commission_base !== 'food_plus_delivery' || row.contract_rate_bps !== 700 || row.commission_minor !== Math.round(row.total_minor * .07)).length;
  const missingEnvironment = count(`SELECT COUNT(*) count FROM orders o LEFT JOIN order_financial_environments fe ON fe.order_id=o.id WHERE o.${scope} AND (fe.environment IS NULL OR fe.environment<>'local_simulator')`, prefix);
  const missingSettlement = count(`SELECT COUNT(*) count FROM orders o WHERE o.${scope} AND NOT EXISTS(SELECT 1 FROM marketplace_operations m WHERE m.order_id=o.id AND m.operation_key='order:'||o.id||':settlement-eligible')`, prefix);
  const unbalancedJournalGroups = count("SELECT COUNT(*) count FROM (SELECT group_id FROM journal_postings GROUP BY group_id HAVING SUM(CASE direction WHEN 'debit' THEN amount_minor ELSE -amount_minor END)<>0)");
  const duplicateOperationKeys = count('SELECT COUNT(*) count FROM (SELECT operation_key FROM marketplace_operations GROUP BY operation_key HAVING COUNT(*)>1)');
  const invalidTransitionEventCounts = count(`SELECT COUNT(*) count FROM orders o WHERE o.${scope} AND (SELECT COUNT(*) FROM order_events e WHERE e.order_id=o.id AND e.kind='status_changed')<>CASE o.fulfillment WHEN 'delivery' THEN 6 ELSE 5 END`, prefix);
  const incorrectOriginalPrintCounts = count(`SELECT COUNT(*) count FROM orders o WHERE o.${scope} AND (SELECT COUNT(*) FROM device_print_jobs p WHERE p.order_id=o.id AND p.manual_reprint=0 AND p.status='printed')<>1`, prefix);
  const failedWorkerJobs = count("SELECT COUNT(*) count FROM marketplace_worker_jobs WHERE status='failed'");
  const dueWorkerJobs = count("SELECT COUNT(*) count FROM marketplace_worker_jobs WHERE status IN ('queued','delayed','claimed') AND available_at<=?", clock().toISOString());
  const unexpectedFinancialExceptions = count("SELECT COUNT(*) count FROM marketplace_operations WHERE status IN ('failed','delayed','held') AND NOT(kind='cash_sale_recorded' AND status='held')");
  const foreignKeyErrors = db.prepare('PRAGMA foreign_key_check').all().length;
  const result = { expectedOrders: expected, actualOrders, completed, duplicateAttemptsPerOrder: 2, commissionMismatches, missingEnvironment, missingSettlement, unbalancedJournalGroups, duplicateOperationKeys, invalidTransitionEventCounts, incorrectOriginalPrintCounts, acknowledgedPrints, failedWorkerJobs, dueWorkerJobs, unexpectedFinancialExceptions, foreignKeyErrors, globalQueues: { worker: grouped('marketplace_worker_jobs', "kind||':'||status"), printer: grouped('device_print_jobs'), localNotificationOutbox: grouped('notification_outbox'), localNotifications: count('SELECT COUNT(*) count FROM local_notifications'), payoutSchedules: grouped('payout_batches') } };
  result.passed = actualOrders === expected && completed === expected && acknowledgedPrints === expected && ![commissionMismatches, missingEnvironment, missingSettlement, unbalancedJournalGroups, duplicateOperationKeys, invalidTransitionEventCounts, incorrectOriginalPrintCounts, failedWorkerJobs, unexpectedFinancialExceptions, foreignKeyErrors].some(Boolean);
  return result;
}

if (process.argv[2] === '--worker') await worker(); else await run();
