import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import {journeyFixture} from "./helpers.js";
import {buildRestaurantCommissionEmail,enqueueRestaurantCommissionEmails,runRestaurantCommissionEmails} from "../src/restaurant-commission-emails.js";

async function setup(){
  let now=Date.parse("2026-01-01T01:00:00.000Z");
  const f=await journeyFixture({now:()=>new Date(now),orderAlertEmail:{mode:"local",from:"caleats-support@calai.info"},businessStatements:{sendEnabled:false}});
  const admin=await f.login("admin@calai.local","LocalAdmin!4310"),owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),customer=await f.login("customer@calai.local","LocalCustomer!4310"),restaurant=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0];
  const route=`/api/admin/restaurants/${restaurant.id}/commission`;
  return {...f,admin,owner,customer,restaurant,route,setNow(value){now=Date.parse(value);},change(body,cookie=admin){return f.json(route,{method:"PATCH",cookie,body});}};
}
const freePeriod={startsAt:"2026-03-22T09:30:00.000Z",endsAt:"2026-03-29T08:30:00.000Z"};
const schedule=(revision=0,period=freePeriod)=>({action:"schedule_free",expectedRevision:revision,freePeriod:period});
const outbox=db=>db.prepare("SELECT o.*,e.restaurant_id,e.settings_revision,e.kind,e.payload FROM restaurant_commission_email_outbox o JOIN restaurant_commission_email_events e ON e.id=o.event_id ORDER BY o.queued_at,o.rowid").all();

test("commission scheduling atomically queues the actual owner once, rejects stale/other roles, and rolls back on queue failure",async()=>{
  const f=await setup();try{
    assert.equal((await f.json(f.route,{cookie:f.admin})).body.data.confirmationEmail,null);
    for(const cookie of[f.owner,f.customer])assert.equal((await f.change(schedule(),cookie)).status,403);
    assert.equal((await f.change({...schedule(),freePeriod:{startsAt:"bad",endsAt:freePeriod.endsAt}})).status,400);
    assert.equal(outbox(f.db).length,0);
    // If durable queueing fails, neither the financial setting nor its audit can commit.
    f.db.exec("CREATE TRIGGER fail_commission_email BEFORE INSERT ON restaurant_commission_email_outbox BEGIN SELECT RAISE(ABORT,'fixture queue failure'); END");
    assert.equal((await f.change(schedule())).status,500);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM restaurant_commission_controls").get().n,0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM restaurant_commission_email_events").get().n,0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE entity_type='restaurant_commission'").get().n,0);
    f.db.exec("DROP TRIGGER fail_commission_email");
    const first=await f.change(schedule());assert.equal(first.status,200,first.text);assert.deepEqual(first.body.data.confirmationEmail,{status:"queued",recipientCount:1,sentCount:0,pendingCount:1,localSavedCount:0});
    const rows=outbox(f.db);assert.equal(rows.length,1);assert.equal(rows[0].recipient,"restaurant@calai.local");assert.equal(rows[0].restaurant_id,f.restaurant.id);assert.equal(rows[0].settings_revision,1);
    const original=JSON.parse(rows[0].payload);enqueueRestaurantCommissionEmails(f.db,f.config,{restaurantId:f.restaurant.id,revision:1,before:original.before,after:original.after,normalRateBasisPoints:700,now:f.config.now().toISOString()});assert.equal(outbox(f.db).length,1);assert.equal(outbox(f.db)[0].status,"pending");
    assert.equal((await f.change(schedule())).status,409);
    assert.equal((await f.change(schedule(1))).body.data.revision,1);assert.equal(outbox(f.db).length,1);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE entity_type='restaurant_commission'").get().n,1);
    const beforeRows=outbox(f.db).length;assert.equal((await f.json(f.route,{cookie:f.owner})).status,403);assert.equal(outbox(f.db).length,beforeRows);
    // Current owner is required: staff/customer memberships never become recipients.
    await f.change({action:"cancel_free",expectedRevision:1});
    f.db.prepare("DELETE FROM restaurant_memberships WHERE restaurant_id=? AND permission='owner'").run(f.restaurant.id);
    const missingOwner=await f.change(schedule(2));assert.equal(missingOwner.status,200,missingOwner.text);assert.equal(missingOwner.body.data.confirmationEmail.status,"unavailable");assert.equal(missingOwner.body.data.confirmationEmail.recipientCount,0);
  }finally{await f.close();}
});

