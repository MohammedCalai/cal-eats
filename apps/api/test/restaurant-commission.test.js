import assert from "node:assert/strict";
import test from "node:test";
import {journeyFixture} from "./helpers.js";
import {resolveRestaurantCommission} from "../src/restaurant-commission.js";

const credentials={admin:["admin@calai.local","LocalAdmin!4310"],owner:["restaurant@calai.local","LocalRestaurant!4310"],customer:["customer@calai.local","LocalCustomer!4310"]};
async function setup(options={}){const f=await journeyFixture({orderAlertEmail:{mode:"off"},businessStatements:{sendEnabled:false},rateLimit:{attempts:100,windowMs:60000},...options});const admin=await f.login(...credentials.admin),owner=await f.login(...credentials.owner),customer=await f.login(...credentials.customer),restaurant=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0];return{f,admin,owner,customer,restaurant,path:`/api/admin/restaurants/${restaurant.id}/commission`};}

test("commission controls require platform admin, validate exact periods and reject stale concurrent changes",async()=>{
  const {f,admin,owner,customer,restaurant,path}=await setup();
  try{
    const change=(body,cookie=admin)=>f.json(path,{method:"PATCH",cookie,body});
    assert.equal((await f.json(path)).status,401);
    for(const cookie of [owner,customer]){assert.equal((await f.json(path,{cookie})).status,403);assert.equal((await change({action:"disable",expectedRevision:0},cookie)).status,403);}
    assert.equal((await f.json(path,{cookie:admin})).body.data.effectiveRateBasisPoints,700);
    for(const body of [{action:"disable"},{action:"disable",expectedRevision:-1},{action:"disable",expectedRevision:0,rateBasisPoints:200},{action:"schedule_free",expectedRevision:0,freePeriod:{startsAt:"2026-01-02T00:00:00",endsAt:"2026-01-09T00:00:00Z"}},{action:"schedule_free",expectedRevision:0,freePeriod:{startsAt:"2026-02-30T00:00:00Z",endsAt:"2026-03-09T00:00:00Z"}},{action:"schedule_free",expectedRevision:0,freePeriod:{startsAt:"2026-01-02T00:00:00Z",endsAt:"2026-01-01T00:00:00Z"}}])assert.equal((await change(body)).status,400);
    const [a,b]=await Promise.all([change({action:"disable",expectedRevision:0}),change({action:"schedule_free",expectedRevision:0,freePeriod:{startsAt:"2026-01-02T00:00:00Z",endsAt:"2026-01-09T00:00:00Z"}})]);
    assert.deepEqual([a.status,b.status].sort(),[200,409]);assert.equal([a,b].find(row=>row.status===409).body.error.code,"COMMISSION_SETTINGS_CHANGED");
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM restaurant_commission_controls").get().n,1);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE entity_type='restaurant_commission'").get().n,1);
    const other=f.db.prepare("SELECT id FROM restaurants WHERE id<>? LIMIT 1").get(restaurant.id);assert.equal(resolveRestaurantCommission(f.db,other.id,f.config.now()).rateBasisPoints,700);
  }finally{await f.close();}
});

test("timed free commission uses exact start/end boundaries, stable quote metadata and automatic resumption",async()=>{
  let now=new Date("2026-01-01T01:00:00Z");const {f,admin,restaurant,path}=await setup({now:()=>now});let administrator=admin;
  try{
    const change=body=>f.json(path,{method:"PATCH",cookie:administrator,body});
    const scheduled=await change({action:"schedule_free",expectedRevision:0,freePeriod:{startsAt:"2026-01-02T00:00:00Z",endsAt:"2026-01-16T00:00:00Z"}});assert.equal(scheduled.status,200,scheduled.text);
    for(const [time,rate,mode] of [["2026-01-01T23:59:59.999Z",700,"standard"],["2026-01-02T00:00:00Z",0,"free_period"],["2026-01-15T23:59:59.999Z",0,"free_period"],["2026-01-16T00:00:00Z",700,"standard"]]){const result=resolveRestaurantCommission(f.db,restaurant.id,time);assert.equal(result.rateBasisPoints,rate);assert.equal(result.snapshot.mode,mode);}
    assert.deepEqual(resolveRestaurantCommission(f.db,restaurant.id,"2026-01-03T00:00:00Z").snapshot,resolveRestaurantCommission(f.db,restaurant.id,"2026-01-04T12:30:00Z").snapshot);
    now=new Date("2026-01-16T00:00:00Z");administrator=await f.login(...credentials.admin);assert.equal((await f.json(path,{cookie:administrator})).body.data.effectiveRateBasisPoints,700);
    assert.equal((await change({action:"disable",expectedRevision:1})).body.data.effectiveRateBasisPoints,0);
    assert.equal(resolveRestaurantCommission(f.db,restaurant.id,"2026-06-01T00:00:00Z").rateBasisPoints,0);
    const enabled=await change({action:"enable",expectedRevision:2});assert.equal(enabled.body.data.effectiveRateBasisPoints,700);assert.equal(enabled.body.data.freePeriod,null);
    // London has a 25-hour day when clocks go back: starting "today" must still work late that night.
    now=new Date("2026-10-25T23:30:00Z");administrator=await f.login(...credentials.admin);
    const fallback=await change({action:"schedule_free",expectedRevision:3,freePeriod:{startsAt:"2026-10-24T23:00:00Z",endsAt:"2026-11-01T00:00:00Z"}});assert.equal(fallback.status,200,fallback.text);assert.equal(fallback.body.data.state,"free_period");
  }finally{await f.close();}
});

