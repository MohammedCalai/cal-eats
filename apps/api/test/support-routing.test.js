import assert from "node:assert/strict";
import test from "node:test";
import {DatabaseSync} from "node:sqlite";
import {journeyFixture} from "./helpers.js";
import {buildCustomerEmail,runCustomerTransactionalEmails} from "../src/customer-emails.js";
import {migrations} from "../src/db/migrations.js";
import {seedDemoData} from "../src/seed.js";

test("business support goes to admin, keeps both reply directions, and sends role-correct service email once",async()=>{
 const f=await journeyFixture({orderAlertEmail:{mode:"local",from:"caleats-support@calai.info"}});
 try{
  const owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),admin=await f.login("admin@calai.local","LocalAdmin!4310"),other=await f.login("restaurant2@calai.local","LocalRestaurant2!4310"),customer=await f.login("customer@calai.local","LocalCustomer!4310");
  const restaurant=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0],foreign=(await f.json("/api/restaurant/restaurants",{cookie:other})).body.data[0];
  const request={method:"POST",cookie:owner,headers:{"Idempotency-Key":"business-support-request"},body:{subject:"Business platform help",message:"Private original business message",restaurantId:restaurant.id}};
  assert.equal((await f.json("/api/support",{...request,body:{...request.body,restaurantId:foreign.id}})).status,404);
  const created=await f.json("/api/support",request);assert.equal(created.status,201,created.text);const ticket=created.body.data;
  assert.equal((await f.json("/api/support",request)).body.data.id,ticket.id);assert.equal(ticket.assignedTo,"platform");assert.equal(ticket.recipient,"Cal-Eats support");assert.equal(ticket.restaurantId,null);assert.equal(ticket.requesterRestaurantName,restaurant.name);
  assert.equal((await f.json(`/api/restaurant/restaurants/${restaurant.id}/support?page=1`,{cookie:owner})).body.data.total,0);
  const dashboard=await f.json("/api/admin/support?page=1&pageSize=5&assignedTo=platform&status=open&waitingFor=team",{cookie:admin});assert.equal(dashboard.body.data.total,1);assert.equal(dashboard.body.data.items[0].id,ticket.id);
  for(const cookie of [other,customer])assert.equal((await f.json(`/api/support/${ticket.id}`,{cookie})).status,404);
  const reply=(cookie,key,message)=>f.json(`/api/support/${ticket.id}/messages`,{method:"POST",cookie,headers:{"Idempotency-Key":key},body:{message}});
  assert.equal((await reply(owner,"owner-followup-01","Private business follow-up")).status,201);
  assert.equal((await reply(admin,"admin-followup-01","Private platform answer")).status,201);assert.equal((await reply(admin,"admin-followup-01","Private platform answer")).status,200);
  const thread=(await f.json(`/api/support/${ticket.id}`,{cookie:owner})).body.data;assert.equal(thread.message,request.body.message);assert.deepEqual(thread.messages.map(x=>x.message),["Private business follow-up","Private platform answer"]);assert.equal(thread.waitingFor,"customer");assert.equal(thread.isTeam,false);
  const latest=(await f.json(`/api/support/${ticket.id}?limit=1`,{cookie:owner})).body.data;assert.ok(latest.nextCursor);const older=(await f.json(`/api/support/${ticket.id}?limit=1&${new URLSearchParams(latest.nextCursor)}`,{cookie:owner})).body.data;assert.equal(older.messages[0].message,"Private business follow-up");
  await f.json(`/api/support/${ticket.id}`,{cookie:admin,method:"PATCH",body:{status:"resolved"}});
  const rows=f.db.prepare("SELECT * FROM customer_transactional_email_outbox ORDER BY rowid").all();assert.equal(rows.length,5);assert.deepEqual(rows.map(r=>r.recipient),["admin@calai.local","restaurant@calai.local","admin@calai.local","restaurant@calai.local","restaurant@calai.local"]);
  for(const row of rows){const mail=buildCustomerEmail(row,f.config);assert.equal(/Private (original|business|platform)/.test(mail.text+mail.html+row.payload),false);assert.ok(mail.text.includes(`/business/${row.recipient.startsWith("admin")?"admin":"owner"}/support?case=${ticket.id}`));}
  const sent=await runCustomerTransactionalEmails(f.db,f.config);assert.equal(sent.localSaved,5);assert.equal((await runCustomerTransactionalEmails(f.db,f.config)).localSaved,0);
  await reply(admin,"admin-followup-02","Another private answer");f.db.prepare("UPDATE users SET account_enabled=0 WHERE email='restaurant@calai.local'").run();
  let unsafe=0;const cancelled=await runCustomerTransactionalEmails(f.db,f.config,{adapter:async()=>{unsafe++;return{status:"sent"};}});assert.equal(unsafe,0);assert.equal(cancelled.cancelled,1);
 }finally{await f.close();}
});

test("support migration preserves original requests, replies and uncertain emails without sending historical mail",async()=>{
 const db=new DatabaseSync(":memory:");try{
  db.exec("PRAGMA foreign_keys=ON");for(const m of migrations.filter(m=>m.version<29))db.exec(m.sql);await seedDemoData(db,new Date("2026-01-01"));
  const owner=db.prepare("SELECT id FROM users WHERE email='restaurant@calai.local'").get(),restaurant=db.prepare("SELECT restaurant_id id FROM restaurant_memberships WHERE user_id=?").get(owner.id);
  db.prepare("INSERT INTO support_cases(id,user_id,restaurant_id,subject,message,status,created_at,updated_at,waiting_for) VALUES('legacy',?,?, 'Business request','Keep original message','open','2026-01-01','2026-01-01','team')").run(owner.id,restaurant.id);
  db.prepare("INSERT INTO support_case_messages VALUES('reply','legacy',?,'restaurant','legacy-reply','hash','ciphertext','nonce','tag','v1','2026-01-01')").run(owner.id);
  db.prepare("INSERT INTO customer_transactional_email_outbox(id,customer_id,source_key,event_kind,recipient,payload,message_id,mode,status,queued_at,updated_at,dispatch_started_at) VALUES('email',?,'old-email','support_reply','owner@example.invalid','{}','old-message-id','local','unknown','2026-01-01','2026-01-01','2026-01-01')").run(owner.id);
  db.exec(migrations.find(m=>m.version===29).sql);
  const ticket=db.prepare("SELECT * FROM support_cases WHERE id='legacy'").get();assert.equal(ticket.restaurant_id,null);assert.equal(ticket.requester_restaurant_id,restaurant.id);assert.equal(ticket.message,"Keep original message");assert.equal(db.prepare("SELECT ciphertext FROM support_case_messages").get().ciphertext,"ciphertext");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM customer_transactional_email_outbox").get().n,1);assert.equal(db.prepare("SELECT status FROM customer_transactional_email_outbox").get().status,"unknown");assert.ok(db.prepare("SELECT 1 FROM user_notifications n JOIN users u ON u.id=n.user_id WHERE u.role='admin' AND n.support_case_id='legacy'").get());assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
 }finally{db.close();}
});
