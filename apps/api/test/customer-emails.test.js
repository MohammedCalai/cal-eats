import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { journeyFixture } from "./helpers.js";
import { addNotification } from "../src/offers.js";
import { buildCustomerEmail, runCustomerTransactionalEmails } from "../src/customer-emails.js";
import { customerEmailMigration27 } from "../src/customer-email-migration.js";
import { orderConfirmationMigration26 } from "../src/order-confirmation-migration.js";

async function setup() {
  let stamp=Date.parse("2026-01-01T01:00:00.000Z"),index=0;
  const f=await journeyFixture({now:()=>new Date(stamp),orderAlertEmail:{mode:"local",from:"caleats-support@calai.info"}});
  const owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),customer=await f.login("customer@calai.local","LocalCustomer!4310"),admin=await f.login("admin@calai.local","LocalAdmin!4310");
  const restaurant=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0],item=(await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
  return {...f,owner,customer,admin,restaurant,set(value){stamp=value;},async place(){const r=await f.json("/api/orders",{method:"POST",cookie:customer,headers:{"Idempotency-Key":`customer-email-order-${index++}`},body:{restaurantId:restaurant.id,items:[{menuItemId:item.id,quantity:1}],paymentMethod:"cash",fulfillment:"delivery",deliveryAddress:{line1:"10 Private Fixture Street",city:"Luton",postcode:"LU1 2AB"}}});assert.equal(r.status,201,r.text);return r.body.data;},async confirm(order){const r=await f.json(`/api/restaurant/orders/${order.id}/status`,{method:"PATCH",cookie:owner,body:{status:"accepted",estimatedReadyAt:new Date(stamp+45*60000).toISOString()}});assert.equal(r.status,200,r.text);return r.body.data;}};
}

test("confirmation, ETA and order progress queue once for the actual customer and render branded private local mail",async()=>{
  const f=await setup();try{
    const order=await f.place();f.db.prepare("UPDATE users SET merchant_offers=0 WHERE id=?").run(order.customerId);
    await f.confirm(order);await f.confirm(order);
    let rows=f.db.prepare("SELECT * FROM customer_transactional_email_outbox").all();assert.equal(rows.length,1);assert.equal(rows[0].customer_id,order.customerId);
    assert.equal(rows[0].recipient,"customer@calai.local");assert.equal(JSON.parse(rows[0].payload).order.etaAt,"2026-01-01T01:45:00.000Z");
    const eta=await f.json(`/api/restaurant/orders/${order.id}/preparation`,{method:"PATCH",cookie:f.owner,body:{estimatedReadyAt:"2026-01-01T01:55:00.000Z"}});assert.equal(eta.status,200,eta.text);
    for(const status of["preparing","ready","out_for_delivery"])assert.equal((await f.json(`/api/restaurant/orders/${order.id}/status`,{method:"PATCH",cookie:f.owner,body:{status}})).status,200);
    addNotification(f.db,{userId:order.customerId,type:"offer",title:"Marketing",message:"Not a service email",restaurantId:f.restaurant.id,eventKey:"offer:fixture",now:f.config.now().toISOString()});
    rows=f.db.prepare("SELECT * FROM customer_transactional_email_outbox").all();assert.equal(rows.length,5);assert.ok(rows.some(row=>JSON.parse(row.payload).orderStatus==="out_for_delivery"));
    const mail=buildCustomerEmail(rows[0],f.config);assert.match(mail.html,/YOUR CAL-EATS UPDATE/);assert.match(mail.html,/Estimated arrival/);assert.match(mail.html,/caleats-support@calai.info/);assert.match(mail.subject,/Order confirmed/);assert.match(mail.text,/test\/simulated payments/);assert.match(mail.text,new RegExp(`orderId=${order.id}`));
    for(const row of rows)assert.equal(row.payload.includes("Private Fixture Street"),false);
    const result=await runCustomerTransactionalEmails(f.db,f.config);assert.equal(result.localSaved,5);assert.equal((await runCustomerTransactionalEmails(f.db,f.config)).localSaved,0);
    const files=fs.readdirSync(f.config.orderAlertEmail.localDirectory);assert.equal(files.filter(name=>name.endsWith(".eml")).length,5);assert.match(fs.readFileSync(`${f.config.orderAlertEmail.localDirectory}/${rows[0].id}.eml`,"utf8"),/multipart\/alternative/);
    const admin=await f.json("/api/admin/customer-emails",{cookie:f.admin});assert.equal(admin.body.data.summary.local_saved,5);assert.equal(admin.body.data.email.realDeliveryEnabled,false);assert.equal(JSON.stringify(admin.body.data).includes("customer@calai.local"),false);
    assert.equal((await f.json("/api/admin/customer-emails",{cookie:f.customer})).status,403);assert.equal((await f.json("/api/admin/customer-emails",{cookie:f.owner})).status,403);
    const unsafe=JSON.parse(rows[0].payload);unsafe.order.items[0].name="<script>private</script>";const escaped=buildCustomerEmail({...rows[0],payload:JSON.stringify(unsafe)},f.config);assert.equal(escaped.html.includes("<script>private"),false);assert.ok(escaped.html.includes("&lt;script&gt;private"));
  }finally{await f.close();}
});

