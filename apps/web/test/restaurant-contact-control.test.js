import assert from "node:assert/strict";
import test from "node:test";
import { createRestaurantContactControl, mountRestaurantContactControls, restaurantContactCopy } from "../restaurant-contact-control.js";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("stopping and resuming only writes the intended customer/restaurant preference and locks duplicate actions", async () => {
  let blocked = false, pending; const calls = [], changed = [];
  const api = async (path, options) => {
    calls.push({ path, options });
    if (options?.method === "PUT") { if (pending) await pending.promise; blocked = JSON.parse(options.body).blocked; }
    return { restaurantId: "shop /1", blocked };
  };
  const control = createRestaurantContactControl({ api, restaurantId: "shop /1", onChanged: value => changed.push(value) });
  assert.equal(await control.change(true), false); assert.equal(calls.length, 0);
  assert.equal(await control.refresh(), true);
  pending = deferred(); const stopping = control.change(true);
  assert.equal(await control.change(true), false); assert.equal(await control.change(false), false);
  await settle(); assert.equal(calls.filter(call => call.options?.method === "PUT").length, 1);
  pending.resolve(); assert.equal(await stopping, true); pending = null;
  assert.equal(control.snapshot().blocked, true); assert.equal(await control.change(false), true);
  assert.deepEqual(changed, [false, true, false]);
  assert.deepEqual(calls.map(call => call.path), Array(3).fill("/api/customer-safety/restaurants/shop%20%2F1"));
  assert.deepEqual(calls.filter(call => call.options).map(call => JSON.parse(call.options.body)), [{ blocked: true }, { blocked: false }]);
  assert.match(restaurantContactCopy(false).explanation, /still browse, place orders/);
  assert.match(restaurantContactCopy(false).explanation, /order status, ETA and payment updates/);
  assert.doesNotMatch(restaurantContactCopy(false).action, /block restaurant/i);
  control.close(); assert.equal(await control.change(true), false);
});

test("a closed or changed identity cannot apply late results or start an old customer's mutation", async () => {
  let current = true; const first = deferred(), states = [], changes = [], calls = [];
  const control = createRestaurantContactControl({ restaurantId: "shop-a", isCurrent: () => current, api: async (...args) => { calls.push(args); return first.promise; }, onState: value => states.push(value), onChanged: value => changes.push(value) });
  const loading = control.refresh(); await settle(); current = false; const count = states.length;
  first.resolve({ restaurantId: "shop-a", blocked: true }); await loading;
  assert.equal(states.length, count); assert.deepEqual(changes, []); assert.equal(await control.change(true), false); assert.equal(calls.length, 1);
  const late = deferred(); current = true;
  const next = createRestaurantContactControl({ restaurantId: "shop-b", isCurrent: () => current, api: async (path, options) => options ? late.promise : { restaurantId: "shop-b", blocked: false }, onChanged: value => changes.push(value) });
  await next.refresh(); const saving = next.change(true); await settle(); next.close(); late.resolve({ restaurantId: "shop-b", blocked: true }); await saving;
  assert.deepEqual(changes, [false]);
  let writes = 0; const beforeDispatch = createRestaurantContactControl({ restaurantId: "shop-c", isCurrent: () => current, api: async (path, options) => { if (options) writes++; return { restaurantId: "shop-c", blocked: false }; } });
  await beforeDispatch.refresh(); const queued = beforeDispatch.change(true); current = false; await queued; assert.equal(writes, 0);
});

test("unknown update outcomes and mismatched restaurant responses require a status recheck", async () => {
  let blocked = false, loseReply = true;
  const control = createRestaurantContactControl({ restaurantId: "shop", api: async (path, options) => {
    if (options) { blocked = JSON.parse(options.body).blocked; if (loseReply) throw new Error("Connection lost"); }
    return { restaurantId: "shop", blocked };
  } });
  await control.refresh(); assert.equal(await control.change(true), false);
  assert.equal(control.snapshot().loaded, false); assert.equal(await control.change(false), false);
  assert.equal(await control.refresh(), true); assert.equal(control.snapshot().blocked, true);
  loseReply = false; assert.equal(await control.change(false), true);
  const wrong = createRestaurantContactControl({ restaurantId: "expected", api: async () => ({ restaurantId: "another", blocked: false }) });
  assert.equal(await wrong.refresh(), false); assert.equal(wrong.snapshot().loaded, false); assert.equal(await wrong.change(true), false);
});

test("the visible control keeps confirmation scoped and does not act after account change", async () => {
  const nodes = Object.fromEntries(["toggle", "retry", "status", "error"].map(key => [key, { textContent: "", hidden: false, disabled: false, setAttribute() {} }]));
  const container = { isConnected: true, innerHTML: "", querySelector(selector) { const key = selector.includes("toggle") ? "toggle" : selector.includes("retry") ? "retry" : selector.includes("status") ? "status" : "error"; return nodes[key]; } };
  let current = true, blocked = false; const calls = [], confirmation = deferred();
  const control = mountRestaurantContactControls({ container, restaurantId: "shop", isCurrent: () => current, confirm: () => confirmation.promise, api: async (path, options) => { calls.push(options); if (options) blocked = JSON.parse(options.body).blocked; return { restaurantId: "shop", blocked }; } });
  await control.refresh(); assert.equal(nodes.toggle.textContent, "Stop restaurant messages");
  const click = nodes.toggle.onclick(); current = false; confirmation.resolve(true); await click;
  assert.equal(calls.filter(Boolean).length, 0); control.close();
});
