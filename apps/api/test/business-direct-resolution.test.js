import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { migrateDatabase,openDatabase } from "../src/db/index.js";
import { runMarketplaceWorker } from "../src/marketplace.js";
import { runGovernanceReminders } from "../src/admin-governance.js";
import { runStripeConnectWorker } from "../src/payments/stripe-connect.js";
import { prepareStripeOrderTransition } from "../src/payments/stripe-transitions.js";
import { businessDirectResolutionSummary } from "../src/business-direct-resolution.js";
import { journeyFixture } from "./helpers.js";

const stamp="2026-10-27T12:00:00.000Z";

test("business-direct resolution is the default and order help reaches the restaurant without opening a refund case",async()=>{
  assert.equal(loadConfig().financialRemediesEnabled,false);
  const f=await journeyFixture({financialRemediesEnabled:false,rateLimit:{attempts:30,windowMs:60000}});
  try{
    const customer=await f.login("customer@calai.local","LocalCustomer!4310"),owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),admin=await f.login("admin@calai.local","LocalAdmin!4310");
    const restaurant=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0],item=(await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
    const placed=await f.json("/api/orders",{method:"POST",cookie:customer,headers:{"Idempotency-Key":"direct-order-help"},body:{restaurantId:restaurant.id,items:[{menuItemId:item.id,quantity:1}],paymentMethod:"mock_card",fulfillment:"collection"}});assert.equal(placed.status,201,placed.text);
    const order=placed.body.data;
    for(const [route,cookie] of [["/api/refund-cases",customer],[`/api/admin/orders/${order.id}/refunds`,admin],["/api/admin/refund-cases/old/decision",admin],[`/api/restaurant/restaurants/${restaurant.id}/refund-cases/old/proposals`,owner],["/api/refund-cases/old/proposals/old/respond",customer]]){
      const blocked=await f.json(route,{method:"POST",cookie,body:{}});assert.equal(blocked.status,409,blocked.text);assert.equal(blocked.body.error.code,"BUSINESS_DIRECT_RESOLUTION");
    }
    const requested=await f.json("/api/support",{method:"POST",cookie:customer,headers:{"Idempotency-Key":"direct-order-help-request"},body:{orderId:order.id,subject:"Help with my order",message:"Please help put my missing item right."}});assert.equal(requested.status,201,requested.text);assert.equal(requested.body.data.assignedTo,"restaurant");
    const inbox=await f.json(`/api/restaurant/restaurants/${restaurant.id}/support?page=1`,{cookie:owner});assert.equal(inbox.status,200,inbox.text);assert.equal(inbox.body.data.items.some(row=>row.id===requested.body.data.id),true);
    const dashboard=await f.json(`/api/restaurant/restaurants/${restaurant.id}/dashboard`,{cookie:owner});assert.equal(dashboard.status,200,dashboard.text);assert.equal(dashboard.body.data.operations.actionRequiredOrderHelp,1);
    const reply=await f.json(`/api/support/${requested.body.data.id}/messages`,{method:"POST",cookie:owner,headers:{"Idempotency-Key":"direct-order-help-reply"},body:{message:"We will contact you and put this right."}});assert.equal(reply.status,201,reply.text);
    assert.equal((await f.json(`/api/restaurant/restaurants/${restaurant.id}/dashboard`,{cookie:owner})).body.data.operations.actionRequiredOrderHelp,0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM refund_cases").get().n,0);
    assert.deepEqual(runGovernanceReminders(f.db,f.config),{reminders:0,escalations:0});
    assert.equal((await f.json("/api/admin/resolution-policy",{cookie:admin})).body.data.mode,"business_direct");
  }finally{await f.close();}
});

function paymentFixture(){
  const db=openDatabase(":memory:");migrateDatabase(db);
  db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES('customer','Customer','customer@example.test','unused','customer',?),('owner','Owner','owner@example.test','unused','restaurant',?)").run(stamp,stamp);
  db.prepare("INSERT INTO restaurants(id,name,status,created_at) VALUES('restaurant','Kitchen','approved',?)").run(stamp);
  db.prepare("INSERT INTO restaurant_memberships(restaurant_id,user_id,permission,created_at) VALUES('restaurant','owner','owner',?)").run(stamp);
  for(const [id,method,status,payment] of [["card","card","accepted","stripe_captured"],["local","mock_card","accepted","mock_captured"],["void","card","placed","stripe_authorized"]]){
    db.prepare("INSERT INTO orders(id,restaurant_id,restaurant_name,customer_id,status,subtotal_minor,total_minor,commission_minor,payment_method,payment_status,fulfillment,idempotency_key,request_hash,created_at,updated_at) VALUES(?,'restaurant','Kitchen','customer',?,2000,2000,140,?,?,'collection',?,'fixture',?,?)").run(id,status,method,payment,id,stamp,stamp);
    if(method==="card")db.prepare("INSERT INTO stripe_order_payments(order_id,provider_mode,checkout_session_id,payment_intent_id,status,provider_cost_minor,created_at,updated_at) VALUES(?,'stripe_test',?,?,?,0,?,?)").run(id,`cs_${id}`,`pi_${id}`,id==="void"?"authorized":"captured",stamp,stamp);
  }
  for(const [id,kind] of [["card","stripe_refund"],["local","refund_execution"]]){
    db.prepare("INSERT INTO refund_cases(id,reference,order_id,restaurant_id,customer_id,status,reason,item_ids,description,issue_hash,requested_amount_minor,approved_amount_minor,remedy,execution_status,provider_mode,monthly_review_flag,created_at,updated_at) VALUES(?,?,?,'restaurant','customer','approved','quality','[]','Historical issue',?,500,500,'refund','queued',?,0,?,?)").run(`case-${id}`,`RC-${id}`,id,id,id==="card"?"stripe_test":"local_simulator",stamp,stamp);
    db.prepare("INSERT INTO marketplace_worker_jobs(id,kind,entity_id,operation_key,status,attempts,payload,available_at,created_at,updated_at) VALUES(?,?,?,?,'queued',0,?,?,?,?)").run(`job-${id}`,kind,`case-${id}`,`refund-case:case-${id}:${id==="card"?"stripe":"execute"}`,JSON.stringify({caseId:`case-${id}`,paymentIntentId:`pi_${id}`,amountMinor:500}),stamp,stamp,stamp);
  }
  return db;
}