test("restaurant chats and support replies send recipient-isolated service notices without copying message bodies",async()=>{
  const f=await setup();try{
    const order=await f.place(),route=`/api/restaurant/restaurants/${f.restaurant.id}/customers/${order.customerId}/conversation`,secret="Sensitive dietary discussion stays inside the encrypted app",request={method:"POST",cookie:f.owner,headers:{"Idempotency-Key":"service-crm-001"},body:{message:secret}};
    const first=await f.json(route,request);assert.equal(first.status,201,first.text);assert.equal((await f.json(route,request)).status,200);
    const thread=await f.json(`/api/customer/conversations/${first.body.data.threadId}/messages`,{cookie:f.customer});assert.equal(thread.body.data.thread.restaurantName,f.restaurant.name);
    assert.equal((await f.json(`/api/customer/conversations/${first.body.data.threadId}/messages`,{method:"POST",cookie:f.customer,headers:{"Idempotency-Key":"service-crm-reply"},body:{message:"Customer response should not email back to themselves"}})).status,201);
    const orderMessage=await f.json(`/api/orders/${order.id}/messages`,{method:"POST",cookie:f.owner,headers:{"Idempotency-Key":"service-order-001"},body:{message:secret}});assert.equal(orderMessage.status,201,orderMessage.text);
    const support=await f.json("/api/support",{method:"POST",cookie:f.customer,headers:{"Idempotency-Key":"service-help-001"},body:{subject:"A test help request",message:secret,orderId:order.id}});assert.equal(support.status,201,support.text);
    const reply=await f.json(`/api/support/${support.body.data.id}/messages`,{method:"POST",cookie:f.owner,headers:{"Idempotency-Key":"service-help-reply"},body:{message:secret}});assert.equal(reply.status,201,reply.text);
    const rows=f.db.prepare("SELECT * FROM customer_transactional_email_outbox ORDER BY queued_at,rowid").all();assert.deepEqual(rows.map(row=>row.event_kind),["customer_message","order_message","support_update","support_update","support_reply"]);
    assert.equal(rows[2].recipient,"restaurant@calai.local");assert.equal(JSON.parse(rows[2].payload).notificationType,"support_request");
    for(const row of rows){if(row!==rows[2]){assert.equal(row.customer_id,order.customerId);assert.equal(row.recipient,"customer@calai.local");}assert.equal(row.payload.includes(secret),false);const rendered=buildCustomerEmail(row,f.config);assert.equal(rendered.text.includes(secret),false);assert.equal(rendered.html.includes(secret),false);assert.match(rendered.text,/Open securely in Cal-Eats/);}
    assert.match(buildCustomerEmail(rows[0],f.config).text,new RegExp(`conversationId=${first.body.data.threadId}`));assert.match(buildCustomerEmail(rows[1],f.config).text,/messages=1/);assert.match(buildCustomerEmail(rows[4],f.config).text,new RegExp(`supportCaseId=${support.body.data.id}`));
    let sends=0;await runCustomerTransactionalEmails(f.db,f.config,{adapter:async(_mail,{beforeSend})=>{assert.equal(beforeSend(),true);sends++;return{status:"unknown",errorCode:"NETWORK_UNCERTAIN"};}});await runCustomerTransactionalEmails(f.db,f.config,{adapter:async()=>{sends++;return{status:"sent"};}});assert.equal(sends,5);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM customer_transactional_email_outbox WHERE status='unknown'").get().n,5);
    // Persist the state of a process that died after beginning provider submission.
    f.db.prepare("UPDATE customer_transactional_email_outbox SET status='claimed',lease_owner='crashed-worker',lease_expires_at='2026-01-01T01:02:00.000Z' WHERE id=?").run(rows[0].id);f.set(Date.parse("2026-01-01T01:02:00.001Z"));
    await runCustomerTransactionalEmails(f.db,f.config,{adapter:async()=>{sends++;return{status:"sent"};}});assert.equal(sends,5);assert.equal(f.db.prepare("SELECT status,last_error FROM customer_transactional_email_outbox WHERE id=?").get(rows[0].id).last_error,"EMAIL_LEASE_EXPIRED_AFTER_DISPATCH");
    const next=await f.json(route,{...request,headers:{"Idempotency-Key":"service-crm-002"}});assert.equal(next.status,201,next.text);
    let unsafeSends=0;await runCustomerTransactionalEmails(f.db,f.config,{beforeDispatch:()=>f.db.prepare("DELETE FROM restaurant_memberships WHERE restaurant_id=?").run(f.restaurant.id),adapter:async()=>{unsafeSends++;return{status:"sent"};}});assert.equal(unsafeSends,0);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM customer_transactional_email_outbox WHERE status='cancelled'").get().n,1);
  }finally{await f.close();}
});

