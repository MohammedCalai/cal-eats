import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createApp } from "../apps/api/src/app.js";
import { loadConfig } from "../apps/api/src/config.js";
import { createSession, SESSION_COOKIE, tokenHash } from "../apps/api/src/auth/sessions.js";
import { hashPassword } from "../apps/api/src/auth/passwords.js";
import { closeDatabase, migrateDatabase, openDatabase } from "../apps/api/src/db/index.js";
import { seedDemoData } from "../apps/api/src/seed.js";
import { DEMO_CATALOG, DEMO_CUSTOMERS } from "./lib/demo-catalog.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS = path.join(ROOT, "artifacts");
const DATASET = "cal-eats-business-phone-demo-v1";
const LOCAL_PASSWORD = "DemoCustomer!4310";
const HOST = "https://eats.calai.info";
const DAY = 86400_000;
const fixtureId = key => { const hex = createHash("sha256").update(`${DATASET}:${key}`).digest("hex"); return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`; };
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const iso = value => new Date(value).toISOString();
const args = process.argv.slice(2);
const valueArg = name => { const at = args.indexOf(name); if (at < 0) return undefined; assert(args[at + 1] && !args[at + 1].startsWith("--"), `${name} needs a value`); return args[at + 1]; };

function saveManifest(filename, manifest) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temp = `${filename}.pending`;
  fs.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, filename);
}

function loadManifest(filename, mode, dbPath) {
  if (fs.existsSync(filename)) {
    const result = JSON.parse(fs.readFileSync(filename, "utf8"));
    assert(result.dataset === DATASET && result.mode === mode && (!dbPath || result.dbPath === dbPath), "Manifest is not owned by this demo dataset");
    return result;
  }
  assert(!dbPath || !fs.existsSync(dbPath), "Refusing an existing database without this dataset's managed manifest; use a NEW file under artifacts");
  const now = valueArg("--now") ?? new Date().toISOString(); assert(Number.isFinite(Date.parse(now)), "Invalid fixture timestamp");
  const manifest = { dataset: DATASET, mode, ...(dbPath ? { dbPath } : { origin: HOST }), asOf: iso(now), createdAt: new Date().toISOString(), restaurants: {}, customers: {}, orders: {}, offers: {}, workflows: {}, conversations: {}, cases: {}, support: {}, activeOrders: {}, warnings: [] };
  saveManifest(filename, manifest); return manifest;
}

function localDatabasePath() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const target = path.resolve(valueArg("--db") ?? path.join(ARTIFACTS, "business-phone-demo.sqlite"));
  assert(target.toLowerCase().startsWith(`${path.resolve(ARTIFACTS).toLowerCase()}${path.sep}`) && target.endsWith(".sqlite"), "Demo databases must be NEW .sqlite files within this project's artifacts directory");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const realParent = fs.realpathSync(path.dirname(target)).toLowerCase(), realArtifacts = fs.realpathSync(ARTIFACTS).toLowerCase();
  assert(realParent === realArtifacts || realParent.startsWith(`${realArtifacts}${path.sep}`), "Demo parent must stay inside artifacts");
  assert(!fs.existsSync(target) || !fs.lstatSync(target).isSymbolicLink(), "A linked database cannot be seeded");
  return target;
}

function localHarness(db, config) {
  const app = createApp({ db, config }), sessions = new Map();
  async function request(userId, route, { method = "GET", body, key } = {}) {
    if (userId && !sessions.has(userId)) sessions.set(userId, createSession(db, userId, config).token);
    const input = body === undefined ? "" : JSON.stringify(body), headers = { host: config.expectedHost, origin: config.origin, ...(userId ? { cookie: `${SESSION_COOKIE}=${sessions.get(userId)}` } : {}), ...(input ? { "content-type": "application/json" } : {}), ...(key ? { "idempotency-key": key } : {}) };
    const req = Readable.from(input ? [Buffer.from(input)] : []); Object.assign(req, { method, url: route, headers, socket: { remoteAddress: "127.0.0.1" } });
    const result = await new Promise(resolve => {
      const chunks = [], res = { headersSent: false, writableEnded: false, statusCode: 200, setHeader() {}, writeHead(status) { this.statusCode = status; this.headersSent = true; }, end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); this.writableEnded = true; resolve({ status: this.statusCode, text: Buffer.concat(chunks).toString("utf8") }); }, destroy() { resolve({ status: 500, text: "{}" }); } };
      app(req, res);
    });
    let parsed; try { parsed = JSON.parse(result.text); } catch { throw new Error(`Demo API ${method} ${route} returned an invalid response`); }
    assert(result.status >= 200 && result.status < 300, `Demo API ${method} ${route}: ${result.status} ${parsed.error?.code ?? "FAILED"}: ${parsed.error?.message ?? "request failed"}`);
    return parsed.data;
  }
  return { request, close() { for (const token of sessions.values()) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash(token)); sessions.clear(); } };
}

async function ensureRestaurant(api, owner, admin, catalog, existing, commit, prefix = "") {
  let state = existing;
  if (!state) {
    const owned = await api(owner, "/api/restaurant/restaurants");
    assert(!owned.some(row => row.name === catalog.name), `Unmanaged demo name collision: ${catalog.name}`);
    const created = await api(owner, "/api/restaurant/restaurants", { method: "POST", body: { name: catalog.name } });
    state = { id: created.id, menu: {}, steps: {} }; commit(state);
  }
  if (state.ready) return state;
  if (!state.steps.profile) { await api(owner, `/api/restaurant/restaurants/${state.id}/profile`, { method: "PATCH", body: { description: `${catalog.description} Dataset ${DATASET}.`, cuisine: catalog.cuisine, phone: "01632 960101", address: "Demo Market, Fictional Luton, LU1 2AB", collectionEnabled: true, cashEnabled: true, alwaysOpen: true, estimatedDeliveryMinutes: 25 + DEMO_CATALOG.indexOf(catalog) % 4 * 5, estimatedCollectionMinutes: 15 } }); state.steps.profile = true; commit(state); }
  if (!state.steps.delivery) { await api(owner, `/api/restaurant/restaurants/${state.id}/delivery`, { method: "PATCH", body: { enabled: true, outcodes: ["LU1","LU2"], deliveryFeeMinor: 199, minDeliverySubtotalMinor: 500 } }); state.steps.delivery = true; commit(state); }
  for (let index = 0; index < catalog.dishes.length; index++) {
    if (state.menu[index]) continue;
    const item = await api(owner, `/api/restaurant/restaurants/${state.id}/menu`, { method: "POST", body: catalog.dishes[index] }); state.menu[index] = item.id; commit(state);
  }
  if (!state.steps.contract) { await api(owner, `/api/restaurant/restaurants/${state.id}/contract/accept`, { method: "POST", body: {} }); state.steps.contract = true; commit(state); }
  if (!state.steps.approval) { await api(admin, `/api/admin/restaurants/${state.id}/approval`, { method: "PATCH", body: { status: "approved" } }); state.steps.approval = true; commit(state); }
  state.ready = true; commit(state); return state;
}

async function completeOrder(api, owner, customer, restaurantId, itemId, key, { delivery = false, target = "completed" } = {}) {
  const body = { restaurantId, items: [{ menuItemId: itemId, quantity: 1 }], paymentMethod: "mock_card", fulfillment: delivery ? "delivery" : "collection", ...(delivery ? { deliveryAddress: { line1: "10 Demo Street", city: "Fictional Luton", postcode: "LU1 2AB" }, deliveryInstructions: "Fictional demo delivery — no real delivery." } : {}) };
  let order = await api(customer, "/api/orders", { method: "POST", key, body });
  const path = delivery ? ["placed","accepted","preparing","ready","out_for_delivery","completed"] : ["placed","accepted","preparing","ready","completed"];
  if (!path.includes(order.status) || path.indexOf(order.status) >= path.indexOf(target)) return order;
  for (const status of path.slice(path.indexOf(order.status) + 1, path.indexOf(target) + 1)) order = await api(owner, `/api/restaurant/orders/${order.id}/status`, { method: "PATCH", body: { status } });
  return order;
}

async function seedLocal() {
  assert(!process.env.CALAI_RUN_MODE || process.env.CALAI_RUN_MODE === "local", "Local demo seeding refuses hosted runtime settings");
  assert(!process.env.CALAI_PAYMENT_PROVIDER || process.env.CALAI_PAYMENT_PROVIDER === "local_simulator", "Demo seeding requires local_simulator");
  assert(process.env.CALAI_LIVE_PAYMENTS_ENABLED !== "true", "Demo seeding refuses live payments");
  const dbPath = localDatabasePath(), manifestPath = `${dbPath}.demo.json`, manifest = loadManifest(manifestPath, "local", dbPath), db = openDatabase(dbPath), asOf = Date.parse(manifest.asOf);
  let clock = asOf - 120 * DAY, harness;
  const save = () => saveManifest(manifestPath, manifest);
  const setClock = value => { clock = Number(value); };
  try {
    migrateDatabase(db); await seedDemoData(db, new Date(clock));
    const config = loadConfig({ runMode: "local", nodeEnv: "development", hostname: "127.0.0.1", origin: "http://127.0.0.1:4314", port: 4314, dbPath, paymentProviderMode: "local_simulator", livePaymentsEnabled: false, sessionHours: 24 * 365, now: () => new Date(clock) });
    assert(config.runMode === "local" && config.paymentProviderMode === "local_simulator", "Fixture configuration is unsafe");
    harness = localHarness(db, config); const api = harness.request;
    const owner = db.prepare("SELECT id FROM users WHERE email='restaurant@calai.local'").get().id, admin = db.prepare("SELECT id FROM users WHERE email='admin@calai.local'").get().id, primary = db.prepare("SELECT id FROM users WHERE email='customer@calai.local'").get().id;
    const kitchen = db.prepare("SELECT r.id FROM restaurants r JOIN restaurant_memberships m ON m.restaurant_id=r.id WHERE m.user_id=? AND r.name='Calai Kitchen'").get(owner) ?? (manifest.kitchenId ? { id: manifest.kitchenId } : null);
    assert(kitchen, "Base Calai Kitchen fixture is missing; refusing to guess an existing restaurant"); manifest.kitchenId = kitchen.id;
    const kitchenMenu = (await api(owner, `/api/restaurant/restaurants/${kitchen.id}/menu`)).items, kitchenMain = kitchenMenu.find(item => item.priceMinor >= 1000)?.id ?? kitchenMenu[0]?.id;
    assert(kitchenMain, "Base kitchen needs an available menu item");
    for (const catalog of DEMO_CATALOG) manifest.restaurants[catalog.key] = await ensureRestaurant(api, owner, admin, catalog, manifest.restaurants[catalog.key], state => { manifest.restaurants[catalog.key] = state; save(); });
    console.log("Prepared 20 fictional cuisine restaurants and 80 menu items.");
    const sharedHash = await hashPassword(LOCAL_PASSWORD);
    for (const customer of DEMO_CUSTOMERS) {
      if (!manifest.customers[customer.key]) {
        const id = fixtureId(customer.key), found = db.prepare("SELECT id,email FROM users WHERE id=? OR email=?").get(id, customer.email);
        assert(!found || (found.id === id && found.email === customer.email), `Unmanaged fixture customer collision: ${customer.key}`);
        if (!found) db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?, 'customer',?)").run(id, customer.name, customer.email, sharedHash, iso(asOf - 120 * DAY));
        manifest.customers[customer.key] = { id, email: customer.email }; save();
      }
      const state = manifest.customers[customer.key];
      if (!state.preferences) { await api(state.id, "/api/account/marketing-preferences", { method: "PATCH", body: { inAppPromotions: customer.marketing, pushPromotions: false, source: "fictional-demo-fixture" } }); state.preferences = true; save(); }
    }
    if (!manifest.primaryPreferences) { await api(primary, "/api/account/marketing-preferences", { method: "PATCH", body: { inAppPromotions: true, pushPromotions: false, source: "fictional-demo-fixture" } }); manifest.primaryPreferences = true; save(); }
    for (let i = 0; i < DEMO_CUSTOMERS.length; i++) {
      const customer = DEMO_CUSTOMERS[i], user = manifest.customers[customer.key].id, number = customer.group === "regular" ? 5 : customer.group === "returning" ? 2 : 1;
      for (let j = 0; j < number; j++) {
        const fixtureKey = `${customer.key}:kitchen:${j}`, daysAgo = customer.group === "lapsed" ? 70 + i % 15 : customer.group === "regular" ? 3 + j * 6 : 2 + j * 12;
        if (!manifest.orders[fixtureKey]) { setClock(asOf - daysAgo * DAY + i * 1000); const order = await completeOrder(api, owner, user, kitchen.id, kitchenMain, `${DATASET}:${fixtureKey}`, { delivery: i % 9 === 0 }); manifest.orders[fixtureKey] = order.id; save(); }
      }
      const catalog = DEMO_CATALOG[i % DEMO_CATALOG.length], restaurant = manifest.restaurants[catalog.key], fixtureKey = `${customer.key}:cuisine`;
      if (!manifest.orders[fixtureKey]) { setClock(asOf - (4 + i % 21) * DAY); const order = await completeOrder(api, owner, user, restaurant.id, restaurant.menu[0], `${DATASET}:${fixtureKey}`); manifest.orders[fixtureKey] = order.id; save(); }
      if (i % 20 === 19) console.log(`Prepared history for ${i + 1}/80 fictional customers.`);
    }
    for (const catalog of DEMO_CATALOG) {
      const state = manifest.restaurants[catalog.key], key = `primary:${catalog.key}`;
      if (!manifest.orders[key]) { setClock(asOf - 2 * DAY); const order = await completeOrder(api, owner, primary, state.id, state.menu[0], `${DATASET}:${key}`); manifest.orders[key] = order.id; save(); }
    }
    if (!manifest.orders["primary:kitchen"]) { setClock(asOf - DAY); const order = await completeOrder(api, owner, primary, kitchen.id, kitchenMain, `${DATASET}:primary:kitchen`); manifest.orders["primary:kitchen"] = order.id; save(); }
    setClock(asOf);
    if (!manifest.historyRead) { db.prepare("UPDATE user_notifications SET read_at=? WHERE read_at IS NULL").run(iso(asOf)); manifest.historyRead = true; save(); }
    for (const customer of DEMO_CUSTOMERS) {
      if (manifest.workflows[customer.key]) continue;
      await api(owner, `/api/restaurant/restaurants/${kitchen.id}/customers/${manifest.customers[customer.key].id}/profile`, { method: "PATCH", body: { workflowStatus: customer.workflowStatus, note: `Fictional demo profile: ${customer.group} customer. No real customer data.` } }); manifest.workflows[customer.key] = true; save();
    }
    for (let i = 0; i < DEMO_CATALOG.length; i++) {
      const catalog = DEMO_CATALOG[i], restaurant = manifest.restaurants[catalog.key]; if (manifest.offers[catalog.key]) continue;
      const recipients = [primary, ...DEMO_CUSTOMERS.filter((c,index) => index % 20 === i && c.marketing).map(c => manifest.customers[c.key].id)], offerType = ["free_item","percent_off","fixed_off"][i % 3];
      const offer = await api(owner, `/api/restaurant/restaurants/${restaurant.id}/loyalty/promotions`, { method: "POST", key: `${DATASET}:offer:${catalog.key}`, body: { title: offerType === "free_item" ? `Demo: free ${catalog.dishes[2].name.toLowerCase()}` : offerType === "percent_off" ? "Demo: 15% off your next order" : "Demo: £3 off your next order", message: `A fictional ${catalog.cuisine.toLowerCase()} offer to try the Cal-Eats customer experience. Restaurant-funded test offer.`, offerType, value: offerType === "percent_off" ? 1500 : offerType === "fixed_off" ? 300 : 0, menuItemId: offerType === "free_item" ? restaurant.menu[2] : null, minSubtotalMinor: 500, startsAt: iso(asOf - DAY), expiresAt: iso(asOf + 30 * DAY), redemptionLimit: 500, budgetMinor: null, eligibleItemIds: [], eligibleCategories: [], recipientSegment: "selected", customerIds: recipients, stackingPolicy: "exclusive", fundingParty: "restaurant" } });
      manifest.offers[catalog.key] = offer.id; save();
    }
    const conversationCustomers = [{ key: "primary", id: primary }, ...DEMO_CUSTOMERS.slice(0,8).map(c => ({ key: c.key, id: manifest.customers[c.key].id }))];
    for (let i = 0; i < conversationCustomers.length; i++) {
      const customer = conversationCustomers[i]; if (manifest.conversations[customer.key]) continue;
      const route = `/api/restaurant/restaurants/${kitchen.id}/customers/${customer.id}/conversation`, first = await api(owner, route, { method: "POST", key: `${DATASET}:chat:${customer.key}:owner`, body: { message: "Demo conversation: hello from Calai Kitchen. We can help with your recent order here." } });
      if (i % 2 === 0) await api(customer.id, `/api/customer/conversations/${first.threadId}/messages`, { method: "POST", key: `${DATASET}:chat:${customer.key}:customer`, body: { message: "Demo reply: thank you. Please check my delivery note for next time." } });
      if (i === 3) await api(owner, route, { method: "PATCH", body: { status: "resolved" } });
      if (i === 4) await api(customer.id, `/api/customer/conversations/${first.threadId}/read`, { method: "POST", body: { lastMessageId: first.id } });
      manifest.conversations[customer.key] = first.threadId; save();
    }
    for (let i = 0; i < 4; i++) {
      const customer = DEMO_CUSTOMERS[i], user = manifest.customers[customer.key].id, key = `case-${i}`, orderId = manifest.orders[`${customer.key}:kitchen:0`];
      if (manifest.cases[key]?.complete) continue;
      let state = manifest.cases[key];
      if (!state) { const created = await api(user, "/api/refund-cases", { method: "POST", body: { orderId, reason: ["missing_items","quality","incorrect_items","missing_items"][i], itemIds: [], description: `Fictional demo refund case ${i + 1}. Please use this to explore restaurant-first remedies.` } }); state = { id: created.id, steps: {} }; manifest.cases[key] = state; save(); }
      if ([1,3].includes(i) && !state.proposal) { const proposal = await api(owner, `/api/restaurant/restaurants/${kitchen.id}/refund-cases/${state.id}/proposals`, { method: "POST", key: `${DATASET}:${key}:proposal`, body: { type: i === 1 ? "voucher" : "replacement", ...(i === 1 ? { voucherValueMinor: 500, expiresAt: iso(asOf + 14 * DAY), redemptionConditions: "Demo only: £5 toward a future Calai Kitchen order." } : {}), itemIds: [], description: i === 1 ? "Demo restaurant-funded £5 voucher" : "Demo replacement meal prepared for collection" } }); state.proposal = proposal.id; save(); }
      if (i === 2 && !state.steps.escalated) { await api(admin, `/api/admin/refund-cases/${state.id}/escalate`, { method: "POST", body: { reason: "Fictional demo escalation for platform review." } }); state.steps.escalated = true; save(); }
      if (i === 3) {
        if (!state.steps.accepted) { await api(user, `/api/refund-cases/${state.id}/proposals/${state.proposal}/respond`, { method: "POST", key: `${DATASET}:${key}:accept`, body: { decision: "accept" } }); state.steps.accepted = true; save(); }
        if (!state.steps.fulfilled) { await api(owner, `/api/restaurant/restaurants/${kitchen.id}/refund-cases/${state.id}/proposals/${state.proposal}/fulfil`, { method: "POST", key: `${DATASET}:${key}:fulfil`, body: { evidence: "Demo replacement collected at the fictional restaurant." } }); state.steps.fulfilled = true; save(); }
        if (!state.steps.confirmed) { await api(user, `/api/refund-cases/${state.id}/proposals/${state.proposal}/confirm-fulfilment`, { method: "POST", key: `${DATASET}:${key}:confirm`, body: {} }); state.steps.confirmed = true; save(); }
      }
      state.complete = true; save();
    }
    for (let i = 0; i < 4; i++) {
      const key = `support-${i}`, customer = DEMO_CUSTOMERS[i + 4], user = i === 3 ? primary : manifest.customers[customer.key].id;
      if (manifest.support[key]?.complete) continue; let state = manifest.support[key];
      if (!state) { const created = await api(user, "/api/support", { method: "POST", key: `${DATASET}:${key}:create`, body: { subject: ["Demo delivery-note question","Demo collection help","Demo receipt query","Demo customer-app help"][i], message: "This is a fictional help request. It should appear in the right support inbox and show a clear receipt.", ...(i === 3 ? {} : { orderId: manifest.orders[`${customer.key}:kitchen:0`] }) } }); state = { id: created.id, steps: {} }; manifest.support[key] = state; save(); }
      if (i === 1 && !state.steps.reply) { await api(owner, `/api/support/${state.id}/messages`, { method: "POST", key: `${DATASET}:${key}:reply`, body: { message: "Demo reply: your collection note has been received. Is there anything else we can help with?" } }); state.steps.reply = true; save(); }
      if (i === 2 && !state.steps.resolved) { await api(admin, `/api/support/${state.id}`, { method: "PATCH", body: { status: "resolved" } }); state.steps.resolved = true; save(); }
      state.complete = true; save();
    }
    for (let i = 0; i < 3; i++) {
      const key = `active-${i}`; if (manifest.activeOrders[key]) continue; const user = i === 0 ? primary : manifest.customers[DEMO_CUSTOMERS[i].key].id;
      const order = await completeOrder(api, owner, user, kitchen.id, kitchenMain, `${DATASET}:${key}`, { delivery: i === 0, target: ["out_for_delivery","preparing","placed"][i] });
      if (i < 2) await api(user, `/api/orders/${order.id}/messages`, { method: "POST", key: `${DATASET}:${key}:message`, body: { message: "Demo order message: please ring the bell on arrival." } });
      manifest.activeOrders[key] = order.id; save();
    }
    const integrity = db.prepare("PRAGMA integrity_check").get(), foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
    assert(Object.values(integrity)[0] === "ok" && foreignKeys.length === 0, "Demo database integrity failed");
    const unbalanced = db.prepare("SELECT operation_key FROM journal_postings GROUP BY operation_key HAVING SUM(CASE WHEN direction='debit' THEN amount_minor ELSE -amount_minor END)<>0").all();
    assert(unbalanced.length === 0, "Demo financial journal does not balance");
    assert(db.prepare("SELECT COUNT(*) n FROM orders WHERE payment_method='card'").get().n === 0, "A real-provider card order entered the simulator fixture");
    const summary = { mode: "local", dbPath, manifestPath, restaurantsAdded: Object.keys(manifest.restaurants).length, cuisineCount: new Set(DEMO_CATALOG.map(r => r.cuisine)).size, menuItemsAdded: Object.values(manifest.restaurants).reduce((sum,r) => sum + Object.keys(r.menu).length,0), fictionalCustomersAdded: Object.keys(manifest.customers).length, orders: db.prepare("SELECT COUNT(*) n FROM orders").get().n, offers: db.prepare("SELECT COUNT(*) n FROM offer_campaigns").get().n, conversations: db.prepare("SELECT COUNT(*) n FROM restaurant_customer_threads").get().n, refundCases: db.prepare("SELECT COUNT(*) n FROM refund_cases").get().n, supportCases: db.prepare("SELECT COUNT(*) n FROM support_cases").get().n, integrity: "ok", foreignKeyViolations: 0, schemaVersion: db.prepare("SELECT MAX(version) n FROM schema_migrations").get().n, simulatedOnly: true };
    summary.unbalancedJournalGroups = unbalanced.length; summary.journalPostings = db.prepare("SELECT COUNT(*) n FROM journal_postings").get().n;
    manifest.summary = summary; manifest.complete = true; save(); console.log(JSON.stringify(summary, null, 2));
  } finally { harness?.close(); closeDatabase(db); }
}

function hostedPlan() {
  console.log(JSON.stringify({ mode: "hosted-plan", origin: HOST, mutationsPerformed: false, deploymentRequired: false, restaurantsToAdd: DEMO_CATALOG.map(r => ({ name: r.name, cuisine: r.cuisine, dishes: r.dishes.length })), maximumFictionalCustomers: 4, personalisedFreeItemOffers: 20, fulfillment: ["delivery LU1/LU2","collection"], paymentMethod: "mock_card only", existingPreviewKitchen: "Only additive fictional customer history if already approved; otherwise history uses first new Demo restaurant. No existing approval/profile/menu changes", requiresRuntime: { mode: "hosted-preview", paymentProviderMode: "local_simulator" }, newerWorkflowFixtures: "Local only until reviewed app update is deployed", credentials: "Read privately from ignored artifacts/preview-admin-access.txt; new fictional credentials persisted only in ignored hosted manifest", applyCommand: "node scripts/seed-marketplace-demo.js --hosted-apply --confirm-hosted-demo-only" }, null, 2));
}

async function seedHosted() {
  assert(args.includes("--confirm-hosted-demo-only"), "Hosted demo apply needs --confirm-hosted-demo-only; use --hosted-plan first");
  assert(!valueArg("--origin") || valueArg("--origin") === HOST, "Hosted demo seeding is restricted to the existing Cal-Eats preview");
  const manifestPath = path.join(ARTIFACTS, "hosted-marketplace-demo.private.json"), manifest = loadManifest(manifestPath, "hosted-preview");
  assert(manifest.origin === HOST, "Hosted manifest origin is invalid"); const save = () => saveManifest(manifestPath, manifest), cookies = new Map();
  async function request(identity, route, { method = "GET", body, key, allowStatus = [] } = {}) {
    assert(route.startsWith("/api/") && !route.startsWith("//"), "Only reviewed Cal-Eats API routes are allowed");
    const url = new URL(route, HOST); assert(url.origin === HOST, "Cross-origin demo requests are forbidden");
    const result = await fetch(url, { method, redirect: "error", signal: AbortSignal.timeout(20000), headers: { Origin: HOST, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookies.has(identity) ? { Cookie: cookies.get(identity) } : {}), ...(key ? { "Idempotency-Key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const cookie = result.headers.get("set-cookie"); if (cookie && identity) cookies.set(identity, cookie.split(";",1)[0]);
    const response = await result.json(); if (allowStatus.includes(result.status)) return { status: result.status, data: response.data };
    assert(result.ok, `Hosted demo ${method} ${route}: ${result.status} ${response.error?.code ?? "FAILED"}`); return response.data;
  }
  const runtime = await request(null, "/api/runtime");
  assert(runtime.mode === "hosted-preview" && runtime.simulatedPayments === true && (!runtime.paymentProviderMode || runtime.paymentProviderMode === "local_simulator"), "Hosted preview does not identify a simulated preview. No sign-in or data mutation was attempted");
  const lines = fs.readFileSync(path.join(ARTIFACTS, "preview-admin-access.txt"), "utf8").split(/\r?\n/);
  const credentials = email => { const at = lines.findIndex(line => /^Email:/i.test(line) && line.includes(email)); assert(at >= 0, "Approved preview credential entry is missing"); const password = lines.slice(at + 1, at + 3).find(line => /^Password:/i.test(line))?.replace(/^Password:\s*/i, ""); assert(password, "Approved preview credential is incomplete"); return { email, password }; };
  await request("admin", "/api/auth/login", { method: "POST", body: credentials("mohammed.sabbir1707@gmail.com") });
  try {
  const settings = await request("admin", "/api/admin/operational-settings");
  if (settings.runMode !== "hosted-preview" || settings.paymentProviderMode !== "local_simulator") {
    await request("admin", "/api/auth/logout", { method: "POST", body: {} }).catch(() => {});
    throw new Error("The authenticated settings do not prove local_simulator mode. No catalog or order mutation was attempted");
  }
  manifest.simulatorEvidence = { publicMode: runtime.mode, simulatedPayments: runtime.simulatedPayments, authenticatedRunMode: settings.runMode, authenticatedPaymentProviderMode: settings.paymentProviderMode, checkedAt: new Date().toISOString() }; save();
  await request("owner", "/api/auth/login", { method: "POST", body: credentials("yankeefga07@gmail.com") });
  const owned = await request("owner", "/api/restaurant/restaurants");
  if (!manifest.previewKitchenId) { const kitchen = owned.find(r => !r.name.includes("· Demo")); assert(kitchen, "Existing preview kitchen was not found"); manifest.previewKitchenId = kitchen.id; save(); }
  const api = (identity, route, options) => request(identity, route, options);
  for (const catalog of DEMO_CATALOG) manifest.restaurants[catalog.key] = await ensureRestaurant(api, "owner", "admin", catalog, manifest.restaurants[catalog.key], state => { manifest.restaurants[catalog.key] = state; save(); });
  for (let i = 0; i < 4; i++) {
    const key = `customer-${i}`;
    if (!manifest.customers[key]) { manifest.customers[key] = { email: `cal-eats-demo-${randomBytes(6).toString("hex")}@example.invalid`, password: `Demo-${randomBytes(24).toString("base64url")}`, name: `Demo Customer ${i + 1}` }; save(); }
    const identity = manifest.customers[key];
    if (!identity.id) { const registered = await request(key, "/api/auth/register", { method: "POST", body: { name: identity.name, email: identity.email, password: identity.password }, allowStatus: [409] }); if (registered?.status === 409) { const logged = await request(key, "/api/auth/login", { method: "POST", body: { email: identity.email, password: identity.password } }); identity.id = logged.user.id; } else { const account = await request(key, "/api/auth/me"); identity.id = account.user.id; } save(); }
    else await request(key, "/api/auth/login", { method: "POST", body: { email: identity.email, password: identity.password } });
    if (!identity.preferences) { await request(key, "/api/account/preferences", { method: "PATCH", body: { merchantOffers: i !== 3 } }); identity.preferences = true; save(); }
  }
  if (!manifest.historyRestaurantId) {
    const existingKitchen = owned.find(r => r.id === manifest.previewKitchenId);
    if (existingKitchen?.status === "approved") manifest.historyRestaurantId = manifest.previewKitchenId;
    else { manifest.historyRestaurantId = manifest.restaurants[DEMO_CATALOG[0].key].id; manifest.warnings.push("Existing preview kitchen is not approved; test-customer history was assigned to the first new Demo restaurant without changing the existing kitchen."); }
    save();
  }
  const kitchenMenu = await request("owner", `/api/restaurant/restaurants/${manifest.historyRestaurantId}/menu`), kitchenMain = kitchenMenu.items.find(item => item.available)?.id; assert(kitchenMain, "Chosen demo history restaurant has no available item");
  for (let i = 0; i < 4; i++) {
    const key = `preview-kitchen:customer-${i}`; if (manifest.orders[key]) continue;
    const order = await completeOrder(api, "owner", `customer-${i}`, manifest.historyRestaurantId, kitchenMain, `${DATASET}:hosted:${key}`); manifest.orders[key] = order.id; save();
  }
  for (const catalog of DEMO_CATALOG) {
    const restaurant = manifest.restaurants[catalog.key], orderKey = `primary:${catalog.key}`;
    if (!manifest.orders[orderKey]) { const order = await completeOrder(api, "owner", "customer-0", restaurant.id, restaurant.menu[0], `${DATASET}:hosted:${orderKey}`); manifest.orders[orderKey] = order.id; save(); }
    if (!manifest.offers[catalog.key]) { const campaign = await request("owner", `/api/restaurant/restaurants/${restaurant.id}/offers`, { method: "POST", key: `${DATASET}:hosted:offer:${catalog.key}`, body: { customerIds: [manifest.customers["customer-0"].id], title: `Demo: free ${catalog.dishes[2].name.toLowerCase()}`, message: "Fictional test offer with a qualifying paid demo order. No real food or payment.", menuItemId: restaurant.menu[2], minSubtotalMinor: 500, expiresInDays: 30 } }); manifest.offers[catalog.key] = campaign.id; save(); }
  }
  manifest.complete = true; save();
  console.log(JSON.stringify({ mode: "hosted-preview", origin: HOST, restaurantsAdded: Object.keys(manifest.restaurants).length, fictionalCustomersAdded: Object.keys(manifest.customers).length, offers: Object.keys(manifest.offers).length, orders: Object.keys(manifest.orders).length, historyRestaurantId: manifest.historyRestaurantId, warnings: manifest.warnings, credentialsSavedPrivately: manifestPath, simulatedOnly: true, newerWorkflowFixtures: "Local preview only until deployed" }, null, 2));
  } finally {
    for (const identity of [...cookies.keys()]) { try { await request(identity, "/api/auth/logout", { method: "POST", body: {} }); } catch {} }
  }
}

if (args.includes("--hosted-plan")) hostedPlan();
else if (args.includes("--hosted-apply")) seedHosted().catch(error => { console.error(error.message); process.exitCode = 1; });
else seedLocal().catch(error => { console.error(error.message); process.exitCode = 1; });
