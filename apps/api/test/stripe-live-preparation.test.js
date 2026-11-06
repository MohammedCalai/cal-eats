import test from "node:test";
import assert from "node:assert/strict";
import {openDatabase,migrateDatabase} from "../src/db/index.js";
import {journeyFixture} from "./helpers.js";
import {runStripeConnectWorker} from "../src/payments/stripe-connect.js";
import {queueEligibleStripeTransfers} from "../src/payments/stripe-settlement.js";

const stamp="2026-01-01T12:00:00.000Z",past="2020-01-01T00:00:00.000Z";

function mixedJobs(){
  const db=openDatabase(":memory:");migrateDatabase(db);
  db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES('customer','Fixture','fixture@example.invalid','unused','customer',?)").run(stamp);
  for(const mode of["stripe_test","stripe_live"]){
    const restaurant=`restaurant-${mode}`,order=`order-${mode}`,caseId=`case-${mode}`;
    db.prepare("INSERT INTO restaurants(id,name,status,created_at) VALUES(?,?,'approved',?)").run(restaurant,restaurant,stamp);
    db.prepare("INSERT INTO orders(id,restaurant_id,restaurant_name,customer_id,status,subtotal_minor,delivery_fee_minor,total_minor,commission_minor,payment_method,payment_status,fulfillment,idempotency_key,request_hash,created_at,updated_at) VALUES(?,?,?,'customer','completed',2000,0,2000,140,'card','stripe_captured','collection',?,'fixture',?,?)").run(order,restaurant,restaurant,order,stamp,stamp);
    db.prepare("INSERT INTO stripe_order_payments(order_id,provider_mode,payment_intent_id,latest_charge_id,status,provider_cost_minor,created_at,updated_at) VALUES(?,?,?,?,'captured',30,?,?)").run(order,mode,`pi_${mode}`,`ch_${mode}`,stamp,stamp);
    db.prepare("INSERT INTO refund_cases(id,reference,order_id,restaurant_id,customer_id,status,reason,item_ids,description,issue_hash,requested_amount_minor,approved_amount_minor,provider_mode,created_at,updated_at) VALUES(?,?,?,?,'customer','awaiting_restaurant','quality','[]','Fixture','fixture',10,10,?,?,?)").run(caseId,caseId,order,restaurant,mode,stamp,stamp);
    for(const kind of["stripe_transfer","stripe_refund","stripe_transfer_reversal"]){
      for(const [state,status,attempts] of[["queued","queued",0],["delayed","delayed",1],["recoverable","claimed",4],["exhausted","claimed",5]]){
        const id=`${mode}:${kind}:${state}`,operationKind=kind==="stripe_transfer"?"merchant_transfer":kind==="stripe_refund"?"order_refund":"transfer_reversal";
        db.prepare("INSERT INTO marketplace_operations VALUES(?,?,?,?,?,'pending',10,'GBP',?,NULL,NULL,'{}',?,?)").run(`op:${id}`,id,restaurant,order,operationKind,mode,stamp,stamp);
        db.prepare("INSERT INTO marketplace_worker_jobs(id,kind,entity_id,operation_key,status,lease_owner,lease_expires_at,attempts,payload,available_at,created_at,updated_at) VALUES(?,?,?,?,?,'old-worker',?,?,?,?,?,?)").run(id,kind,caseId,id,status,past,attempts,JSON.stringify({caseId,orderId:order,amountMinor:10,paymentIntentId:`pi_${mode}`,providerMode:mode}),past,stamp,stamp);
      }
    }
    // Refund operations are created lazily, so this job must be scoped by its persisted case.
    db.prepare("INSERT INTO marketplace_worker_jobs(id,kind,entity_id,operation_key,status,attempts,payload,available_at,created_at,updated_at) VALUES(?,'stripe_refund',?,?,'queued',0,?,?,?,?)").run(`${mode}:unmaterialized`,caseId,`${mode}:unmaterialized`,JSON.stringify({caseId,amountMinor:10,paymentIntentId:`pi_${mode}`}),past,stamp,stamp);
  }
  return db;
}

