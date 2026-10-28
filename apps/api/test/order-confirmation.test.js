import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { journeyFixture } from "./helpers.js";
import { runOrderConfirmationAlerts } from "../src/order-confirmation.js";
import { notifyNewOrder } from "../src/offers.js";
import { createOrderAlertEmailAdapter, loadOrderAlertEmailConfig } from "../src/order-alert-email.js";
import { openDatabase, closeDatabase } from "../src/db/index.js";
import { runExpiryWorker } from "../src/operations.js";

async function setup() {
  let stamp=Date.parse("2026-01-01T01:00:00.000Z");
  const f=await journeyFixture({now:()=>new Date(stamp),sessionHours:24*60,orderAlertEmail:{mode:"local",recipient:"owner@example.invalid"}});
  const owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),customer=await f.login("customer@calai.local","LocalCustomer!4310"),admin=await f.login("admin@calai.local","LocalAdmin!4310"),restaurant=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0],item=(await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
  let index=0;
  return {...f,owner,customer,admin,restaurant,set(value){stamp=value;},get stamp(){return stamp;},async place(delivery=false){const result=await f.json("/api/orders",{method:"POST",cookie:customer,headers:{"Idempotency-Key":`confirmation-fixture-${index++}`},body:{restaurantId:restaurant.id,items:[{menuItemId:item.id,quantity:1}],paymentMethod:"cash",fulfillment:delivery?"delivery":"collection",...(delivery?{deliveryAddress:{line1:"10 Fictional Demo Street",city:"Luton",postcode:"LU1 2AB"}}:{})}});assert.equal(result.status,201,result.text);return result.body.data;}};
}

test("confirmation commits the customer ETA once and emits confirmed/out-for-delivery updates",async()=>{
  const f=await setup();try{
    const order=await f.place(true),visible=f.stamp,eta=new Date(visible+45*60000).toISOString(),route=`/api/restaurant/orders/${order.id}/status`;
    assert.equal(order.customerEtaAt,null);assert.equal(order.merchantVisibleAt,new Date(visible).toISOString());assert.equal(order.confirmationDueAt,new Date(visible+180000).toISOString());
    const pending=await f.json(`/api/restaurant/orders/pending-confirmation?restaurantId=${f.restaurant.id}`,{cookie:f.owner});assert.equal(pending.body.data.total,1);
    const invalid=await f.json(route,{method:"PATCH",cookie:f.owner,body:{status:"accepted",estimatedReadyAt:"2025-12-31T00:00:00.000Z"}});assert.equal(invalid.status,400);assert.equal(f.db.prepare("SELECT status FROM orders WHERE id=?").get(order.id).status,"placed");
    const confirmed=await f.json(route,{method:"PATCH",cookie:f.owner,body:{status:"accepted",estimatedReadyAt:eta}});assert.equal(confirmed.status,200,confirmed.text);assert.equal(confirmed.body.data.customerEtaAt,eta);assert.equal(confirmed.body.data.customerEtaType,"delivery_arrival");assert.equal(confirmed.body.data.confirmedAt,new Date(visible).toISOString());
    const replay=await f.json(route,{method:"PATCH",cookie:f.owner,body:{status:"accepted",estimatedReadyAt:new Date(visible+90*60000).toISOString()}});assert.equal(replay.body.data.customerEtaAt,eta);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM user_notifications WHERE order_id=? AND title='Order confirmed'").get(order.id).n,1);
    const changed=new Date(visible+60*60000).toISOString(),changedResponse=await f.json(`/api/restaurant/orders/${order.id}/preparation`,{method:"PATCH",cookie:f.owner,body:{estimatedReadyAt:changed}});assert.equal(changedResponse.body.data.customerEtaAt,changed);
    for(const status of["preparing","ready","out_for_delivery"])assert.equal((await f.json(route,{method:"PATCH",cookie:f.owner,body:{status}})).status,200);
    const notifications=(await f.json("/api/notifications",{cookie:f.customer})).body.data.items;assert.ok(notifications.some(n=>n.title==="Order confirmed"&&n.message.includes("Estimated delivery")));assert.ok(notifications.some(n=>n.title==="Out for delivery"));assert.ok(notifications.some(n=>n.type==="order_eta"));
    const collection=await f.place(),legacy=await f.json(`/api/restaurant/orders/${collection.id}/status`,{method:"PATCH",cookie:f.owner,body:{status:"accepted"}});assert.equal(legacy.body.data.customerEtaType,"collection_ready");assert.ok(Date.parse(legacy.body.data.customerEtaAt)>visible);
    const paged=await f.json(`/api/restaurant/restaurants/${f.restaurant.id}/orders?page=1&pageSize=1&status=accepted`,{cookie:f.owner});assert.equal(paged.body.data.items.length,1);assert.equal(paged.body.data.pagination.total,1);
    const card=await f.place();f.db.prepare("UPDATE orders SET payment_method='card',payment_status='stripe_authorized' WHERE id=?").run(card.id);
    const badCard=await f.json(`/api/restaurant/orders/${card.id}/status`,{method:"PATCH",cookie:f.owner,body:{status:"accepted",estimatedReadyAt:"not-a-date"}});assert.equal(badCard.status,400);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM stripe_order_decisions WHERE order_id=?").get(card.id).n,0);
  }finally{await f.close();}
});

