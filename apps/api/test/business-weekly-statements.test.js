import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { journeyFixture } from "./helpers.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { buildBusinessStatementEmail, buildWeeklyStatementSnapshot, initializeBusinessWeeklyStatements, nextWeeklyStatementAt, runBusinessWeeklyStatements, weeklyStatementPeriod } from "../src/business-weekly-statements.js";
import { createOrderAlertEmailAdapter } from "../src/order-alert-email.js";
import { createGraphMailAdapter } from "../src/graph-mail.js";

test("weekly schedules use next Monday at 09:00 UK time and full DST calendar weeks", () => {
  assert.equal(nextWeeklyStatementAt(new Date("2026-03-25T12:00:00Z")), "2026-03-30T08:00:00.000Z");
  const spring = weeklyStatementPeriod("2026-03-30T08:00:00.000Z");
  assert.equal(spring.fromDate,"2026-03-23"); assert.equal(spring.toDate,"2026-03-29");
  assert.equal(Date.parse(spring.toExclusive)-Date.parse(spring.from),167*3600000);
  assert.equal(nextWeeklyStatementAt(new Date("2026-10-21T12:00:00Z")), "2026-10-26T09:00:00.000Z");
  const autumn=weeklyStatementPeriod("2026-10-26T09:00:00.000Z");
  assert.equal(Date.parse(autumn.toExclusive)-Date.parse(autumn.from),169*3600000);
  assert.equal(nextWeeklyStatementAt(new Date("2026-10-26T08:00:00Z")),"2026-10-26T09:00:00.000Z");
  assert.equal(nextWeeklyStatementAt(new Date("2026-10-26T09:00:00Z")),"2026-11-02T09:00:00.000Z");
});

async function fixture() {
  let stamp=Date.parse("2026-10-21T12:00:00.000Z");
  const f=await journeyFixture({now:()=>new Date(stamp),sessionHours:24*60,businessStatements:{sendEnabled:false}});
  const owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),customer=await f.login("customer@calai.local","LocalCustomer!4310"),other=await f.login("restaurant2@calai.local","LocalRestaurant2!4310");
  const restaurant=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0],item=(await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
  initializeBusinessWeeklyStatements(f.db,f.config);
  f.db.prepare("UPDATE business_statement_preferences SET enabled=0 WHERE restaurant_id<>?").run(restaurant.id);
  let sequence=0;
  return {...f,owner,customer,other,restaurant,item,root:`/api/restaurant/restaurants/${restaurant.id}/weekly-statements`,set(value){stamp=Date.parse(value);},async place(paymentMethod="cash"){
    const response=await f.json("/api/orders",{method:"POST",cookie:customer,headers:{"Idempotency-Key":`weekly-order-${sequence++}`},body:{restaurantId:restaurant.id,items:[{menuItemId:item.id,quantity:1}],paymentMethod,fulfillment:"collection"}});
    assert.equal(response.status,201,response.text);
    for(const status of["accepted","preparing","ready","completed"])assert.equal((await f.json(`/api/restaurant/orders/${response.body.data.id}/status`,{method:"PATCH",cookie:owner,body:{status}})).status,200);
    return response.body.data;
  }};
}