test("branded commission mail renders exact UK dates across DST and uses the approved shared transport without marketing consent",async()=>{
  const f=await setup();try{
    f.db.prepare("UPDATE restaurants SET name=? WHERE id=?").run("Village <Tandoori> & Kitchen",f.restaurant.id);
    await f.change(schedule());const row=outbox(f.db)[0],mail=buildRestaurantCommissionEmail(row,f.config);
    assert.match(mail.text,/Sunday, 22 March 2026 at 09:30 GMT/);assert.match(mail.text,/Sunday, 29 March 2026 at 09:30 BST/);
    assert.match(mail.text,/normal commission resumes automatically/);assert.match(mail.text,/current normal rate is 7%/);assert.match(mail.text,/0% on new orders placed/);
    assert.ok(!mail.html.includes("<Tandoori>"));assert.match(mail.html,/&lt;Tandoori&gt; &amp; Kitchen/);assert.equal(mail.from,"caleats-support@calai.info");
    assert.equal((await runRestaurantCommissionEmails(f.db,f.config)).localSaved,1);
    assert.equal((await runRestaurantCommissionEmails(f.db,f.config)).localSaved,0);
    assert.equal((await f.json(f.route,{cookie:f.admin})).body.data.confirmationEmail.status,"local_saved");
    const files=fs.readdirSync(f.config.orderAlertEmail.localDirectory).filter(name=>name.endsWith(".eml"));assert.deepEqual(files,[`${row.id}.eml`]);
    const saved=fs.readFileSync(`${f.config.orderAlertEmail.localDirectory}/${row.id}.eml`,"utf8");assert.match(saved,/Message-ID: <cal-eats-commission-email-/);assert.match(saved,/multipart\/alternative/);
  }finally{await f.close();}
});

test("commission mail retries definitive failure, never repeats accepted or ambiguous sends, and recovers leases conservatively",async()=>{
  const f=await setup();try{
    await f.change(schedule());let attempts=0;
    const adapter=async(message,{beforeSend})=>{attempts++;assert.equal(beforeSend(),true);return attempts===1?{status:"failed",errorCode:"GRAPH_HTTP_429"}:{status:"sent"};};
    assert.equal((await runRestaurantCommissionEmails(f.db,f.config,{adapter})).failed,1);assert.equal(outbox(f.db)[0].next_attempt_at,"2026-01-01T01:01:00.000Z");
    await runRestaurantCommissionEmails(f.db,f.config,{adapter});assert.equal(attempts,1);
    f.setNow("2026-01-01T01:01:00.000Z");
    const [a,b]=await Promise.all([runRestaurantCommissionEmails(f.db,f.config,{adapter}),runRestaurantCommissionEmails(f.db,f.config,{adapter})]);assert.equal(a.sent,1);assert.equal(b.sent,1);assert.equal(attempts,2);
    await runRestaurantCommissionEmails(f.db,f.config,{adapter});assert.equal(attempts,2);assert.equal((await f.json(f.route,{cookie:f.admin})).body.data.confirmationEmail.status,"sent");
    await f.change(schedule(1,{...freePeriod,endsAt:"2026-04-05T08:30:00.000Z"}));
    let ambiguousCalls=0;const uncertain=async(message,{beforeSend})=>{ambiguousCalls++;assert.equal(beforeSend(),true);throw new Error("fixture network outcome unknown");};
    assert.equal((await runRestaurantCommissionEmails(f.db,f.config,{adapter:uncertain})).unknown,1);
    f.setNow("2026-01-01T02:01:00.000Z");await runRestaurantCommissionEmails(f.db,f.config,{adapter:uncertain});assert.equal(ambiguousCalls,1);assert.equal(outbox(f.db).at(-1).next_attempt_at,null);
    await f.change(schedule(2,{...freePeriod,endsAt:"2026-04-12T08:30:00.000Z"}));
    let row=outbox(f.db).at(-1);f.db.prepare("UPDATE restaurant_commission_email_outbox SET status='claimed',lease_owner='dead-worker',lease_expires_at=?,dispatch_started_at=NULL WHERE id=?").run("2026-01-01T02:00:00.000Z",row.id);
    assert.equal((await runRestaurantCommissionEmails(f.db,f.config,{adapter})).sent,1);
    await f.change(schedule(3,{...freePeriod,endsAt:"2026-04-19T08:30:00.000Z"}));
    row=outbox(f.db).at(-1);f.db.prepare("UPDATE restaurant_commission_email_outbox SET status='claimed',lease_owner='dead-worker',lease_expires_at=?,dispatch_started_at=? WHERE id=?").run("2026-01-01T02:00:00.000Z","2026-01-01T01:59:00.000Z",row.id);
    const before=attempts;await runRestaurantCommissionEmails(f.db,f.config,{adapter});assert.equal(attempts,before);assert.equal(outbox(f.db).at(-1).status,"unknown");
  }finally{await f.close();}
});

