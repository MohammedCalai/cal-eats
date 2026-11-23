import test from "node:test";
import assert from "node:assert/strict";
import { createAutomaticTerminalClient } from "../src/terminal-client.js";

const TERMINAL = "a1111111-1111-4111-8111-111111111111", BUSINESS = "b2222222-2222-4222-8222-222222222222", RESTAURANT = "c3333333-3333-4333-8333-333333333333", ACTOR = "d4444444-4444-4444-8444-444444444444", SCREEN = "e5555555-5555-4555-8555-555555555555", OTHER = "f6666666-6666-4666-8666-666666666666";
const CSRF = "c".repeat(43), WINDOW = "w".repeat(43), NEXT_WINDOW = "n".repeat(43);
const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const bootstrap = (paired = true) => ({ product: "calai-business-terminal", version: "1.0.0", paired, terminalId: paired ? TERMINAL : null, csrfToken: CSRF });
const session = (overrides = {}) => ({ principalKind: "terminal", terminalId: TERMINAL, businessId: BUSINESS, restaurantId: RESTAURANT, user: { id: ACTOR, role: "restaurant", name: "Arndale tablet", email: `terminal+${ACTOR}@device.calai.invalid` }, products: { calai: { active: true, linked: true, status: "active", sourceAccountId: "calai-source", connectionStatus: "connected", authExpiresAt: null }, "cal-eats": { active: true, linked: true, status: "active", sourceAccountId: RESTAURANT } }, windowProof: WINDOW, expiresAt: new Date(NOW + 3600000).toISOString(), ...overrides });
const response = (data, status = 200) => new Response(JSON.stringify(status < 400 ? { data } : { error: data }), { status, headers: { "content-type": "application/json" } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(predicate) { for (let index = 0; index < 50 && !predicate(); index++) await new Promise(resolve => setImmediate(resolve)); assert.ok(predicate(), "Expected request was not made"); }
function fixture(overrides = {}) {
  const calls = [], queue = [], timers = new Map(); let timer = 0, now = NOW, permission = { state: "granted" }, remembered = false;
  const client = createAutomaticTerminalClient({ clock: () => now, screenIdFactory: () => SCREEN, permissionQuery: () => permission, discoveryHint: { read: () => remembered, write: value => { remembered = value; } }, schedule: (callback, delay) => { const id = ++timer; timers.set(id, { callback, delay }); return id; }, cancel: id => timers.delete(id), fetchImpl: (url, options) => { calls.push({ url, options }); const next = queue.shift(); if (!next) throw new Error("Unexpected request"); return typeof next === "function" ? next(url, options) : next; }, ...overrides });
  const ready = async (value = session()) => { queue.push(response(bootstrap()), response(value)); return client.connectAutomaticTerminal(); };
  return { client, calls, queue, timers, ready, setTime: value => { now = value; }, setPermission: value => { permission = value; }, setHint: value => { remembered = value; }, hint: () => remembered };
}

test("automatic sign-in returns a scoped safe identity and keeps all transport secrets in its closure", async () => {
  const f = fixture();
  const context = await f.ready(session({ serverToken: "never-return-server-token", user: { id: ACTOR, role: "restaurant", name: "Restaurant tablet", password: "never-return-password" }, products: { calai: { active: true, secret: "never-return-calai-secret", connectionStatus: "connected", authExpiresAt: null }, "cal-eats": { active: true } } }));
  assert.equal(context.principalKind, "terminal"); assert.equal(context.businessId, BUSINESS); assert.equal(context.screenId, SCREEN);
  assert.equal(Object.hasOwn(context, "windowProof"), false); assert.equal(Object.hasOwn(context, "serverToken"), false);
  assert.equal(Object.hasOwn(context.user, "password"), false); assert.equal(Object.hasOwn(context.products.calai, "secret"), false);
  const safe = JSON.stringify({ context, status: f.client.terminalStatus() });
  for (const secret of [CSRF, WINDOW, "never-return-server-token", "never-return-password", "never-return-calai-secret"]) assert.ok(!safe.includes(secret));
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, "http://127.0.0.1:17864/v1/bootstrap");
  assert.equal(f.calls[1].url, "http://127.0.0.1:17864/v1/automatic-session");
  assert.deepEqual(JSON.parse(f.calls[1].options.body), { screenId: SCREEN });
  assert.equal(f.calls[1].options.headers["X-Calai-Terminal-CSRF"], CSRF);
  for (const { options } of f.calls) { assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error"); assert.equal(options.cache, "no-store"); assert.equal(options.mode, "cors"); assert.equal(options.targetAddressSpace, "loopback"); assert.equal(options.headers.Authorization, undefined); assert.equal(options.headers.Cookie, undefined); }
  assert.equal(f.client.terminalStatus().status, "ready");
  context.products.calai.active = false; assert.equal(f.client.terminalStatus().context.products.calai.active, true);
  assert.equal(f.timers.size, 0);
});

test("terminal API unwraps JSON and forwards only a bounded JSON envelope and idempotency key", async () => {
  const f = fixture(); await f.ready(); f.queue.push(response({ saved: true }));
  const path = `/api/restaurant/orders/${OTHER}/status`;
  assert.deepEqual(await f.client.terminalApi(path, { method: "patch", credentials: "include", headers: { "Content-Type": "application/json", Accept: "application/json", "Idempotency-Key": "tablet-operation-123" }, body: JSON.stringify({ status: "confirmed" }) }), { saved: true });
  const sent = f.calls[2]; assert.equal(sent.url, "http://127.0.0.1:17864/v1/request");
  assert.deepEqual(JSON.parse(sent.options.body), { method: "PATCH", path, body: { status: "confirmed" }, headers: { "Idempotency-Key": "tablet-operation-123" } });
  assert.equal(sent.options.headers["X-Calai-Terminal-Window"], WINDOW);
  assert.equal(sent.options.credentials, "omit");
  f.queue.push(response({ id: ACTOR })); assert.deepEqual(await f.client.terminalApi("/api/auth/me"), { id: ACTOR });
  assert.deepEqual(JSON.parse(f.calls[3].options.body), { method: "GET", path: "/api/auth/me", body: null, headers: {} });
});

test("client rejects unsafe paths, another business, and human authentication targets", async () => {
  const f = fixture(); await f.ready(session({ products: { calai: { active: false }, "cal-eats": { active: true } } }));
  const paths = ["https://example.test/api/auth/me", "//example.test/api/auth/me", "/api/admin/users", "/api/native/business/auth/login", "/api/auth/login", "/api/restaurant/../admin/users", "/api/restaurant/%2e%2e/admin/users", "/api/restaurant/%2fadmin", "/api/restaurant/orders#fragment", "/api/restaurant/orders\n", "/api/restaurant//orders", `/api/restaurant/restaurants/${OTHER}/orders`, `/api/restaurant/orders?restaurantId=${OTHER}`, `/api/business/businesses/${OTHER}/orders`, `/api/business/orders?businessId=${OTHER}`];
  for (const path of paths) await assert.rejects(f.client.terminalApi(path), error => error.code === "TERMINAL_OPERATION_DENIED", path);
  await assert.rejects(f.client.terminalApi("/api/auth/me", { method: "POST" }), error => error.code === "TERMINAL_OPERATION_DENIED");
  await assert.rejects(f.client.terminalApi("/api/restaurant/orders", { method: "TRACE" }), error => error.code === "TERMINAL_OPERATION_DENIED");
  assert.equal(f.calls.length, 2);
});

test('product activation after bootstrap uses current signed server authority without dropping location safeguards',async()=>{
  const f=fixture();await f.ready(session({products:{calai:{active:false,linked:false},'cal-eats':{active:false,linked:false}}}));
  f.queue.push(response({code:'PRODUCT_INACTIVE',message:'Not enabled on this tablet'},403));
  await assert.rejects(f.client.terminalApi('/api/business/calai/orders'),error=>error.code==='PRODUCT_INACTIVE');assert.equal(f.client.terminalStatus().status,'ready');
  f.queue.push(response({items:[]}));assert.deepEqual(await f.client.terminalApi(`/api/restaurant/restaurants/${RESTAURANT}/orders`),{items:[]},'A later server activation is usable with the same location-bound device session');
  f.queue.push(response({items:[]}));assert.deepEqual(await f.client.terminalApi('/api/business/calai/orders'),{items:[]});
  await assert.rejects(f.client.terminalApi(`/api/restaurant/restaurants/${OTHER}/orders`),error=>error.code==='TERMINAL_OPERATION_DENIED');
  await assert.rejects(f.client.terminalApi('/api/business/orders',{method:'POST',body:{restaurantId:OTHER}}),error=>error.code==='TERMINAL_SCOPE_MISMATCH');
  assert.equal(f.calls.length,5);
});

test("body/header validation rejects credential leaks, raw uploads, invalid JSON and oversized requests before sending", async () => {
  const f = fixture(); await f.ready(); const path = "/api/business/orders";
  for (const headers of [{ Authorization: "Bearer owner-secret" }, { Cookie: "owner-cookie" }, { Origin: "https://example.test" }, { "X-Anything": "value" }, { "Content-Type": "multipart/form-data" }, { "Idempotency-Key": "bad key" }]) {
    await assert.rejects(f.client.terminalApi(path, { method: "POST", headers, body: "{}" }), error => /^TERMINAL_(?:HEADER|IDEMPOTENCY)_/.test(error.code));
  }
  for (const body of ["{", { value: NaN }, { value: undefined }, new FormData(), new Uint8Array([1, 2]), { callback: () => {} }]) await assert.rejects(f.client.terminalApi(path, { method: "POST", body }), error => error.code === "TERMINAL_BODY_INVALID");
  await assert.rejects(f.client.terminalApi(path, { method: "GET", body: "{}" }), error => error.code === "TERMINAL_BODY_INVALID");
  await assert.rejects(f.client.terminalApi(path, { method: "POST", body: { value: "x".repeat(65536) } }), error => error.code === "TERMINAL_BODY_TOO_LARGE");
  await assert.rejects(f.client.terminalApi(path, { method: "POST", body: { businessId: OTHER } }), error => error.code === "TERMINAL_SCOPE_MISMATCH");
  assert.equal(f.calls.length, 2); assert.equal(f.client.terminalStatus().status, "ready");
});

test("unreachable connection, unpaired tablet, offline cloud and revoked tablet are distinct without claiming missing software", async () => {
  const f = fixture(); f.queue.push(() => Promise.reject(new TypeError("Connection refused")));
  await assert.rejects(f.client.connectAutomaticTerminal(), error => error.code === "TERMINAL_LOCAL_UNAVAILABLE" && error.retryable);
  assert.equal(f.client.terminalStatus().status, "connection_unavailable");
  f.queue.push(response(bootstrap(false)));
  await assert.rejects(f.client.connectAutomaticTerminal(), error => error.code === "TABLET_NOT_ENROLLED");
  assert.equal(f.client.terminalStatus().status, "unpaired"); assert.equal(f.calls.length, 2);
  f.queue.push(response(bootstrap()), response({ code: "TABLET_NETWORK_UNAVAILABLE", message: "Cloud unavailable" }, 503));
  await assert.rejects(f.client.connectAutomaticTerminal(), error => error.code === "TABLET_NETWORK_UNAVAILABLE" && error.status === 503);
  assert.equal(f.client.terminalStatus().status, "offline"); assert.equal(f.client.terminalStatus().paired, true);
  f.queue.push(response(bootstrap()), response({ code: "TABLET_REVOKED", message: "Tablet revoked" }, 403));
  await assert.rejects(f.client.connectAutomaticTerminal(), error => error.code === "TABLET_REVOKED");
  assert.equal(f.client.terminalStatus().status, "revoked");
  await assert.rejects(f.client.terminalApi("/api/auth/me"), error => error.code === "TERMINAL_SESSION_REQUIRED");
  assert.ok(f.calls.every(call => call.url.startsWith("http://127.0.0.1:17864/")));
});

test("automatic session rejects owner/admin identities, mismatched device and screen, expired grants and secret fields", async () => {
  for (const change of [{ user: { id: ACTOR, role: "admin", name: "Administrator" } }, { user: { id: ACTOR, role: "owner", name: "Owner" } }, { principalKind: "human" }, { terminalId: OTHER }, { screenId: OTHER }, { expiresAt: new Date(NOW - 1).toISOString() }, { expiresAt: new Date(NOW + 48 * 3600000).toISOString() }, { windowProof: "short" }, { products: { calai: { active: "yes" } } }]) {
    const f = fixture(); f.queue.push(response(bootstrap()), response(session(change)));
    await assert.rejects(f.client.connectAutomaticTerminal(), error => error.code === "TERMINAL_LOCAL_INVALID");
    assert.equal(f.client.terminalStatus().context, null);
    await assert.rejects(f.client.terminalApi("/api/auth/me"), error => error.code === "TERMINAL_SESSION_REQUIRED");
  }
});

test("a disconnected startup cannot publish its late response over a newer automatic session", async () => {
  const f = fixture(), oldResponse = deferred(); f.queue.push(response(bootstrap()), oldResponse.promise);
  const first = f.client.connectAutomaticTerminal(); first.catch(() => {}); await until(() => f.calls.length === 2);
  f.client.disconnectLocalTerminal(); const next = await f.ready(session({ windowProof: NEXT_WINDOW }));
  oldResponse.resolve(response(session({ user: { id: ACTOR, role: "restaurant", name: "Old response" } })));
  await assert.rejects(first, error => error.code === "TERMINAL_CONTEXT_CHANGED");
  assert.equal(f.client.terminalStatus().context.user.name, next.user.name); assert.equal(f.client.terminalStatus().status, "ready");
  f.queue.push(response({ okay: true })); await f.client.terminalApi("/api/auth/me");
  assert.equal(f.calls.at(-1).options.headers["X-Calai-Terminal-Window"], NEXT_WINDOW);
});

test("a late rejection from an old window cannot clear the next window's grant", async () => {
  const f = fixture(); await f.ready(); const pending = deferred(); f.queue.push(pending.promise);
  const old = f.client.terminalApi("/api/auth/me"); old.catch(() => {}); await until(() => f.calls.length === 3);
  f.queue.push(response(bootstrap()), response(session({ windowProof: NEXT_WINDOW, screenId: OTHER })));
  await f.client.connectAutomaticTerminal({ screenId: OTHER });
  pending.resolve(response({ code: "TABLET_REVOKED", message: "Old rejection" }, 403));
  await assert.rejects(old, error => error.code === "TERMINAL_CONTEXT_CHANGED");
  assert.equal(f.client.terminalStatus().status, "ready"); assert.equal(f.client.terminalStatus().context.screenId, OTHER);
});

test("abort during automatic startup clears proofs and late completion cannot authenticate the page", async () => {
  const f = fixture(), controller = new AbortController(), pending = deferred(); f.queue.push(response(bootstrap()), pending.promise);
  const opening = f.client.connectAutomaticTerminal({ signal: controller.signal }); opening.catch(() => {}); await until(() => f.calls.length === 2);
  controller.abort(); await assert.rejects(opening, error => error.code === "TERMINAL_ABORTED");
  assert.equal(f.client.terminalStatus().context, null);
  pending.resolve(response(session())); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.client.terminalStatus().context, null); assert.equal(f.timers.size, 0);
  await f.ready(); assert.equal(f.client.terminalStatus().status, "ready");
});

test("a second startup caller can cancel its own wait without cancelling another active startup", async () => {
  const f = fixture(), pending = deferred(), secondController = new AbortController(); f.queue.push(response(bootstrap()), pending.promise);
  const first = f.client.connectAutomaticTerminal(); await until(() => f.calls.length === 2);
  const second = f.client.connectAutomaticTerminal({ signal: secondController.signal }); second.catch(() => {});
  secondController.abort(); await assert.rejects(second, error => error.code === "TERMINAL_ABORTED");
  pending.resolve(response(session())); await first;
  assert.equal(f.calls.length, 2); assert.equal(f.client.terminalStatus().status, "ready");
});

test("cancelling one view's API read does not sign the whole restaurant tablet out", async () => {
  const f = fixture(); await f.ready(); const controller = new AbortController(), pending = deferred(); f.queue.push(pending.promise);
  const reading = f.client.terminalApi("/api/business/orders", { signal: controller.signal }); reading.catch(() => {});
  await until(() => f.calls.length === 3); controller.abort();
  await assert.rejects(reading, error => error.code === "TERMINAL_ABORTED");
  pending.resolve(response({ old: true }));
  assert.equal(f.client.terminalStatus().status, "ready");
  f.queue.push(response({ current: true })); assert.deepEqual(await f.client.terminalApi("/api/auth/me"), { current: true });
  assert.equal(f.calls.at(-1).options.headers["X-Calai-Terminal-Window"], WINDOW);
});

test("timeout clears proofs, never replays a possibly accepted write, and requires explicit reconnect", async () => {
  const f = fixture(); await f.ready(); const pending = deferred(); f.queue.push(pending.promise);
  const writing = f.client.terminalApi("/api/business/orders", { method: "POST", body: "{}", headers: { "Idempotency-Key": "test-command-123" } }); writing.catch(() => {});
  await until(() => f.calls.length === 3); assert.equal(f.timers.size, 1);
  [...f.timers.values()][0].callback();
  await assert.rejects(writing, error => error.code === "TERMINAL_TIMEOUT");
  assert.equal(f.client.terminalStatus().status, "offline"); assert.equal(f.client.terminalStatus().context, null);
  await assert.rejects(f.client.terminalApi("/api/auth/me"), error => error.code === "TERMINAL_SESSION_REQUIRED");
  assert.equal(f.calls.length, 3);
  await f.ready(session({ windowProof: NEXT_WINDOW })); pending.resolve(response({ accepted: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(call => call.url.endsWith("/v1/request") && JSON.parse(call.options.body).method === "POST").length, 1);
  assert.equal(f.client.terminalStatus().status, "ready"); assert.equal(f.timers.size, 0);
});

test("expiry is renewed before dispatch while ordinary operation denial keeps terminal authority intact", async () => {
  const f = fixture(); await f.ready(); f.setTime(NOW + 3540001);
  f.queue.push(response(bootstrap()), response(session({ windowProof: NEXT_WINDOW, expiresAt: new Date(NOW + 7200000).toISOString() })), response({ code: "TABLET_OPERATION_DENIED", message: "Owner permission required" }, 403));
  await assert.rejects(f.client.terminalApi("/api/business/orders"), error => error.code === "TABLET_OPERATION_DENIED" && error.status === 403);
  assert.equal(f.calls.length, 5); assert.equal(f.calls[4].options.headers["X-Calai-Terminal-Window"], NEXT_WINDOW);
  assert.equal(f.client.terminalStatus().status, "ready");
  f.queue.push(response({ code: "TERMINAL_REVOKED", message: "Device revoked" }, 403));
  await assert.rejects(f.client.terminalApi("/api/auth/me"), error => error.code === "TERMINAL_REVOKED");
  assert.equal(f.client.terminalStatus().status, "revoked"); assert.equal(f.client.terminalStatus().context, null);
});

test("oversized or non-JSON broker responses cannot leave an authenticated context", async () => {
  for (const invalid of [new Response("not-json", { headers: { "content-type": "text/html" } }), new Response("{}", { headers: { "content-type": "application/json", "content-length": String(1024 * 1024 + 1) } }), new Response("x".repeat(1024 * 1024 + 1), { headers: { "content-type": "application/json" } })]) {
    const f = fixture(); f.queue.push(response(bootstrap()), invalid);
    await assert.rejects(f.client.connectAutomaticTerminal(), error => error.code === "TERMINAL_LOCAL_INVALID");
    assert.equal(f.client.terminalStatus().context, null); assert.equal(f.timers.size, 0);
  }
});

test("automatic startup does not prompt or contact loopback for prompt, denied or unsupported permissions", async () => {
  for (const state of ["prompt", "denied", "unknown"]) {
    const f = fixture(); f.setPermission({ state });
    if (state !== "unknown") f.setHint(true);
    await assert.rejects(f.client.connectAutomaticTerminal(), error => error.code === (state === "denied" ? "TERMINAL_PERMISSION_DENIED" : "TERMINAL_PERMISSION_REQUIRED"));
    assert.equal(f.calls.length, 0);
    assert.equal(f.client.terminalStatus().context, null);
    assert.equal(f.client.terminalStatus().status, state === "denied" ? "permission_denied" : "permission_required");
    assert.equal(f.timers.size, 0);
  }
});

test("trusted connection starts the actual fetch before any permission query and still validates the native identity", async () => {
  const permission = deferred(); let queries = 0;
  const f = fixture({ permissionQuery: () => { queries++; return permission.promise; } });
  f.queue.push(response(bootstrap()), response(session()));
  const opening = f.client.connectAutomaticTerminal({ userInitiated: true });
  assert.equal(f.calls.length, 1, "The first fetch must happen in the caller's click stack");
  assert.equal(queries, 0, "No asynchronous permission lookup may precede the prompting fetch");
  await until(() => queries === 1);
  assert.equal(f.client.terminalStatus().context, null);
  permission.resolve({ state: "granted" });
  await opening;
  assert.equal(f.client.terminalStatus().status, "ready");
  assert.equal(f.hint(), true);
});

test("denied permission can be rechecked on the same page without treating permission as terminal authority", async () => {
  const f = fixture(); f.setPermission({ state: "denied" });
  await assert.rejects(f.client.connectAutomaticTerminal(), error => error.code === "TERMINAL_PERMISSION_DENIED");
  f.setPermission({ state: "granted" });
  assert.equal(await f.client.recheckLoopbackPermission(), "granted");
  assert.equal(f.client.terminalStatus().status, "unchecked");
  assert.equal(f.client.terminalStatus().context, null);
  assert.equal(f.calls.length, 0);
  await f.ready();
  assert.equal(f.calls.length, 2);
});

test("a fresh signed connection alone can persist a discovery-only compatibility hint for unsupported browsers", async () => {
  let remembered = false;
  const discoveryHint = { read: () => remembered, write: value => { remembered = value; } };
  const f = fixture({ permissionQuery: () => ({ state: "unknown" }), discoveryHint });
  f.queue.push(response(bootstrap()), response(session()));
  await f.client.connectAutomaticTerminal({ userInitiated: true });
  assert.equal(remembered, true);
  const restarted = fixture({ permissionQuery: () => ({ state: "unknown" }), discoveryHint });
  await restarted.ready();
  assert.equal(restarted.client.terminalStatus().status, "ready");
  restarted.client.disconnectLocalTerminal();
  assert.equal(remembered, false, "Explicit local sign-out must clear the compatibility hint");
  remembered = true;
  const forged = fixture({ permissionQuery: () => ({ state: "unknown" }), discoveryHint });
  forged.queue.push(response(bootstrap()), response(session({ principalKind: "human", user: { id: ACTOR, role: "admin", name: "Ordinary login" } })));
  await assert.rejects(forged.client.connectAutomaticTerminal(), error => error.code === "TERMINAL_LOCAL_INVALID");
  assert.equal(forged.client.terminalStatus().context, null);
  assert.equal(remembered, false);
});

test("a failed compatibility probe clears its hint and cannot create a permission-prompt retry loop", async () => {
  const f = fixture(); f.setPermission({ state: "unknown" }); f.setHint(true);
  f.queue.push(() => Promise.reject(new TypeError("Synthetic inaccessible transport")));
  await assert.rejects(f.client.connectAutomaticTerminal(), error => error.code === "TERMINAL_LOCAL_UNAVAILABLE");
  assert.equal(f.hint(), false);
  assert.equal(f.client.terminalStatus().status, "connection_unavailable");
  await assert.rejects(f.client.connectAutomaticTerminal(), error => error.code === "TERMINAL_PERMISSION_REQUIRED");
  assert.equal(f.calls.length, 1);
});

test("permission revocation clears live proofs; granting it again never marks the tablet ready by itself", async () => {
  const permission = Object.assign(new EventTarget(), { state: "granted" });
  const f = fixture({ permissionQuery: () => permission });
  await f.ready();
  const snapshots = []; const unsubscribe = f.client.subscribe(value => snapshots.push(value));
  permission.state = "denied"; permission.dispatchEvent(new Event("change"));
  assert.equal(f.client.terminalStatus().status, "permission_denied");
  assert.equal(f.client.terminalStatus().context, null);
  assert.equal(f.hint(), false);
  await assert.rejects(f.client.terminalApi("/api/auth/me"), error => error.code === "TERMINAL_SESSION_REQUIRED");
  permission.state = "granted"; permission.dispatchEvent(new Event("change"));
  assert.equal(f.client.terminalStatus().status, "unchecked");
  assert.equal(f.client.terminalStatus().context, null);
  assert.equal(f.calls.length, 2);
  assert.ok(!snapshots.some(value => value.permission === "denied" && value.context));
  assert.ok(!JSON.stringify(snapshots).includes(WINDOW));
  unsubscribe();
  await f.ready();
});

test("a stalled permission query times out without a loopback request or an authenticated context", async () => {
  const f = fixture({ permissionQuery: () => new Promise(() => {}) });
  const opening = f.client.connectAutomaticTerminal(); opening.catch(() => {});
  await until(() => f.timers.size === 1);
  [...f.timers.values()][0].callback();
  await assert.rejects(opening, error => error.code === "TERMINAL_PERMISSION_REQUIRED");
  assert.equal(f.calls.length, 0);
  assert.equal(f.client.terminalStatus().context, null);
  assert.equal(f.timers.size, 0);
});

test("the sign-out latch can forget discovery immediately without destroying proof needed for signed logout", async () => {
  const f = fixture(); await f.ready();
  assert.equal(f.hint(), true);
  f.client.clearDiscoveryHint();
  assert.equal(f.hint(), false);
  assert.equal(f.client.terminalStatus().status, "ready");
  f.queue.push(response({ state: "signed_out" }));
  await f.client.terminalApi(`/api/business/accounts/${BUSINESS}/surface/heartbeat`, { method: "POST", body: { sequence: 1, state: "signed_out" } });
  assert.equal(f.calls.at(-1).options.headers["X-Calai-Terminal-Window"], WINDOW);
  f.client.disconnectLocalTerminal();
  assert.equal(f.client.terminalStatus().context, null);
  assert.equal(f.hint(), false);
});
