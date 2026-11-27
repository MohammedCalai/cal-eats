import test from "node:test";
import assert from "node:assert/strict";
import { acceptsHostedMessageSound,embeddedCommand,embeddedState } from "../src/embedded-business-model.js";
test("embedded navigation accepts only its exact Calai parent and fixed non-auth routes",()=>{
  const parent={},event={origin:"https://calai.info",source:parent,data:{type:"cal-eats-workspace:navigate",version:1,view:"accounts"}};
  assert.equal(embeddedCommand(event,parent),"/owner/connections");
  for (const [view, path] of Object.entries({reports:"/owner/dashboard?section=reports",statements:"/owner/statements",notifications:"/owner/notifications"})) {
    assert.equal(embeddedCommand({...event,data:{...event.data,view}},parent),path);
  }
  for(const change of [{origin:"https://calai.info.attacker.test"},{source:{}},{data:{...event.data,view:"https://attacker.test"}},{data:{...event.data,view:"/api/auth/login"}},{data:{...event.data,version:2}}])assert.equal(embeddedCommand({...event,...change},parent),null);
});
test("embedded state exposes only account proof, product capability and aggregate status fields",()=>{
  const business={id:"workspace",name:"Restaurant",password:"secret",products:{calai:{adminAllowed:true,linked:true,readiness:{ready:true},effectiveStatus:"ready",nativeAccountId:"native",verifiedSourceUserId:"owner",accessToken:"never"},"cal-eats":{adminAllowed:true,linked:true,readiness:{ready:true},effectiveStatus:"ready",capabilities:{viewOrders:true,viewPayouts:false}}}};
  const state=embeddedState(business,{business:{id:"workspace"},counts:{calai:{today:0,available:false},"cal-eats":{today:4,available:true}},orders:[{address:"private"}]},{state:"online",customerName:"private"},true);
  assert.deepEqual(state.business,{id:"workspace",name:"Restaurant"});assert.deepEqual(state.counters.calai,{today:null,available:false});assert.deepEqual(state.counters["cal-eats"],{today:4,available:true});
  assert.equal(state.products.calai.verifiedSourceUserId,"owner");assert.equal(state.capabilities.viewPayouts,false);assert.equal(state.capabilities.manageMenu,false);
  assert.equal(JSON.stringify(state).includes("secret"),false);assert.equal(JSON.stringify(state).includes("never"),false);assert.equal(JSON.stringify(state).includes("private"),false);
});
test("signed-out embedded state removes all previous account IDs, counts and capabilities",()=>{
  const state=embeddedState({id:"old",name:"Previous",products:{"cal-eats":{adminAllowed:true,linked:true,capabilities:{viewOrders:true}}}},{counts:{"cal-eats":{today:7,available:true}}},{state:"online"},false);
  assert.equal(state.business,null);assert.equal(state.surface,null);assert.equal(state.products.calai.sourceAccountId,null);assert.equal(state.capabilities.viewOrders,false);assert.deepEqual(state.counters["cal-eats"],{today:null,available:false});
});
test("a tablet set to Calai only does not advertise Cal-Eats tools to the existing Calai shell", () => {
  const business = { id: "workspace", name: "Restaurant", products: {
    calai: { adminAllowed: true, linked: true, readiness: { ready: true } },
    "cal-eats": { adminAllowed: true, linked: true, allowedOnTablet: false, capabilities: { viewOrders: true } },
  } };
  const state = embeddedState(business, { business: { id: "workspace" }, counts: { "cal-eats": { today: 7, available: true } } }, null, true);
  assert.equal(state.products.calai.linked, true);
  assert.equal(state.products["cal-eats"].linked, false);
  assert.equal(state.capabilities.viewOrders, false);
  assert.deepEqual(state.counters["cal-eats"], { today: null, available: false });
});

test("the host can open a scoped Eats order or park its hidden content on an inert route", () => {
  const parent = {}, orderId = "65664905-e562-4d86-bb6a-690e72a5208c";
  const command = (view, extra = {}) => embeddedCommand({source:parent,origin:"https://calai.info",
    data:{type:"cal-eats-workspace:navigate",version:1,view,...extra}}, parent);
  assert.equal(command("background"), "/owner/embedded-background");
  assert.equal(command("orders", {orderId}), "/owner/orders?order=" + orderId);
  assert.equal(command("orders", {orderId:orderId + "&other=1"}), null);
  assert.equal(command("menu", {orderId}), null);
});