test("zero-rate orders snapshot after discounts plus delivery and retain historical accounting after re-enabling",async()=>{
  const {f,admin,owner,customer,restaurant,path}=await setup({now:()=>new Date("2026-01-01T01:00:00Z")});
  try{
    const item=(await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];f.db.prepare("UPDATE menu_items SET price_minor=1500 WHERE id=?").run(item.id);f.db.prepare("UPDATE restaurants SET delivery_enabled=1,delivery_outcodes='[\"LU1\"]',delivery_fee_minor=200,min_delivery_subtotal_minor=0 WHERE id=?").run(restaurant.id);
    await f.json("/api/account/marketing-preferences",{method:"PATCH",cookie:customer,body:{inAppPromotions:true,pushPromotions:false,source:"commission-control-test"}});
    const campaign=await f.json(`/api/restaurant/restaurants/${restaurant.id}/loyalty/promotions`,{method:"POST",cookie:owner,headers:{"Idempotency-Key":"commission-control-first-offer"},body:{title:"Four pounds off",message:"Restaurant-funded first order offer",offerType:"fixed_off",campaignType:"amount_order",value:400,minSubtotalMinor:0,startsAt:"2026-01-01T00:00:00Z",expiresAt:"2026-01-10T00:00:00Z",redemptionLimit:1,budgetMinor:10000,eligibleItemIds:[],eligibleCategories:[],recipientSegment:"first_order",customerIds:[],stackingPolicy:"exclusive",fundingParty:"restaurant"}});assert.equal(campaign.status,201,campaign.text);
    const grant=await f.json(`/api/promotions/${campaign.body.data.id}/claim`,{method:"POST",cookie:customer,body:{}});assert.equal(grant.status,200,grant.text);
    const basket={restaurantId:restaurant.id,items:[{menuItemId:item.id,quantity:1}],fulfillment:"delivery",deliveryAddress:{line1:"10 Fictional Demo Road",city:"Luton",postcode:"LU1 2AB"}},quote=async offerId=>f.json("/api/orders/quote",{method:"POST",cookie:customer,body:{...basket,...(offerId?{offerId}:{})}});
    const before=(await quote(grant.body.data.id)).body.data;assert.equal(before.subtotalMinor,1100);assert.equal(before.deliveryFeeMinor,200);assert.equal(before.commission.baseMinor,1300);assert.equal(before.commissionMinor,91);
    const normal=await f.json("/api/orders",{method:"POST",cookie:customer,headers:{"Idempotency-Key":"commission-before-control"},body:{...basket,paymentMethod:"mock_card"}});assert.equal(normal.status,201,normal.text);assert.equal(normal.body.data.commissionMinor,119);
    await f.json(path,{method:"PATCH",cookie:admin,body:{action:"disable",expectedRevision:0}});
    const waived=(await quote(grant.body.data.id)).body.data;assert.equal(waived.commissionMinor,0);assert.notDeepEqual(waived.commission.control,before.commission.control);
    const free=await f.json("/api/orders",{method:"POST",cookie:customer,headers:{"Idempotency-Key":"commission-during-control"},body:{...basket,paymentMethod:"mock_card",offerId:grant.body.data.id}});assert.equal(free.status,201,free.text);assert.equal(free.body.data.totalMinor,1300);assert.equal(free.body.data.commissionMinor,0);assert.equal(free.body.data.contract.rateBasisPoints,0);
    await f.json(path,{method:"PATCH",cookie:admin,body:{action:"enable",expectedRevision:1}});
    for(const status of ["accepted","preparing","ready","out_for_delivery","completed"]){const advanced=await f.json(`/api/restaurant/orders/${free.body.data.id}/status`,{method:"PATCH",cookie:owner,body:{status}});assert.equal(advanced.status,200,advanced.text);assert.equal(advanced.body.data.commissionMinor,0);}
    assert.equal((await f.json(`/api/orders/${normal.body.data.id}`,{cookie:customer})).body.data.commissionMinor,119);
    const snapshot=JSON.parse(f.db.prepare("SELECT commission_control_snapshot FROM orders WHERE id=?").get(free.body.data.id).commission_control_snapshot);assert.equal(snapshot.mode,"disabled");assert.equal(snapshot.rateBasisPoints,0);
    assert.equal(f.db.prepare("SELECT commission_minor FROM orders WHERE id=?").get(free.body.data.id).commission_minor,0);
  }finally{await f.close();}
});
