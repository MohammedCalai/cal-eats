import test from "node:test";
import assert from "node:assert/strict";
import {journeyFixture} from "./helpers.js";
import {queueBusinessApplicationAdminAlerts,runCustomerTransactionalEmails,buildCustomerEmail} from "../src/customer-emails.js";

const application={name:"Applicant Fixture",email:"applicant-alert@example.test",restaurantName:"Fixture <Kitchen>",address:"12 Market Street, London E1 1AA",mobile:"07700 900123"};
const request={method:"POST",headers:{"Idempotency-Key":"application-admin-alert-fixture-001"},body:application};
async function setup(){return journeyFixture({orderAlertEmail:{recipient:"admin@calai.local"},rateLimit:{attempts:100,windowMs:60000}});}

test("one application atomically queues separate applicant and configured-administrator acknowledgements with one private bell alert",async()=>{
  const f=await setup();try{
    const created=await f.json("/api/auth/restaurant-register",request);assert.equal(created.status,201,created.text);const rid=created.body.data.restaurantId;
    const admin=f.db.prepare("SELECT id FROM users WHERE role='admin' AND email='admin@calai.local'").get();
    let rows=f.db.prepare("SELECT * FROM customer_transactional_email_outbox WHERE event_kind='business_application'").all();assert.equal(rows.length,2);
    const alert=rows.find(r=>JSON.parse(r.payload).recipientRole==="admin"),applicant=rows.find(r=>r.id!==alert.id);assert.equal(alert.recipient,"admin@calai.local");assert.equal(alert.customer_id,admin.id);assert.equal(applicant.recipient,application.email);
    const notice=f.db.prepare("SELECT * FROM user_notifications WHERE event_key=?").get(`business-application:${rid}:admin-received`);assert.equal(notice.user_id,admin.id);assert.equal(notice.type,"business_application_received");assert.equal(notice.restaurant_id,rid);assert.equal(notice.message.includes(application.mobile),false);
    const mail=buildCustomerEmail(alert,f.config);for(const value of [application.name,application.email,application.mobile,application.address])assert.ok(mail.text.includes(value));assert.match(mail.html,/Fixture &lt;Kitchen&gt;/);assert.ok(mail.text.includes(`/business/admin/restaurants?restaurant=${rid}&section=access`));
    assert.equal(buildCustomerEmail(applicant,f.config).text.includes(application.mobile),false);
    const replay=await f.json("/api/auth/restaurant-register",request);assert.equal(replay.status,200,replay.text);
    for(let i=0;i<2;i++)assert.equal(queueBusinessApplicationAdminAlerts(f.db,f.config,{restaurantId:rid}).emailId,alert.id);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM user_notifications WHERE type='business_application_received'").get().n,1);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM customer_transactional_email_outbox WHERE event_kind='business_application'").get().n,2);
    const sent=[];const result=await runCustomerTransactionalEmails(f.db,f.config,{adapter:async(message,{beforeSend})=>{assert.equal(beforeSend(),true);sent.push(message.to);return{status:"sent"};}});assert.equal(result.sent,2);assert.deepEqual(sent.sort(),["admin@calai.local",application.email].sort());
  }finally{await f.close();}
});

test("queued administrator mail revalidates the configured active genuine administrator and never redirects or broadcasts applicant contacts",async()=>{
  const f=await setup();try{
    const created=await f.json("/api/auth/restaurant-register",request);assert.equal(created.status,201,created.text);const rid=created.body.data.restaurantId;
    f.config.orderAlertEmail.recipient=application.email;
    assert.equal(queueBusinessApplicationAdminAlerts(f.db,f.config,{restaurantId:rid}),null,"An applicant cannot become the configured administrator recipient");
    const sent=[];const outcome=await runCustomerTransactionalEmails(f.db,f.config,{adapter:async(message,{beforeSend})=>{assert.equal(beforeSend(),true);sent.push(message.to);return{status:"sent"};}});
    assert.equal(outcome.cancelled,1);assert.deepEqual(sent,[application.email]);
    const alert=f.db.prepare("SELECT status,last_error FROM customer_transactional_email_outbox WHERE json_extract(payload,'$.recipientRole')='admin'").get();assert.equal(alert.status,"cancelled");assert.equal(alert.last_error,"APPLICATION_ADMIN_RECIPIENT_CHANGED");
    f.config.orderAlertEmail.recipient="admin@calai.local";f.db.prepare("UPDATE users SET account_enabled=0 WHERE role='admin'").run();
    assert.equal(queueBusinessApplicationAdminAlerts(f.db,f.config,{restaurantId:rid}),null);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM user_notifications WHERE type='business_application_received'").get().n,1);
    assert.equal(queueBusinessApplicationAdminAlerts(f.db,f.config,{restaurantId:"unrelated-missing-restaurant"}),null);
  }finally{await f.close();}
});
