import test from "node:test";
import assert from "node:assert/strict";
import {createStaffCapabilities,STAFF_CAPABILITIES} from "../src/staff-capabilities.js";
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const values=Object.fromEntries(STAFF_CAPABILITIES.map(row=>[row.key,row.key==="canProcessOrders"]));
function fixture(overrides={}){const calls=[],model=createStaffCapabilities({restaurantId:"restaurant-1",userId:"staff-1",permission:"staff",owner:true,request:(url,options)=>{const pending=deferred();calls.push({url,options,...pending});return pending.promise;},...overrides});return {model,calls,response:capabilities=>({restaurantId:"restaurant-1",userId:"staff-1",capabilities:capabilities??values})};}

test("staff access loads exact existing flags and saves only explicit changes, never staff-privilege or bank grants",async()=>{
  const f=fixture();assert.equal(f.calls.length,0);const loaded=f.model.open();f.model.open();assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,"/api/restaurant/restaurants/restaurant-1/staff/staff-1/capabilities");f.calls[0].resolve(f.response({...values,canManageStaff:true,canPrint:true}));await loaded;
  assert.deepEqual(f.model.getSnapshot().draft,values);assert.deepEqual(f.model.changes(),{});assert.equal(await f.model.save(),false);
  f.model.set("canManageStaff",true);assert.deepEqual(f.model.changes(),{});f.model.set("canViewFinance",true);
  const save=f.model.save();f.model.save();assert.equal(f.calls.length,2);assert.deepEqual(JSON.parse(f.calls[1].options.body),{canViewFinance:true});
  f.calls[1].resolve(f.response({...values,canViewFinance:true}));assert.equal(await save,true);assert.equal(f.model.getSnapshot().open,false);assert.equal(f.model.getSnapshot().saved,true);f.model.dispose();
});

test("unknown saves require a fresh read and cannot silently retry or overwrite other permissions",async()=>{
  const f=fixture(),load=f.model.open();f.calls[0].resolve(f.response());await load;f.model.set("canManageMenu",true);const save=f.model.save();f.calls[1].reject(Error("Connection lost"));assert.equal(await save,false);assert.equal(f.model.getSnapshot().requiresReload,true);assert.equal(await f.model.save(),false);assert.equal(f.calls.length,2);
  const reload=f.model.reload();f.calls[2].resolve(f.response({...values,canManageMenu:true,canManageCustomers:true}));await reload;assert.equal(f.model.getSnapshot().requiresReload,false);assert.deepEqual(f.model.changes(),{});assert.equal(f.model.getSnapshot().draft.canManageCustomers,true);f.model.dispose();
});

test("closed identities ignore delayed reads and owner/staff boundaries fail closed",async()=>{
  for(const boundary of [{owner:false},{permission:"owner"},{userId:""}]){const f=fixture(boundary);assert.equal(f.model.allowed,false);assert.equal(await f.model.open(),false);assert.equal(f.calls.length,0);f.model.dispose();}
  const old=fixture(),load=old.model.open();old.model.dispose();assert.equal(old.calls[0].options.signal.aborted,true);old.calls[0].resolve(old.response());assert.equal(await load,false);assert.equal(old.model.getSnapshot().loaded,false);
  const f=fixture(),invalid=f.model.open();f.calls[0].resolve({...f.response(),userId:"other-staff"});await invalid;assert.equal(f.model.getSnapshot().loaded,false);assert.equal(await f.model.save(),false);f.model.dispose();
});

test("lost owner authority cannot leave a usable stale permission form",async()=>{
  const f=fixture(),load=f.model.open();f.calls[0].resolve(f.response());await load;f.model.set("canManageSettings",true);const save=f.model.save();f.calls[1].reject(Object.assign(Error("Denied"),{status:403}));await save;assert.match(f.model.getSnapshot().error,/Only the restaurant owner/);assert.equal(f.model.getSnapshot().requiresReload,true);assert.equal(await f.model.save(),false);f.model.dispose();
});

test("effect cleanup and reactivation cannot revive an earlier permission read",async()=>{
  const f=fixture(),old=f.model.open();f.model.dispose();f.model.activate();const current=f.model.open();
  f.calls[0].resolve(f.response({...values,canViewFinance:true}));await old;assert.equal(f.model.getSnapshot().loaded,false);
  f.calls[1].resolve(f.response());await current;assert.equal(f.model.getSnapshot().draft.canViewFinance,false);f.model.dispose();
});