test("one weekly owner statement includes old-order refunds, honest cash/transfers, local CSV and scoped downloads",async()=>{
  const f=await fixture();try{
    assert.equal((await runBusinessWeeklyStatements(f.db,f.config)).queued,0,"Activation must not backfill old weeks");
    f.set("2026-10-14T12:00:00Z");const old=await f.place("mock_card");
    f.set("2026-10-21T12:00:00Z");const cash=await f.place(),card=await f.place("mock_card");
    const actor=f.db.prepare("SELECT id FROM users WHERE email='restaurant@calai.local'").get().id;
    f.db.prepare("INSERT INTO refunds VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(),old.id,actor,"weekly-old-refund","fixture",100,0,"Weekly fixture","simulated_card",7,f.config.now().toISOString());
    const transferId=randomUUID();
    f.db.prepare("INSERT INTO marketplace_operations(id,operation_key,restaurant_id,order_id,kind,status,amount_minor,currency,provider_mode,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(transferId,"weekly-transfer",f.restaurant.id,card.id,"merchant_transfer","confirmed",500,"GBP","local_simulator","{}","2026-10-14T12:00:00.000Z",f.config.now().toISOString());
    const group=randomUUID();
    for(const[account,direction]of[["merchant_available","debit"],["connected_account_funds","credit"]])f.db.prepare("INSERT INTO journal_postings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(),group,"weekly-transfer",f.restaurant.id,card.id,account,direction,500,"GBP","merchant_transfer",transferId,"local_simulator",f.config.now().toISOString());
    f.db.prepare("INSERT INTO stripe_connected_payouts VALUES(?,?,?,?,?,?,?,?,?)").run("po_historical_refreshed",f.restaurant.id,"acct_fixture",900,"paid","2026-10-12T00:00:00.000Z",null,"2026-10-10T00:00:00.000Z",f.config.now().toISOString());
    const period=weeklyStatementPeriod("2026-10-26T09:00:00Z"),snapshot=buildWeeklyStatementSnapshot(f.db,f.restaurant.id,period,f.config);
    assert.equal(snapshot.summary.ordersPlaced,2);assert.equal(snapshot.summary.grossSalesMinor,cash.totalMinor+card.totalMinor);
    assert.equal(snapshot.summary.refundsMinor,100);assert.equal(snapshot.summary.cashCollectedMinor,cash.totalMinor);
    assert.equal(snapshot.summary.connectedBalanceTransfersMinor,500);assert.equal(snapshot.summary.bankPayoutRecordedMinor,0);
    assert.ok(snapshot.csv.includes(old.id));assert.ok(snapshot.csv.includes("merchant_transfer_confirmed"));assert.equal(snapshot.csv.includes("customer@calai.local"),false);
    f.set("2026-10-26T08:59:59Z");assert.equal((await runBusinessWeeklyStatements(f.db,f.config)).queued,0);
    f.set("2026-10-26T09:00:00Z");const first=await runBusinessWeeklyStatements(f.db,f.config);assert.equal(first.queued,1);assert.equal(first.localSaved,1);
    assert.equal((await runBusinessWeeklyStatements(f.db,f.config)).queued,0);
    const history=await f.json(f.root,{cookie:f.owner});assert.equal(history.status,200,history.text);assert.equal(history.body.data.items.length,1);
    const row=history.body.data.items[0];assert.equal(row.status,"local_saved");
    assert.equal((await f.request(row.downloadUrl,{cookie:f.owner})).text,snapshot.csv);
    assert.equal((await f.request(row.downloadUrl,{cookie:f.customer})).status,403);assert.equal((await f.request(row.downloadUrl,{cookie:f.other})).status,404);
    const settings=(await f.json(`${f.root}/settings`,{cookie:f.owner})).body.data;assert.equal(settings.email.realDeliveryEnabled,false);assert.equal(settings.nextScheduledAt,"2026-11-02T09:00:00.000Z");
    assert.equal((await f.json(`${f.root}/settings`,{method:"PATCH",cookie:f.owner,body:{enabled:false,recipient:"other@example.invalid"}})).status,400);
    const eml=fs.readFileSync(path.join(f.config.orderAlertEmail.localDirectory,"business-statements",`${row.id}.eml`),"utf8");
    assert.ok(eml.includes("multipart/mixed"));assert.ok(eml.includes("Content-Disposition: attachment"));assert.ok(eml.includes("Cal-Eats-weekly-2026-10-19.csv"));
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length,0);
  }finally{await f.close();}
});

test("weekly delivery revalidates ownership and never blindly resends after a dispatch lease expires",async()=>{
  const f=await fixture();let recovery;try{
    f.set("2026-10-26T09:00:00Z");let sends=0;
    const cancelled=await runBusinessWeeklyStatements(f.db,f.config,{beforeDispatch:async()=>{f.db.prepare("UPDATE users SET email='changed@example.invalid' WHERE email='restaurant@calai.local'").run();},adapter:async()=>{sends++;return{status:"sent"};}});
    assert.equal(cancelled.cancelled,1);assert.equal(sends,0);
    f.set("2026-11-02T09:00:00Z");let release,startedResolve;const started=new Promise(resolve=>{startedResolve=resolve;});
    const pending=runBusinessWeeklyStatements(f.db,f.config,{adapter:async(_message,{beforeSend})=>{assert.equal(beforeSend(),true);sends++;startedResolve();return await new Promise(resolve=>{release=resolve;});}});
    await started;f.set("2026-11-02T09:02:01Z");recovery=openDatabase(f.config.dbPath);
    await runBusinessWeeklyStatements(recovery,f.config,{adapter:async()=>{sends++;return{status:"sent"};}});
    assert.equal(sends,1);assert.equal(f.db.prepare("SELECT status FROM business_weekly_statement_outbox WHERE week_from='2026-10-26'").get().status,"unknown");
    release({status:"sent"});await pending;
    assert.equal(f.db.prepare("SELECT status FROM business_weekly_statement_outbox WHERE week_from='2026-10-26'").get().status,"unknown");
  }finally{if(recovery)closeDatabase(recovery);await f.close();}
});

test("archived businesses never queue or send weekly statements while historical CSV stays available",async()=>{
  const f=await fixture();try{
    await f.place("mock_card");
    const period=weeklyStatementPeriod("2026-10-26T09:00:00Z"),snapshot=buildWeeklyStatementSnapshot(f.db,f.restaurant.id,period,f.config);
    const userId=f.db.prepare("SELECT id FROM users WHERE email='restaurant@calai.local'").get().id;
    const retained=[],unsent=[];
    for(const[status,week]of[["sent","2026-09-07"],["local_saved","2026-09-14"],["unknown","2026-09-21"],["pending","2026-09-28"],["failed","2026-10-05"],["claimed","2026-10-12"]]){
      const id=randomUUID(),dispatched=["sent","local_saved","unknown"].includes(status);
      f.db.prepare("INSERT INTO business_weekly_statement_outbox(id,restaurant_id,user_id,recipient,week_from,week_to,summary,csv,message_id,mode,status,lease_owner,lease_expires_at,dispatch_started_at,queued_at,sent_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,f.restaurant.id,userId,"restaurant@calai.local",week,week,JSON.stringify(snapshot.summary),snapshot.csv,`<${id}@calai.info>`,"local",status,status==="claimed"?"expired-worker":null,status==="claimed"?"2026-10-26T08:00:00.000Z":null,dispatched?"2026-10-20T09:00:00.000Z":null,"2026-10-20T08:00:00.000Z",["sent","local_saved"].includes(status)?"2026-10-20T09:00:00.000Z":null,"2026-10-20T09:00:00.000Z");
      (dispatched?retained:unsent).push(id);
    }
    const historyBefore=retained.map(id=>f.db.prepare("SELECT * FROM business_weekly_statement_outbox WHERE id=?").get(id));
    // A removed preference must not be recreated automatically for an archived owner.
    f.db.prepare("DELETE FROM business_statement_preferences WHERE restaurant_id<>?").run(f.restaurant.id);
    const preferencesBefore=f.db.prepare("SELECT * FROM business_statement_preferences ORDER BY restaurant_id,user_id").all();
    f.set("2026-10-26T09:00:00Z");
    f.db.prepare("UPDATE restaurants SET archived_at=?").run(f.config.now().toISOString());
    let sends=0;
    const result=await runBusinessWeeklyStatements(f.db,f.config,{adapter:async()=>{sends++;return{status:"sent"};}});
    assert.equal(result.queued,0);assert.equal(result.sent,0);assert.equal(result.localSaved,0);assert.equal(result.cancelled,3);assert.equal(sends,0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM business_weekly_statement_outbox").get().n,6);
    assert.deepEqual(f.db.prepare("SELECT * FROM business_statement_preferences ORDER BY restaurant_id,user_id").all(),preferencesBefore);
    assert.deepEqual(retained.map(id=>f.db.prepare("SELECT * FROM business_weekly_statement_outbox WHERE id=?").get(id)),historyBefore);
    for(const id of unsent){const row=f.db.prepare("SELECT * FROM business_weekly_statement_outbox WHERE id=?").get(id);assert.equal(row.status,"cancelled");assert.equal(row.last_error,"STATEMENT_RESTAURANT_ARCHIVED");assert.equal(row.csv,snapshot.csv);assert.equal(row.summary,JSON.stringify(snapshot.summary));}
    const history=await f.json(f.root,{cookie:f.owner});assert.equal(history.status,200,history.text);assert.equal(history.body.data.items.length,6);
    const download=await f.request(`${f.root}/${retained[0]}.csv`,{cookie:f.owner});assert.equal(download.status,200);assert.equal(download.text,snapshot.csv);
    assert.deepEqual(buildWeeklyStatementSnapshot(f.db,f.restaurant.id,period,f.config),snapshot);
    // Archiving after the adapter starts must still fail its final pre-send check.
    f.db.prepare("UPDATE restaurants SET archived_at=NULL WHERE id=?").run(f.restaurant.id);
    const race=await runBusinessWeeklyStatements(f.db,f.config,{limit:1,adapter:async(_message,{beforeSend})=>{
      f.db.prepare("UPDATE restaurants SET archived_at=? WHERE id=?").run(f.config.now().toISOString(),f.restaurant.id);
      assert.equal(beforeSend(),false);
      return{status:"cancelled"};
    }});
    assert.equal(race.queued,1);assert.equal(race.sent,0);assert.equal(sends,0);
    const cancelled=f.db.prepare("SELECT * FROM business_weekly_statement_outbox WHERE week_from='2026-10-19'").get();
    assert.equal(cancelled.status,"cancelled");assert.equal(cancelled.last_error,"STATEMENT_RESTAURANT_ARCHIVED");assert.equal(cancelled.dispatch_started_at,null);
    assert.equal((await runBusinessWeeklyStatements(f.db,f.config,{adapter:async()=>{sends++;return{status:"sent"};}})).queued,0);
    assert.equal(sends,0);assert.deepEqual(buildWeeklyStatementSnapshot(f.db,f.restaurant.id,period,f.config),snapshot);
    assert.deepEqual(retained.map(id=>f.db.prepare("SELECT * FROM business_weekly_statement_outbox WHERE id=?").get(id)),historyBefore);
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length,0);
  }finally{await f.close();}
});

test("bounded statement CSV is transmitted by mail adapters without file or URL attachments",async()=>{
  const f=await fixture();try{
    const snapshot=buildWeeklyStatementSnapshot(f.db,f.restaurant.id,weeklyStatementPeriod("2026-10-26T09:00:00Z"),f.config),id=randomUUID();
    const message=buildBusinessStatementEmail({id,restaurant_id:f.restaurant.id,recipient:"owner@example.invalid",week_from:"2026-10-19",week_to:"2026-10-25",summary:JSON.stringify(snapshot.summary),csv:snapshot.csv,message_id:`<cal-eats-business-statement-${id}@calai.info>`},f.config);
    let smtpPayload;
    const smtp=createOrderAlertEmailAdapter({...f.config.orderAlertEmail,mode:"smtp",enabled:true,host:"smtp.ionos.co.uk",port:465,user:f.config.orderAlertEmail.from,password:"fixture-only"},{transportFactory:()=>({async sendMail(payload){smtpPayload=payload;return{accepted:[message.to]};}})});
    assert.equal((await smtp(message)).status,"sent");assert.equal(smtpPayload.attachments[0].content.toString(),snapshot.csv);assert.equal(smtpPayload.disableFileAccess,true);
    assert.equal((await smtp({...message,attachments:[{filename:"bad.csv",contentType:"text/csv",path:"C:/private"}]})).errorCode,"EMAIL_ATTACHMENT_INVALID");
    assert.equal((await smtp({...message,attachments:[{filename:"large.csv",contentType:"text/csv",contentBase64:Buffer.alloc(1024*1024+1).toString("base64")}]})).errorCode,"EMAIL_ATTACHMENT_INVALID");
    const graphSettings={...f.config.orderAlertEmail.graph,enabled:true,tenantId:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",clientId:"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",sender:message.from,signInUser:message.from,cacheFile:path.join(f.directory,"fake-mail.cache"),keyFile:path.join(f.directory,"fake-mail.key")};
    fs.writeFileSync(graphSettings.cacheFile,"fixture");fs.writeFileSync(graphSettings.keyFile,"fixture");let graphPayload;
    const graph=createGraphMailAdapter(graphSettings,{clientFactory:async()=>({getTokenCache:()=>({getAllAccounts:async()=>[{username:message.from}]}),acquireTokenSilent:async()=>({accessToken:"TEST_ONLY",scopes:["Mail.Send"]})}),fetchImpl:async(_url,request)=>{graphPayload=JSON.parse(request.body);return{status:202};}});
    assert.equal((await graph(message)).status,"sent");assert.equal(graphPayload.message.attachments[0].contentBytes,message.attachments[0].contentBase64);
    assert.equal(graphPayload.message.attachments[0]["@odata.type"],"#microsoft.graph.fileAttachment");
    const oversized=buildBusinessStatementEmail({...{id,restaurant_id:f.restaurant.id,recipient:message.to,week_from:"2026-10-19",week_to:"2026-10-25",summary:JSON.stringify(snapshot.summary),message_id:message.messageId},csv:"a".repeat(1024*1024+1)},f.config);
    assert.equal(oversized.attachments,undefined);assert.ok(oversized.text.includes(`/weekly-statements/${id}.csv`));
  }finally{await f.close();}
});