test("queued refunds remain visible for business review while provider refund creation is disabled",async()=>{
  const db=paymentFixture();let refundCalls=0;
  const config={financialRemediesEnabled:false,paymentProviderMode:"stripe_test",stripePlatformAccountId:"acct_platform",paymentProviderWebhookSecret:"whsec_platform",paymentProviderConnectWebhookSecret:"whsec_connect",orderExpiryMinutes:15,now:()=>new Date(stamp),stripeProvider:{retrievePlatformAccount:async()=>({providerReference:"acct_platform",status:"confirmed"}),refundPayment:async()=>{refundCalls++;throw new Error("No refund should be created");}}};
  try{
    assert.equal(runMarketplaceWorker(db,config).claimed,0);
    assert.equal((await runStripeConnectWorker(db,config)).claimed,0);assert.equal(refundCalls,0);
    const summary=businessDirectResolutionSummary(db,config);assert.equal(summary.reviewRequired,true);assert.equal(summary.items.length,2);assert.equal(summary.items.every(row=>row.action==="business_review_required"),true);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM marketplace_worker_jobs WHERE status='queued' AND attempts=0").get().n,2);assert.equal(db.prepare("SELECT COUNT(*) n FROM refunds").get().n,0);
  }finally{db.close();}
});

test("rejecting an unfulfilled authorized card order still cancels its authorization",async()=>{
  const db=paymentFixture();let cancelled=false,calls=0;
  const facts=()=>({status:"confirmed",paymentState:cancelled?"cancelled":"authorized",providerReference:"pi_void",paymentIntentId:"pi_void",amountMinor:2000,currency:"GBP",captureMethod:"manual",orderId:"void",restaurantId:"restaurant"});
  const config={financialRemediesEnabled:false,paymentProviderMode:"stripe_test",stripePlatformAccountId:"acct_platform",paymentProviderWebhookSecret:"whsec_platform",paymentProviderConnectWebhookSecret:"whsec_connect",now:()=>new Date(stamp),stripeProvider:{retrievePlatformAccount:async()=>({providerReference:"acct_platform",status:"confirmed"}),retrieveCheckoutSession:async()=>facts(),retrievePayment:async()=>facts(),cancelPayment:async()=>{calls++;cancelled=true;return facts();},refundPayment:async()=>{throw new Error("Refunds are disabled");}}};
  try{
    const result=await prepareStripeOrderTransition(db,config,{orderId:"void",userId:"owner",targetStatus:"rejected"});assert.equal(result.paymentState,"cancelled");assert.equal(calls,1);
  }finally{db.close();}
});

test("an already-submitted provider refund can be reconciled without issuing another refund",async()=>{
  const db=paymentFixture();let creates=0,retrieves=0;
  db.prepare("INSERT INTO marketplace_operations(id,operation_key,restaurant_id,order_id,kind,status,amount_minor,currency,provider_mode,provider_reference,metadata,created_at,updated_at) VALUES('historic-refund','refund-case:case-card:stripe','restaurant','card','order_refund','unknown',500,'GBP','stripe_test','re_existing','{}',?,?)").run(stamp,stamp);
  const config={financialRemediesEnabled:false,paymentProviderMode:"stripe_test",stripePlatformAccountId:"acct_platform",paymentProviderWebhookSecret:"whsec_platform",paymentProviderConnectWebhookSecret:"whsec_connect",orderExpiryMinutes:15,now:()=>new Date(stamp),stripeProvider:{retrievePlatformAccount:async()=>({providerReference:"acct_platform",status:"confirmed"}),refundPayment:async()=>{creates++;throw new Error("No refund should be created");},retrieveRefund:async()=>{retrieves++;return{status:"confirmed",providerReference:"re_existing",amountMinor:500,currency:"GBP",paymentIntentId:"pi_card",orderId:"card",restaurantId:"restaurant"};}}};
  try{
    const result=await runStripeConnectWorker(db,config);assert.equal(result.completed,1);assert.equal(creates,0);assert.equal(retrieves,1);assert.equal(db.prepare("SELECT execution_status FROM refund_cases WHERE id='case-card'").get().execution_status,"confirmed");assert.equal(db.prepare("SELECT COUNT(*) n FROM refunds WHERE order_id='card'").get().n,1);
  }finally{db.close();}
});