test("3-minute escalation starts at merchant visibility, waits through 179 seconds, and deduplicates",async()=>{
  const f=await setup();try{
    const order=await f.place(),start=f.stamp,unpaid=await f.place();
    f.db.prepare("UPDATE orders SET payment_method='card',payment_status='stripe_pending',merchant_visible_at=NULL,confirmation_due_at=NULL,created_at=? WHERE id=?").run(new Date(start-3600000).toISOString(),unpaid.id);
    notifyNewOrder(f.db,f.db.prepare("SELECT * FROM orders WHERE id=?").get(unpaid.id),new Date(start).toISOString());assert.equal(f.db.prepare("SELECT merchant_visible_at FROM orders WHERE id=?").get(unpaid.id).merchant_visible_at,null);
    f.set(start+179000);assert.equal((await runOrderConfirmationAlerts(f.db,f.config)).queued,0);
    f.set(start+180000);const first=await runOrderConfirmationAlerts(f.db,f.config);assert.equal(first.queued,1);assert.equal(first.localSaved,1);assert.equal(f.db.prepare("SELECT status FROM order_confirmation_email_outbox WHERE order_id=?").get(order.id).status,"local_saved");
    await runOrderConfirmationAlerts(f.db,f.config);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM order_confirmation_email_outbox").get().n,1);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM user_notifications WHERE order_id=? AND type='order_unconfirmed'").get(order.id).n,1);
    assert.equal(fs.readdirSync(f.config.orderAlertEmail.localDirectory).filter(name=>name.endsWith(".eml")).length,1);
    const authorisedAt=start+3600000;f.set(authorisedAt);f.db.prepare("UPDATE orders SET payment_status='stripe_authorized' WHERE id=?").run(unpaid.id);notifyNewOrder(f.db,f.db.prepare("SELECT * FROM orders WHERE id=?").get(unpaid.id),new Date(authorisedAt).toISOString());
    assert.equal(f.db.prepare("SELECT merchant_visible_at FROM orders WHERE id=?").get(unpaid.id).merchant_visible_at,new Date(authorisedAt).toISOString());
    f.set(authorisedAt+179000);assert.equal((await runOrderConfirmationAlerts(f.db,f.config)).queued,0);f.set(authorisedAt+180000);assert.equal((await runOrderConfirmationAlerts(f.db,f.config)).queued,1);
    const admin=await f.json("/api/admin/order-confirmation-alerts",{cookie:f.admin});assert.equal(admin.body.data.email.realDeliveryEnabled,false);assert.equal(admin.body.data.summary.local_saved,2);
  }finally{await f.close();}
});

