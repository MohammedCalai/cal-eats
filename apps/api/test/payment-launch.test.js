import test from "node:test";
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
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

test("active payment readiness excludes archived demos and exposes operational and credential blockers",async()=>{
  const f=await journeyFixture({orderAlertEmail:{mode:"off"},paymentProviderMode:"stripe_test",paymentProvider:{mode:"stripe_test"},stripePlatformAccountId:"acct_fixture",paymentProviderWebhookSecret:"whsec_platform_fixture",paymentProviderConnectWebhookSecret:"whsec_connect_fixture"});
  try{
    const admin=await f.login("admin@calai.local","LocalAdmin!4310"),restaurant=f.db.prepare("SELECT * FROM restaurants WHERE name='Calai Kitchen'").get(),archived=f.db.prepare("SELECT * FROM restaurants WHERE name='Second Spoon'").get(),stamp=f.config.now().toISOString();
    f.db.prepare("UPDATE restaurants SET archived_at=? WHERE id=?").run(stamp,archived.id);
    for(const [id,reference]of [[restaurant.id,"acct_activefixture"],[archived.id,"acct_archivedfixture"]])f.db.prepare("INSERT INTO provider_accounts VALUES(?,?,'stripe_test','enabled','[\"card_payments\",\"transfers\"]','[]',?,?,?)").run(randomUUID(),id,reference,stamp,stamp);
    const connection=await f.json("/api/admin/finance/stripe/readiness",{cookie:admin});assert.equal(connection.status,200,connection.text);assert.equal(connection.body.data.providerMode,"stripe_test");assert.equal(connection.body.data.accounts.enabled,1,"Archived test bank accounts are not active connection checks");
    f.db.prepare("UPDATE provider_accounts SET provider_mode='stripe_live' WHERE restaurant_id=?").run(restaurant.id);f.db.prepare("INSERT INTO stripe_account_readiness VALUES(?,'stripe_live','acct_activefixture',1,1,?)").run(restaurant.id,stamp);f.db.prepare("UPDATE contracts SET demo_only=0 WHERE restaurant_id=?").run(restaurant.id);
    f.db.prepare("UPDATE restaurants SET phone='',address='',always_open=0,opening_hours='[]',collection_enabled=0,delivery_enabled=0,paused=1,suspended=1 WHERE id=?").run(restaurant.id);f.db.prepare("UPDATE menu_items SET available=0 WHERE restaurant_id=?").run(restaurant.id);
    const report=()=>paymentLaunchReport(f.db,f.config,{environment:{}}),before=f.db.prepare("SELECT total_changes() n").get().n,incomplete=report(),row=incomplete.restaurants.items[0];
    assert.equal(f.db.prepare("SELECT total_changes() n").get().n,before);assert.equal(incomplete.restaurants.total,1);assert.equal(row.accountReady,true);assert.equal(row.termsApproved,true);assert.equal(row.operationalReady,false);assert.equal(row.ownerSecurityReady,false);assert.equal(row.platformSecurityReady,false);
    for(const label of ["contact number","address","opening hours","available menu item","collection","Unpause","suspension","restaurant owner","platform administrator"])assert.ok(row.reasons.some(reason=>reason.includes(label)),label);
    for(const id of ["restaurant_operations","account_security"])assert.equal(incomplete.checks.find(check=>check.id===id).state,"blocked");
    const ownerId=f.db.prepare("SELECT user_id FROM restaurant_memberships WHERE restaurant_id=? AND permission='owner'").get(restaurant.id).user_id,adminId=f.db.prepare("SELECT id FROM users WHERE email='admin@calai.local'").get().id;
    for(const id of [ownerId,adminId]){const hash=f.db.prepare("SELECT password_hash FROM users WHERE id=?").get(id).password_hash;f.db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(),id,"user",id,"password_changed",JSON.stringify({policy:"live-banking-v1",credentialFingerprint:createHash("sha256").update(hash).digest("hex"),otherSessionsRevoked:true}),stamp);}
    f.db.prepare("UPDATE restaurants SET phone='01234567890',address='Fixture restaurant address',opening_hours=?,collection_enabled=1,paused=0,suspended=0 WHERE id=?").run(JSON.stringify([{day:1,open:"12:00",close:"18:00"}]),restaurant.id);f.db.prepare("UPDATE menu_items SET available=1 WHERE restaurant_id=?").run(restaurant.id);
    const prepared=report();assert.equal(prepared.checks.find(check=>check.id==="restaurant_operations").state,"ready");assert.equal(prepared.checks.find(check=>check.id==="account_security").state,"ready");assert.equal(prepared.restaurants.items[0].operationalReady,true);assert.equal(prepared.restaurants.items[0].reasons.length,0);assert.equal(prepared.currentMode,"stripe_test");assert.equal(prepared.ready,false,"Readiness checks never activate real payments");
    const pendingOwner=f.db.prepare("SELECT u.id,u.password_hash FROM users u JOIN restaurant_memberships m ON m.user_id=u.id WHERE m.restaurant_id=? AND m.permission='owner'").get(archived.id);f.db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(),pendingOwner.id,"user",pendingOwner.id,"password_changed",JSON.stringify({policy:"live-banking-v1",credentialFingerprint:createHash("sha256").update(pendingOwner.password_hash).digest("hex")}),stamp);f.db.prepare("UPDATE restaurants SET archived_at=NULL WHERE id=?").run(archived.id);
    const pending=report();assert.equal(pending.restaurants.items.find(row=>row.id===archived.id).ownerSecurityReady,true,"Secure pending owners are reported accurately");assert.equal(pending.checks.find(check=>check.id==="account_security").state,"ready");assert.match(pending.checks.find(check=>check.id==="account_security").detail,/1 of 1 approved restaurants/);
  }finally{await f.close();}
});