test("superseded schedules and changed ownership cannot send; latest changes and cancellation have accurate confirmations",async()=>{
  const f=await setup();try{
    await f.change(schedule());await f.change(schedule(1,{...freePeriod,endsAt:"2026-04-05T08:30:00.000Z"}));
    assert.equal(outbox(f.db)[0].status,"cancelled");assert.equal(outbox(f.db)[1].kind,"updated");
    let calls=0;
    const adapter=async(message,{beforeSend})=>{calls++;assert.equal(beforeSend(),true);return{status:"sent"};};
    await runRestaurantCommissionEmails(f.db,f.config,{adapter,beforeDispatch:async()=>{f.db.prepare("UPDATE users SET email='changed@calai.local' WHERE email='restaurant@calai.local'").run();}});
    assert.equal(calls,0);assert.equal(outbox(f.db)[1].last_error,"COMMISSION_EMAIL_OWNER_CHANGED");
    await f.change({action:"cancel_free",expectedRevision:2});let row=outbox(f.db).at(-1);assert.equal(row.kind,"cancelled");assert.match(buildRestaurantCommissionEmail(row,f.config).text,/normal 7% commission applies to new orders from now/);
    assert.equal((await runRestaurantCommissionEmails(f.db,f.config,{adapter})).sent,1);assert.equal(calls,1);
    await f.change(schedule(3));
    const racingAdapter=async(message,{beforeSend})=>{await f.change({action:"disable",expectedRevision:4});assert.equal(beforeSend(),false);return{status:"cancelled"};};
    await runRestaurantCommissionEmails(f.db,f.config,{adapter:racingAdapter,limit:1});assert.equal(outbox(f.db).at(-2).status,"cancelled");
    row=outbox(f.db).at(-1);assert.equal(row.kind,"disabled");assert.match(buildRestaurantCommissionEmail(row,f.config).text,/0%.*until the Cal-Eats team changes/);
    assert.equal((await runRestaurantCommissionEmails(f.db,f.config,{adapter})).sent,1);
    await f.change(schedule(5));
    const latest=outbox(f.db).at(-1);let adapterCalled=false;
    // A second source check occurs after the adapter's asynchronous preparation.
    await runRestaurantCommissionEmails(f.db,f.config,{adapter:async(message,{beforeSend})=>{adapterCalled=true;f.db.prepare("UPDATE restaurant_memberships SET permission='staff' WHERE restaurant_id=? AND user_id=?").run(f.restaurant.id,latest.user_id);assert.equal(beforeSend(),false);return{status:"cancelled"};}});
    assert.equal(adapterCalled,true);assert.equal(outbox(f.db).at(-1).status,"cancelled");
    f.db.prepare("UPDATE restaurant_memberships SET permission='owner' WHERE restaurant_id=? AND user_id=?").run(f.restaurant.id,latest.user_id);
    await f.change(schedule(6,{...freePeriod,endsAt:"2026-04-26T08:30:00.000Z"}));
    let changedTransportCalls=0;
    await runRestaurantCommissionEmails(f.db,{...f.config,orderAlertEmail:{...f.config.orderAlertEmail,mode:"graph"}},{adapter:async()=>{changedTransportCalls++;return{status:"sent"};}});
    assert.equal(changedTransportCalls,0);assert.equal(outbox(f.db).at(-1).last_error,"COMMISSION_EMAIL_TRANSPORT_CHANGED");
  }finally{await f.close();}
});
