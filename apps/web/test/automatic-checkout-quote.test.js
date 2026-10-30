import assert from "node:assert/strict";
import test from "node:test";
import { mountCheckoutQuote } from "../customer-additions.js";

function eventSurface() {
  const target = new EventTarget(), listeners = new Map();
  const add = target.addEventListener.bind(target), remove = target.removeEventListener.bind(target);
  target.addEventListener = (type, handler, options) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(handler); add(type, handler, options); };
  target.removeEventListener = (type, handler, options) => { listeners.get(type)?.delete(handler); remove(type, handler, options); };
  target.listenerCount = () => [...listeners.values()].reduce((count, handlers) => count + handlers.size, 0);
  return target;
}
function node() {
  const value = Object.assign(eventSurface(), { disabled: false, attributes: {}, setAttribute(name, text) { this.attributes[name] = text; }, before() {}, insertAdjacentHTML(_position, html) { this.innerHTML += html; } });
  let html = "", text = "";
  Object.defineProperties(value, { innerHTML: { get: () => html, set: value => { html = String(value); text = ""; } }, textContent: { get: () => text, set: value => { text = String(value); html = text; } } });
  return value;
}
function harness(t) {
  const previous = { document: globalThis.document, window: globalThis.window, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const timers = new Map(), controllers = []; let nextId = 0;
  globalThis.setTimeout = (callback, delay) => { const id = ++nextId; timers.set(id, { callback, delay }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  const document = Object.assign(eventSurface(), { hidden: false, created: [], createElement() { const element = node(); this.created.push(element); return element; } });
  const window = eventSurface(); globalThis.document = document; globalThis.window = window;
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  t.after(() => { for (const controller of controllers) controller.close(); Object.assign(globalThis, previous); });
  return {
    timers, document, window, flush,
    async runTimer(delay) { const scheduled = [...timers.entries()].find(([, timer]) => timer.delay === delay); assert.ok(scheduled, `Expected an automatic timer after ${delay}ms`); timers.delete(scheduled[0]); await scheduled[1].callback(); await flush(); },
    mount(api, request) {
      const button = node(), totals = node(), heading = node(), form = node();
      button.textContent = "Place order"; totals.innerHTML = "Estimated total"; heading.textContent = "£10.00";
      Object.assign(form, { isConnected: true, querySelector(selector) { return { "#place-order": button, ".totals": totals }[selector] ?? null; }, closest() { return { querySelector: () => heading }; } });
      const controller = mountCheckoutQuote(form, { api, body: () => request.value }); controllers.push(controller);
      return { controller, button, totals, form, panel: document.created.at(-1), addressInput() { form.name = "line1"; form.dispatchEvent(new Event("input")); } };
    }
  };
}
const delivery = () => ({ fulfillment: "delivery", deliveryAddress: { line1: "1 High Street", city: "Luton", postcode: "LU1 1AA" } });
const quote = (offerId = "offer-a", giftName = "Tea") => ({ grossFoodMinor: 1000, restaurantDiscountMinor: 0, subtotalMinor: 1000, deliveryFeeMinor: 0, deliveryDiscountMinor: 0, totalMinor: 1000, commissionMinor: 70, offerId, autoOfferSelection: {candidateLimit:100,truncated:false,candidatesChecked:1}, promotion: offerId ? { grantId: offerId, title: "Free drink", gift: { menuItemId: giftName, name: giftName, quantity: 1, valueMinor: 100 } } : null });

test("incomplete delivery details never request a quote; completing the address debounces automatic offer checking", async t => {
  const h = harness(t), calls = [], request = { value: { fulfillment: "delivery", deliveryAddress: { line1: "", city: "", postcode: "LU1" } } };
  const view = h.mount(async (_path, options) => { calls.push(JSON.parse(options.body)); return quote(); }, request);
  await h.flush(); assert.equal(calls.length, 0); assert.equal(view.button.disabled, true); assert.equal(view.controller.totalMinor, null); assert.match(view.panel.textContent, /automatically/);
  request.value = delivery(); view.addressInput(); view.addressInput();
  assert.equal(calls.length, 0); assert.equal([...h.timers.values()].filter(timer => timer.delay === 350).length, 1);
  await h.runTimer(350);
  assert.equal(calls.length, 1); assert.equal(calls[0].autoApplyOffers, true); assert.equal(view.controller.offerId, "offer-a"); assert.equal(view.button.disabled, false);
  request.value.deliveryAddress.postcode = "LU1"; view.addressInput();
  assert.equal(view.controller.totalMinor, null); assert.equal(view.button.disabled, true); assert.doesNotMatch(view.totals.innerHTML, /Restaurant promotion/);
  await h.runTimer(350); assert.equal(calls.length, 1);
});

test("transient quote failures retry a bounded number of times and closing removes timers and foreground listeners", async t => {
  const h = harness(t); let calls = 0;
  const view = h.mount(async () => { calls++; throw Object.assign(new Error("Connection interrupted"), { status: 0 }); }, { value: { fulfillment: "collection" } });
  await h.flush();
  for (const delay of [1500, 4000, 10000]) await h.runTimer(delay);
  assert.equal(calls, 4); assert.equal(view.button.disabled, true); assert.equal(view.controller.totalMinor, null); assert.equal(h.timers.size, 0); assert.doesNotMatch(view.panel.innerHTML, /Retry price check/);
  h.window.dispatchEvent(new Event("online")); await h.flush(); assert.equal(calls, 5); assert.ok(h.timers.size > 0);
  view.controller.close(); assert.equal(h.timers.size, 0); assert.equal(h.window.listenerCount(), 0); assert.equal(h.document.listenerCount(), 0); assert.equal(view.form.listenerCount(), 0);
  h.window.dispatchEvent(new Event("focus")); h.window.dispatchEvent(new Event("online")); h.document.dispatchEvent(new Event("visibilitychange")); view.addressInput(); await view.controller.refresh(); await h.flush();
  assert.equal(calls, 5); assert.equal(h.timers.size, 0);
});

test("confirmation requires review when an equal-priced offer or free gift changes and exposes only the resolved offer ID", async t => {
  const h = harness(t); let current = quote();
  const view = h.mount(async () => current, { value: { fulfillment: "collection", offerId: "stale-manual-selection" } });
  await h.flush(); assert.equal(view.controller.offerId, "offer-a");
  current = quote("offer-b"); assert.equal(await view.controller.confirm(), false); assert.equal(view.controller.offerId, "offer-b"); assert.match(view.panel.innerHTML, /price or offer changed/);
  assert.equal(await view.controller.confirm(), true);
  current = quote("offer-b", "Coffee"); assert.equal(await view.controller.confirm(), false); assert.equal(view.controller.totalMinor, 1000); assert.match(view.panel.innerHTML, /Coffee/);
  assert.equal(await view.controller.confirm(), true);
  current = { ...quote(), offerId: null, promotion: null }; assert.equal(await view.controller.confirm(), false); assert.equal(view.controller.offerId, null);
});


test("an inconsistent quote never enables ordering or displays unverified savings", async t => {
  const h=harness(t),request={value:delivery()};
  const view=h.mount(async()=>({...quote(),totalMinor:1}),request);
  await h.flush();
  assert.equal(view.controller.totalMinor,null);
  assert.equal(view.button.disabled,true);
  assert.match(view.panel.textContent,/not confirmed/);
});
