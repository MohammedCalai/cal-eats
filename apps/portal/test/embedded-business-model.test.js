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
  const state=embeddedState(business,{counts:{calai:{today:0,available:false},"cal-eats":{today:4,available:true}},orders:[{address:"private"}]},{state:"online",customerName:"private"},true);
  assert.deepEqual(state.business,{id:"workspace",name:"Restaurant"});assert.deepEqual(state.counters.calai,{today:null,available:false});assert.deepEqual(state.counters["cal-eats"],{today:4,available:true});
  assert.equal(state.products.calai.verifiedSourceUserId,"owner");assert.equal(state.capabilities.viewPayouts,false);assert.equal(state.capabilities.manageMenu,false);
  assert.equal(JSON.stringify(state).includes("secret"),false);assert.equal(JSON.stringify(state).includes("never"),false);assert.equal(JSON.stringify(state).includes("private"),false);
});
test("signed-out embedded state removes all previous account IDs, counts and capabilities",()=>{
  const state=embeddedState({id:"old",name:"Previous",products:{"cal-eats":{adminAllowed:true,linked:true,capabilities:{viewOrders:true}}}},{counts:{"cal-eats":{today:7,available:true}}},{state:"online"},false);
  assert.equal(state.business,null);assert.equal(state.surface,null);assert.equal(state.products.calai.sourceAccountId,null);assert.equal(state.capabilities.viewOrders,false);assert.deepEqual(state.counters["cal-eats"],{today:null,available:false});
});