test("Stripe workers claim and recover only their own mode, preserving foreign queued, delayed and expired jobs exactly",async()=>{
  for(const mode of["stripe_test","stripe_live"]){
    const db=mixedJobs();let moneyRequests=0;
    const moneyRequest=async()=>{moneyRequests++;throw Error("Fixture must not make a financial provider request");};
    const config={paymentProviderMode:mode,stripePlatformAccountId:"acct_platform",paymentProviderWebhookSecret:"whsec_platform",paymentProviderConnectWebhookSecret:"whsec_connect",financialRemediesEnabled:true,orderExpiryMinutes:15,now:()=>new Date(stamp),stripeProvider:{mode,retrievePlatformAccount:async()=>({status:"confirmed",providerReference:"acct_platform",mode}),createTransfer:moneyRequest,refundPayment:moneyRequest,reverseTransfer:moneyRequest}};
    try{
      const foreign=mode==="stripe_test"?"stripe_live":"stripe_test";
      const snapshot=()=>({jobs:db.prepare("SELECT * FROM marketplace_worker_jobs WHERE id LIKE ? ORDER BY id").all(`${foreign}:%`),operations:db.prepare("SELECT * FROM marketplace_operations WHERE provider_mode=? ORDER BY id").all(foreign)});
      const before=snapshot(),result=await runStripeConnectWorker(db,config,{limit:100});
      assert.deepEqual(snapshot(),before,`${mode} must not claim, terminalize or rewrite ${foreign} history`);
      assert.equal(result.claimed,10,"Nine current-mode movement jobs plus one lazy refund are inspected");
      for(const kind of["stripe_transfer","stripe_refund","stripe_transfer_reversal"]){
        const id=`${mode}:${kind}:exhausted`;
        assert.equal(db.prepare("SELECT status FROM marketplace_worker_jobs WHERE id=?").get(id).status,"failed");
        assert.equal(db.prepare("SELECT status FROM marketplace_operations WHERE operation_key=?").get(id).status,"failed");
      }
      assert.equal(db.prepare("SELECT attempts FROM marketplace_worker_jobs WHERE id=?").get(`${mode}:unmaterialized`).attempts,1);
      assert.equal(moneyRequests,0);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
    }finally{db.close();}
  }
});

