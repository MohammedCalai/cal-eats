import test from "node:test";
import assert from "node:assert/strict";
import {journeyFixture} from "./helpers.js";
import {paymentLaunchReport} from "../src/payment-launch.js";

test("payment launch inventory is admin-only, read-only and paginates restaurant setup without accepting demo terms",async()=>{
  const f=await journeyFixture({orderAlertEmail:{mode:"off"}});
  try{
    const admin=await f.login("admin@calai.local","LocalAdmin!4310"),owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),customer=await f.login("customer@calai.local","LocalCustomer!4310"),route="/api/admin/finance/payment-launch";
    assert.equal((await f.json(route)).status,401);
    for(const cookie of[owner,customer])assert.equal((await f.json(route,{cookie})).status,403);
    assert.equal((await f.json(route,{method:"PATCH",cookie:admin,body:{livePaymentsEnabled:true}})).status,405);
    for(const suffix of["?page=0","?page=1.5","?pageSize=101"])assert.equal((await f.json(route+suffix,{cookie:admin})).status,400);
    const first=(await f.json(route+"?pageSize=1",{cookie:admin})).body.data;
    assert.equal(first.restaurants.items.length,1);assert.ok(first.restaurants.total>1);assert.equal(first.restaurants.hasMore,true);
    assert.equal(first.ready,false);assert.equal(first.livePaymentsEnabled,false);
    assert.equal(first.commission.base,"discounted_food_plus_charged_delivery");assert.equal(first.commission.processingFeesPaidBy,"platform");
    assert.equal(first.commission.captureAt,"restaurant_confirmation");assert.equal(first.commission.settlementAt,"completed");
    assert.ok(first.restaurants.items.every(row=>!row.termsApproved));
    assert.equal(f.config.paymentProviderMode,"local_simulator");
  }finally{await f.close();}
});

test("staged live secrets remain private; zero commission remains zero and a report cannot mutate money or account records",async()=>{
  const f=await journeyFixture({orderAlertEmail:{mode:"off"}});
  try{
    const admin=await f.login("admin@calai.local","LocalAdmin!4310"),owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),restaurant=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0];
    await f.json(`/api/admin/restaurants/${restaurant.id}/commission`,{method:"PATCH",cookie:admin,body:{action:"disable",expectedRevision:0}});
    const environment={CALAI_STRIPE_LIVE_ACCOUNT_ID:"acct_livefixture",CALAI_STRIPE_LIVE_SECRET_KEY:"rk_live_fixture_only",CALAI_STRIPE_LIVE_WEBHOOK_SECRET:"whsec_platform_fixture_only",CALAI_STRIPE_LIVE_CONNECT_WEBHOOK_SECRET:"whsec_connect_fixture_only"};
    const before=f.db.prepare("SELECT total_changes() n").get().n;
    const result=paymentLaunchReport(f.db,f.config,{environment});
    assert.equal(f.db.prepare("SELECT total_changes() n").get().n,before);
    assert.equal(result.currentMode,"local_simulator");assert.equal(result.ready,false);
    assert.equal(result.checks.find(row=>row.id==="live_connection").state,"review");assert.equal(result.checks.find(row=>row.id==="live_events").state,"review");
    assert.equal(result.restaurants.items.find(row=>row.id===restaurant.id).effectiveRateBasisPoints,0);
    const serialized=JSON.stringify(result);for(const value of Object.values(environment))assert.equal(serialized.includes(value),false);
    const reused=paymentLaunchReport(f.db,f.config,{environment:{...environment,CALAI_STRIPE_LIVE_CONNECT_WEBHOOK_SECRET:environment.CALAI_STRIPE_LIVE_WEBHOOK_SECRET}});
    assert.equal(reused.checks.find(row=>row.id==="live_events").state,"blocked");
  }finally{await f.close();}
});

test("launch checks include unmaterialized test refunds and require both restaurant transfer and card capabilities",async()=>{
  const f=await journeyFixture({orderAlertEmail:{mode:"off"}});
  try{
    const owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),customer=await f.login("customer@calai.local","LocalCustomer!4310"),restaurant=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0],stamp=f.config.now().toISOString();
    f.db.prepare("INSERT INTO provider_accounts(id,restaurant_id,provider_mode,status,capabilities,requirements,provider_reference,created_at,updated_at) VALUES('launch-account',?,'stripe_live','enabled','[\"card_payments\"]','[]','acct_launch',?,?)").run(restaurant.id,stamp,stamp);
    f.db.prepare("INSERT INTO stripe_account_readiness VALUES(?,'stripe_live','acct_launch',1,1,?)").run(restaurant.id,stamp);
    const report=()=>paymentLaunchReport(f.db,f.config,{environment:{}});
    assert.equal(report().restaurants.items.find(row=>row.id===restaurant.id).accountReady,false);
    f.db.prepare("UPDATE provider_accounts SET capabilities='[\"card_payments\",\"transfers\"]' WHERE restaurant_id=?").run(restaurant.id);
    assert.equal(report().restaurants.items.find(row=>row.id===restaurant.id).accountReady,true);
    const item=(await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
    const placed=await f.json("/api/orders",{method:"POST",cookie:customer,headers:{"Idempotency-Key":"launch-report-history"},body:{restaurantId:restaurant.id,items:[{menuItemId:item.id,quantity:1}],fulfillment:"collection",paymentMethod:"mock_card"}});assert.equal(placed.status,201,placed.text);const order=placed.body.data;
    f.db.prepare("INSERT INTO refund_cases(id,reference,order_id,restaurant_id,customer_id,status,reason,item_ids,description,issue_hash,requested_amount_minor,approved_amount_minor,provider_mode,created_at,updated_at) VALUES('launch-case','launch-case',?,?,?,'awaiting_restaurant','quality','[]','Fixture','fixture',10,10,'stripe_test',?,?)").run(order.id,restaurant.id,order.customerId,stamp,stamp);
    f.db.prepare("INSERT INTO marketplace_worker_jobs(id,kind,entity_id,operation_key,status,attempts,payload,available_at,created_at,updated_at) VALUES('launch-job','stripe_refund','launch-case','launch-lazy-refund','queued',0,'{}',?,?,?)").run(stamp,stamp,stamp);
    assert.equal(report().history.testJobsPending,1);
  }finally{await f.close();}
});