test("migration preserves queued owner alerts when adding graph, and undispatched changed recipients are cancelled",async()=>{
  const old=new DatabaseSync(":memory:");try{
    old.exec("CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE orders(id TEXT PRIMARY KEY); CREATE TABLE restaurants(id TEXT PRIMARY KEY); INSERT INTO orders VALUES('order'); INSERT INTO restaurants VALUES('restaurant');");
    old.exec(orderConfirmationMigration26.sql.slice(orderConfirmationMigration26.sql.indexOf("CREATE TABLE order_confirmation_email_outbox")));
    old.prepare("INSERT INTO order_confirmation_email_outbox VALUES('alert','order','restaurant','owner@example.invalid','Subject','Body','<cal-eats-order-alert-alert@calai.info>','local','pending',NULL,NULL,NULL,0,NULL,'2026-01-01',NULL,'2026-01-01')").run();
    old.exec(customerEmailMigration27.sql);assert.equal(old.prepare("SELECT body FROM order_confirmation_email_outbox").get().body,"Body");old.prepare("UPDATE order_confirmation_email_outbox SET mode='graph'").run();assert.equal(old.prepare("SELECT mode FROM order_confirmation_email_outbox").get().mode,"graph");
  }finally{old.close();}
  const f=await setup();try{
    const order=await f.place();await f.confirm(order);let sends=0;
    await runCustomerTransactionalEmails(f.db,f.config,{beforeDispatch:()=>f.db.prepare("UPDATE users SET email='changed@example.invalid' WHERE id=?").run(order.customerId),adapter:async()=>{sends++;return{status:"sent"};}});
    assert.equal(sends,0);const row=f.db.prepare("SELECT status,last_error,dispatch_started_at FROM customer_transactional_email_outbox").get();assert.equal(row.status,"cancelled");assert.equal(row.last_error,"CUSTOMER_RECIPIENT_CHANGED_OR_DISABLED");assert.equal(row.dispatch_started_at,null);
  }finally{await f.close();}
});
