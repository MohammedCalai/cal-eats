import test from "node:test";
import assert from "node:assert/strict";
import { embeddedCommand,embeddedState } from "../src/embedded-business-model.js";
test("embedded navigation accepts only its exact Calai parent and fixed non-auth routes",()=>{
  const parent={},event={origin:"https://calai.info",source:parent,data:{type:"cal-eats-workspace:navigate",version:1,view:"accounts"}};
  assert.equal(embeddedCommand(event,parent),"/owner/connections");
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
  assert.equal(JSON.stringify(ready).includes("private"), false);
  for (const tabletMode of [null, "calai", "cal-eats"]) {
    const stale = embeddedState(business, dashboard, null, true, { ...options, tabletMode });
    assert.deepEqual(stale.orders, []);
    assert.equal(stale.pendingOrderCount, null);
  }
  const foreign = embeddedState(business, { ...dashboard, business: { id: "other" } }, null, true, options);
  assert.deepEqual(foreign.orders, []);
  assert.equal(foreign.counters["cal-eats"].available, false);
  assert.equal(embeddedState({ ...business, principalKind: "human" }, dashboard, null, true, { ...options, tabletMode: null }).pendingOrderCount, null);
});