test("confirmation, rejection and expiry after claim cancel an unsent escalation",async()=>{
  const f=await setup();try{
    let sends=0;const adapter=async(_message,{beforeSend})=>{if(!beforeSend())return{status:"cancelled"};sends++;return{status:"sent"};};
    for(const target of["accepted","rejected","expired"]){
      const order=await f.place(),created=f.stamp;f.set(created+180000);
      await runOrderConfirmationAlerts(f.db,f.config,{adapter,beforeDispatch:async row=>{assert.equal(row.order_id,order.id);if(target==="expired"){f.set(created+16*60000);runExpiryWorker(f.db,f.config);}else{const result=await f.json(`/api/restaurant/orders/${order.id}/status`,{method:"PATCH",cookie:f.owner,body:{status:target}});assert.equal(result.status,200,result.text);}}});
      assert.equal(f.db.prepare("SELECT status FROM order_confirmation_email_outbox WHERE order_id=?").get(order.id).status,"cancelled");
    }
    assert.equal(sends,0);
  }finally{await f.close();}
});

test("failed and ambiguous email outcomes remain visible without blind resend across lease recovery",async()=>{
  const f=await setup();let recoveryDb;try{
    const failed=await f.place();f.set(f.stamp+180000);let failures=0;
    await runOrderConfirmationAlerts(f.db,f.config,{adapter:async()=>{failures++;return{status:"failed",errorCode:"EAUTH"};}});await runOrderConfirmationAlerts(f.db,f.config,{adapter:async()=>{failures++;return{status:"sent"};}});assert.equal(failures,1);assert.equal(f.db.prepare("SELECT status FROM order_confirmation_email_outbox WHERE order_id=?").get(failed.id).status,"failed");
    const ambiguous=await f.place();f.set(f.stamp+180000);let release,startedResolve;const started=new Promise(resolve=>{startedResolve=resolve;});
    const pending=runOrderConfirmationAlerts(f.db,f.config,{adapter:async(_message,{beforeSend})=>{assert.equal(beforeSend(),true);startedResolve();return await new Promise(resolve=>{release=resolve;});}});await started;
    f.set(f.stamp+120001);recoveryDb=openDatabase(f.config.dbPath);let retries=0;
    await runOrderConfirmationAlerts(recoveryDb,f.config,{adapter:async()=>{retries++;return{status:"sent"};}});assert.equal(retries,0);assert.equal(recoveryDb.prepare("SELECT status FROM order_confirmation_email_outbox WHERE order_id=?").get(ambiguous.id).status,"unknown");
    release({status:"sent"});await pending;assert.equal(f.db.prepare("SELECT status FROM order_confirmation_email_outbox WHERE order_id=?").get(ambiguous.id).status,"unknown");
    const state=(await f.json("/api/admin/order-confirmation-alerts",{cookie:f.admin})).body.data;assert.equal(state.summary.failed,1);assert.equal(state.summary.unknown,1);assert.equal(JSON.stringify(state).includes("password"),false);
  }finally{if(recoveryDb)closeDatabase(recoveryDb);await f.close();}
});

test("SMTP adapter requires explicit safe TLS configuration and treats uncertain transport errors as unknown",async()=>{
  assert.throws(()=>loadOrderAlertEmailConfig({mode:"smtp",host:"attacker.invalid"},"fixture.sqlite",{}),/approved host/);
  const settings=loadOrderAlertEmailConfig({mode:"smtp",recipient:"owner@example.invalid",from:"sender@example.invalid",host:"smtp.ionos.co.uk",port:465,user:"sender@example.invalid",password:"fixture-only",enabled:true},"fixture.sqlite",{}),message={id:"test-id",to:"owner@example.invalid",from:"sender@example.invalid",subject:"Unconfirmed demo order",text:"No customer details",messageId:"<cal-eats-order-alert-test-id@calai.info>"};
  let calls=0;const sender=createOrderAlertEmailAdapter(settings,{transportFactory:options=>{assert.equal(options.secure,true);assert.equal(options.requireTLS,true);assert.equal(options.tls.rejectUnauthorized,true);return{async sendMail(){calls++;const error=new Error("Do not expose raw transport details");error.code="ETIMEDOUT";throw error;}};}});
  assert.equal((await sender(message,{beforeSend:()=>false})).status,"cancelled");assert.equal(calls,0);assert.equal((await sender(message,{beforeSend:()=>true})).status,"unknown");assert.equal(calls,1);
});