test("discounted delivery captures once and transfers the saved merchant net, including free commission and platform-funded vouchers",async()=>{
  for(const scenario of[{free:false,voucher:0},{free:true,voucher:0},{free:false,voucher:500}]){
    let paymentState="authorized",orderId,restaurantId,chargeAmount,captureCalls=0,transferCalls=0;
    const commission=scenario.free?0:91,net=1300-commission;
    const facts=()=>({ok:true,status:"confirmed",providerReference:"pi_money",paymentIntentId:"pi_money",paymentState,captureMethod:"manual",amountMinor:chargeAmount,currency:"GBP",orderId,restaurantId,latestChargeId:paymentState==="captured"?"ch_money":null,providerCostMinor:37});
    const adapter={retrievePlatformAccount:async()=>({status:"confirmed",providerReference:"acct_platform"}),createCheckoutSession:async input=>{chargeAmount=input.amountMinor;return{...facts(),providerReference:"cs_money",checkoutUrl:"https://checkout.stripe.com/c/pay/cs_money"};},retrieveCheckoutSession:async()=>facts(),retrievePayment:async()=>facts(),capturePayment:async input=>{captureCalls++;assert.equal(input.amountMinor,1300-scenario.voucher);paymentState="captured";return facts();},refreshConnectedAccount:async()=>({status:"confirmed",providerReference:"acct_restaurant",chargesEnabled:true,payoutsEnabled:true,capabilities:["card_payments","transfers"]}),createTransfer:async input=>{transferCalls++;assert.equal(input.amountMinor,net);assert.equal(input.platformFunded,Boolean(scenario.voucher));assert.equal(input.sourceTransactionId,scenario.voucher?null:"ch_money");return{ok:true,status:"confirmed",providerReference:"tr_money",amountMinor:input.amountMinor,currency:"GBP",destinationAccountId:input.destinationAccountId,sourceTransactionId:input.sourceTransactionId,transferGroup:input.transferGroup};}};
    const f=await journeyFixture({paymentProviderMode:"stripe_test",paymentProvider:adapter,stripePlatformAccountId:"acct_platform",paymentProviderWebhookSecret:"whsec_platform",paymentProviderConnectWebhookSecret:"whsec_connect",orderAlertEmail:{mode:"off"},now:()=>new Date(stamp)});
    try{
      const owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),customer=await f.login("customer@calai.local","LocalCustomer!4310"),admin=await f.login("admin@calai.local","LocalAdmin!4310"),restaurant=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0],item=(await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];restaurantId=restaurant.id;
      const call=async(route,options)=>{const response=await f.json(route,options);assert.ok(response.status<300,response.text);return response.body.data;};
      f.db.prepare("UPDATE menu_items SET price_minor=1500 WHERE id=?").run(item.id);
      f.db.prepare("UPDATE restaurants SET delivery_enabled=1,delivery_outcodes='[\"LU1\"]',delivery_fee_minor=200,min_delivery_subtotal_minor=0 WHERE id=?").run(restaurantId);
      f.db.prepare("INSERT INTO provider_accounts VALUES('money-account',?,'stripe_test','enabled',?,'[]','acct_restaurant',?,?)").run(restaurantId,JSON.stringify(["card_payments","transfers"]),stamp,stamp);
      f.db.prepare("INSERT INTO stripe_account_readiness VALUES(?,'stripe_test','acct_restaurant',1,1,?)").run(restaurantId,stamp);
      if(scenario.free)await call(`/api/admin/restaurants/${restaurantId}/commission`,{method:"PATCH",cookie:admin,body:{action:"disable",expectedRevision:0}});
      await call("/api/account/marketing-preferences",{method:"PATCH",cookie:customer,body:{inAppPromotions:true,pushPromotions:false,source:"money-flow-fixture"}});
      const campaign=await call(`/api/restaurant/restaurants/${restaurantId}/loyalty/promotions`,{method:"POST",cookie:owner,headers:{"Idempotency-Key":"money-promotion"},body:{title:"Four pounds off",message:"Fixture restaurant offer",offerType:"fixed_off",campaignType:"amount_order",value:400,minSubtotalMinor:0,startsAt:"2026-01-01T00:00:00Z",expiresAt:"2026-01-10T00:00:00Z",redemptionLimit:1,budgetMinor:10000,eligibleItemIds:[],eligibleCategories:[],recipientSegment:"first_order",customerIds:[],stackingPolicy:"exclusive",fundingParty:"restaurant"}});
      const offer=await call(`/api/promotions/${campaign.id}/claim`,{method:"POST",cookie:customer,body:{}});
      let voucherId=null;
      if(scenario.voucher){const userId=f.db.prepare("SELECT id FROM users WHERE email='customer@calai.local'").get().id;voucherId=(await call(`/api/admin/customers/${userId}/vouchers`,{method:"POST",cookie:admin,headers:{"Idempotency-Key":"money-voucher"},body:{title:"Cal-Eats credit",message:"Fixture credit",amountMinor:scenario.voucher,expiresAt:"2026-01-10T00:00:00Z",reason:"Fixture customer credit"}})).id;}
      const basket={restaurantId,items:[{menuItemId:item.id,quantity:1}],paymentMethod:"card",fulfillment:"delivery",deliveryAddress:{line1:"10 Fixture Road",city:"Luton",postcode:"LU1 2AB"},offerId:offer.id,...(voucherId?{voucherId}:{})};
      const quote=await call("/api/orders/quote",{method:"POST",cookie:customer,body:basket});
      assert.equal(quote.subtotalMinor,1100);assert.equal(quote.deliveryFeeMinor,200);assert.equal(quote.commission.baseMinor,1300);assert.equal(quote.commissionMinor,commission);
      const order=await call("/api/orders",{method:"POST",cookie:customer,headers:{"Idempotency-Key":"money-order"},body:{...basket,expectedTotalMinor:1300-scenario.voucher}});orderId=order.id;
      assert.equal(order.totalMinor,1300);assert.equal(order.commissionMinor,commission);assert.equal(order.customerPayableMinor,1300-scenario.voucher);
      await call(`/api/orders/${orderId}/checkout`,{method:"POST",cookie:customer,headers:{"Idempotency-Key":"money-checkout"},body:{}});
      await call(`/api/orders/${orderId}/payment/refresh`,{method:"POST",cookie:customer,body:{}});
      const status=value=>call(`/api/restaurant/orders/${orderId}/status`,{method:"PATCH",cookie:owner,body:{status:value}});
      await status("accepted");await status("accepted");assert.equal(captureCalls,1);
      for(const value of["preparing","ready","out_for_delivery","completed"])await status(value);
      assert.equal(queueEligibleStripeTransfers(f.db,f.config).queued,1);assert.equal(queueEligibleStripeTransfers(f.db,f.config).queued,0);
      assert.equal((await runStripeConnectWorker(f.db,f.config)).completed,1);await runStripeConnectWorker(f.db,f.config);
      assert.equal(transferCalls,1);assert.equal(captureCalls,1);
      assert.equal(f.db.prepare("SELECT amount_minor FROM marketplace_operations WHERE order_id=? AND kind='merchant_transfer'").get(orderId).amount_minor,net);
      assert.equal(f.db.prepare("SELECT amount_minor FROM marketplace_operations WHERE order_id=? AND kind='provider_cost'").get(orderId).amount_minor,37,"Processing costs are recorded for Cal-Eats, not deducted again from the merchant");
      assert.equal(f.db.prepare("SELECT COUNT(*) n FROM marketplace_operations WHERE order_id=? AND kind='payment_capture'").get(orderId).n,1);
    }finally{await f.close();}
  }
});