test("Both exposes the current allowed tools and aggregate notices without transferring personal order data", () => {
  const business = { id: "workspace", principalKind: "terminal", products: {
    calai: { adminAllowed: true, linked: true, readiness: { ready: true } },
    "cal-eats": { adminAllowed: true, linked: true, readiness: { ready: true } },
  } };
  const at = "2026-11-27T11:49:21.000Z";
  const dashboard = { business: { id: business.id }, counts: { "cal-eats": { available: true, today: 2 } },
    orders: [{ source: "cal-eats", status: "preparing", createdAt: at, fulfilment: "collection", totalMinor: 500,
      id: "private", customerName: "private", deliveryAddress: "private" }] };
  const options = { mode: "both", tabletMode: "both", pendingOrderCount: 1, paths: new Set(["/owner/orders", "/owner/offers"]) };
  const ready = embeddedState(business, dashboard, null, true, options);
  assert.equal(ready.tabletMode, "both");
  assert.equal(ready.principalKind, "terminal");
  assert.equal(ready.pendingOrderCount, 1);
  assert.equal(ready.capabilities.viewOrders, true);
  assert.equal(ready.capabilities.manageMarketing, true);
  assert.equal(ready.capabilities.viewPayouts, false);
  assert.deepEqual(ready.orders, [{ source: "cal-eats", status: "preparing", createdAt: at, fulfilment: "collection", totalMinor: 500 }]);
  dashboard.orders[0].sourceOrderId = "65664905-e562-4d86-bb6a-690e72a5208c";
  dashboard.eatsLiveOrders = {liveOrders:3,pendingConfirmation:1,confirmedInKitchen:1,readyForHandover:1,privateNote:"private"};
  dashboard.calaiLiveCalls = {activeCalls:4,agentsInUse:2,ringing:0,queued:1,forwarding:0,calls:[{caller:"private"}]};
  const stats = embeddedState(business, dashboard, null, true, options);
  assert.deepEqual(stats.eatsLiveOrders,{liveOrders:3,pendingConfirmation:1,confirmedInKitchen:1,readyForHandover:1});
  assert.deepEqual(stats.calaiLiveCalls,{activeCalls:4,agentsInUse:2,ringing:0,queued:1,forwarding:0});
  assert.equal(stats.orders[0].sourceOrderId,dashboard.orders[0].sourceOrderId);
  assert.equal(JSON.stringify(stats).includes("private"),false);
  const denied = embeddedState(business, dashboard, null, true, {...options,paths:new Set()});
  assert.deepEqual(denied.orders,[]);
  assert.equal(denied.eatsLiveOrders,null);
  assert.equal(JSON.stringify(ready).includes("private"), false);
  for (const tabletMode of [null, "calai", "cal-eats"]) {
    const stale = embeddedState(business, dashboard, null, true, { ...options, tabletMode });
    assert.deepEqual(stale.orders, []);
    assert.equal(stale.pendingOrderCount, null);
    assert.equal(stale.eatsLiveOrders, null);
  }
  const foreign = embeddedState(business, { ...dashboard, business: { id: "other" } }, null, true, options);
  assert.deepEqual(foreign.orders, []);
  assert.equal(foreign.counters["cal-eats"].available, false);
  assert.equal(embeddedState({ ...business, principalKind: "human" }, dashboard, null, true, { ...options, tabletMode: null }).pendingOrderCount, null);
});

test("the host can take responsibility for sound only in the current parent window and business", () => {
  const parent = {}, data = { type: "cal-eats-workspace:host-message-audio", version: 1, businessId: "location" };
  const event = { data, source: parent, origin: "https://calai.info" };
  assert.equal(acceptsHostedMessageSound(event, parent, "location"), true);
  for (const change of [{ source: {} }, { origin: "https://example.com" },
    { data: { ...data, version: 2 } }, { data: { ...data, businessId: "other" } },
    { data: { ...data, type: "cal-eats-workspace:navigate" } }]) {
    assert.equal(acceptsHostedMessageSound({ ...event, ...change }, parent, "location"), false);
  }
});

test("message attention only includes a recent count and sound state for this authorised restaurant", () => {
  const business = { id: "business", eatsRestaurantId: "restaurant", principalKind: "human", products: {
    calai: { adminAllowed: true, linked: true, readiness: { ready: true } },
    "cal-eats": { adminAllowed: true, linked: true, readiness: { ready: true } },
  } };
  const summary = { unreadCount: 3, revision: 5, acknowledgedRevision: 3, soundEnabled: true, orderAlarmActive: false };
  const feed = { ...summary, restaurantId: "restaurant", checkedAt: Date.now(), customerName: "private", message: "secret", orderId: "other" };
  const options = { mode: "both", tabletMode: null, paths: new Set(["/owner/inbox"]), messageAttention: feed };
  const state = (opts = {}, actor = business) => embeddedState(actor, null, null, true, { ...options, ...opts }).messageAttention;
  assert.deepEqual(state(), summary);
  assert.deepEqual(state({messageAttention:{...feed,acknowledgedRevision:6}}),{...summary,acknowledgedRevision:5});
  assert.deepEqual(state({ tabletMode: "both", paths: new Set(["/owner/orders"]) }, { ...business, principalKind: "terminal" }), summary);
  for (const change of [{checkedAt:Date.now()-50_000},{checkedAt:Date.now()+50_000},{restaurantId:"foreign"},
    {unreadCount:"3"},{unreadCount:-1},{revision:-3},{acknowledgedRevision:-9},{soundEnabled:1},{orderAlarmActive:null}]) {
    assert.equal(state({ messageAttention:{ ...feed, ...change } }), null);
  }
  assert.equal(state({ paths: new Set(["/owner/menu"]) }), null);
  assert.equal(state({ tabletMode: "calai" }), null);
  assert.equal(state({ mode: "cal-eats" }), null);
  assert.equal(state({}, { ...business, principalKind: "terminal" }), null);
  assert.equal(state({}, { ...business, products: { ...business.products, calai: { ...business.products.calai, linked: false } } }), null);
  assert.equal(embeddedState(business, null, null, false, options).messageAttention, null);
});
