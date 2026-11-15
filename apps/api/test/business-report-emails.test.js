import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID,createHash} from "node:crypto";
import {journeyFixture} from "./helpers.js";
import {runBusinessReportEmails} from "../src/business-report-emails.js";
import {migrateDatabase} from "../src/db/index.js";
import {createOrderAlertEmailAdapter} from "../src/order-alert-email.js";

async function setup(){
  let clock=Date.parse("2026-01-01T01:00:00.000Z");const f=await journeyFixture({now:()=>new Date(clock),rateLimit:{attempts:200,windowMs:60000}});
  const owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),other=await f.login("restaurant2@calai.local","LocalRestaurant2!4310"),admin=await f.login("admin@calai.local","LocalAdmin!4310"),customer=await f.login("customer@calai.local","LocalCustomer!4310");
  const restaurant=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0],base=`/api/restaurant/restaurants/${restaurant.id}`,actor=f.db.prepare("SELECT id,email FROM users WHERE email='restaurant@calai.local'").get();
  const request=(reportPath,key=`report-email-${randomUUID()}`,cookie=owner,extra={})=>f.json("/api/restaurant/report-emails",{method:"POST",cookie,headers:{"Idempotency-Key":key},body:{reportPath,...extra}});
  return {...f,owner,other,admin,customer,restaurant,base,actor,request,advance:ms=>clock+=ms};
}
const row=(f,id)=>f.db.prepare("SELECT * FROM business_report_email_outbox WHERE id=?").get(id);
const saveWeekly=(f,csv,scope="testing")=>{
  const id=randomUUID(),stamp=f.config.now().toISOString(),weekFrom=new Date(Date.parse("2025-12-22T00:00:00Z")-f.db.prepare("SELECT COUNT(*) n FROM business_weekly_statement_outbox").get().n*7*86400000).toISOString().slice(0,10);
  f.db.prepare("INSERT INTO business_weekly_statement_outbox(id,restaurant_id,user_id,recipient,week_from,week_to,summary,csv,message_id,mode,status,queued_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'local','local_saved',?,?)").run(id,f.restaurant.id,f.actor.id,f.actor.email,weekFrom,weekFrom,JSON.stringify({scope}),csv,`<cal-eats-business-statement-${id}@calai.info>`,stamp,stamp);return id;
};

test("business CSV emails require the requesting owner, whitelist sources/options and keep durable per-key retries",async()=>{
  const f=await setup();try{
    const target=`${f.base}/dashboard/metrics.csv?period=today`,key="report-owner-idempotence-001";
    for(const cookie of [f.admin,f.customer,f.other])assert.ok([403,404].includes((await f.request(target,`wrong-owner-${randomUUID()}`,cookie)).status));
    const made=await f.json(`${f.base}/staff`,{method:"POST",cookie:f.owner,body:{name:"Report staff",email:"report-staff@example.invalid",password:"ReportStaff!2026"}});assert.equal(made.status,201,made.text);
    const staff=await f.login("report-staff@example.invalid","ReportStaff!2026");assert.equal((await f.request(target,"report-staff-owner-required",staff)).status,403);
    for(const bad of ["https://evil.test/api/restaurant/report.csv","//evil.test/report.csv","/api/admin/dashboard/metrics.csv",`${target}&recipient=external@example.test`,`${target}&period=yesterday`,`${f.base}/finance/statement.csv?from=invalid`,`${f.base}/finance/statement.csv?scope=live`])assert.equal((await f.request(bad)).status,400,bad);
    assert.equal((await f.request(target,undefined,f.owner,{recipient:"external@example.test"})).status,400);
    const first=await f.request(target,key);assert.equal(first.status,202,first.text);assert.equal(first.body.data.recipient,f.actor.email);assert.equal(first.body.data.status,"pending");
    assert.equal((await f.request(target,key)).body.data.id,first.body.data.id);
    assert.equal((await f.request(`${f.base}/dashboard/orders.csv?period=today`,key)).status,409);
    assert.equal((await f.json(`/api/restaurant/report-emails/${first.body.data.id}`,{cookie:f.other})).status,404);
    assert.equal((await f.json(`/api/restaurant/report-emails/${first.body.data.id}`,{cookie:f.owner})).status,200);
    // A second deliberate key gets its own durable request even while A is
    // pending; losing B's HTTP response cannot later create a third email.
    const secondKey="report-owner-idempotence-002",second=await f.request(target,secondKey);assert.equal(second.status,202);assert.notEqual(second.body.data.id,first.body.data.id);
    let sent=0;await runBusinessReportEmails(f.db,f.config,{adapter:async(message,{beforeSend})=>{assert.equal(beforeSend(),true);sent++;return{status:"sent"};}});
    assert.equal(sent,2);assert.equal((await f.request(target,secondKey)).body.data.id,second.body.data.id);
    await runBusinessReportEmails(f.db,f.config,{adapter:async()=>{sent++;throw Error("Must not resend");}});assert.equal(sent,2);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM business_report_email_outbox").get().n,2);
    assert.equal(row(f,first.body.data.id).csv,null,"Terminal delivery drops its attachment snapshot");
  }finally{await f.close();}
});

test("all six report families attach exact scoped CSV snapshots without creating finance report jobs",async()=>{
  const f=await setup();try{
    const weekly=saveWeekly(f,"heading,value\r\nrecorded,42\r\n"),reportId=randomUUID(),stamp=f.config.now().toISOString();
    f.db.prepare("INSERT INTO marketplace_report_jobs VALUES(?,?,?,'finance_statement','completed',?,? ,NULL,?,?)").run(reportId,f.restaurant.id,f.actor.id,"fixture",Buffer.from("heading,value\r\nsaved,9\r\n"),stamp,stamp);
    const sources=[`${f.base}/dashboard/orders.csv?period=today`,`${f.base}/finance/statement.csv?scope=testing`,`${f.base}/weekly-statements/${weekly}.csv?scope=testing`,`/api/owner/business-payment-adjustments/export.csv?restaurantId=${f.restaurant.id}`,`${f.base}/menu-template.csv`,`/api/report-jobs/${reportId}/download`];
    const expected=new Map();
    for(const source of sources){f.advance(11*60000);const queued=await f.request(source);assert.equal(queued.status,202,queued.text);const saved=row(f,queued.body.data.id);expected.set(saved.id,saved.csv);assert.equal(saved.financial_scope,"testing");}
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM marketplace_report_jobs").get().n,1);
    const result=await runBusinessReportEmails(f.db,f.config,{adapter:async(message,{beforeSend})=>{
      assert.equal(message.to,f.actor.email);assert.equal(message.attachments.length,1);const csv=Buffer.from(message.attachments[0].contentBase64,"base64").toString();assert.equal(csv,expected.get(message.id));assert.match(message.attachments[0].filename,/\.csv$/);assert.equal(beforeSend(),true);return{status:"sent"};
    }});assert.equal(result.sent,6);
    const weeklyJob=f.db.prepare("SELECT * FROM business_report_email_outbox WHERE report_kind='weekly-statement'").get();assert.equal(weeklyJob.content_sha256,createHash("sha256").update("heading,value\r\nrecorded,42\r\n").digest("hex"));
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='report_email_requested'").get().n,6);
  }finally{await f.close();}
});

test("attachments are bounded and manual requests remain independent of weekly preferences",async()=>{
  const f=await setup();try{
    const id=saveWeekly(f,"x".repeat(1024*1024+1));
    assert.equal((await f.request(`${f.base}/weekly-statements/${id}.csv?scope=testing`)).status,413);
    const lines=saveWeekly(f,"heading\n"+"row\n".repeat(10001));assert.equal((await f.request(`${f.base}/weekly-statements/${lines}.csv?scope=testing`)).status,413);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM business_report_email_outbox").get().n,0);
    const settings=await f.json(`${f.base}/weekly-statements/settings`,{cookie:f.owner,method:"PATCH",body:{enabled:false}});assert.equal(settings.status,200,settings.text);
    assert.equal((await f.request(`${f.base}/menu-template.csv`)).status,202);
    assert.equal((await f.request(`${f.base}/dashboard/orders.csv?period=today`)).status,202);
    assert.equal((await f.request(`${f.base}/dashboard/metrics.csv?period=today`)).status,202);
    for(let index=0;index<7;index++)assert.equal((await f.request(`${f.base}/dashboard/metrics.csv?period=today`)).status,202);
    assert.equal((await f.request(`${f.base}/finance/statement.csv`)).status,429);
  }finally{await f.close();}
});

test("weekly attachments keep their saved live or testing scope and cannot cross the selected history",async()=>{
  const f=await setup();try{
    const testing=saveWeekly(f,"scope\r\ntesting\r\n","testing"),live=saveWeekly(f,"scope\r\nlive\r\n","live");
    assert.equal((await f.request(`${f.base}/weekly-statements/${live}.csv?scope=live`)).status,400);
    f.config.paymentProviderMode="stripe_live";
    assert.equal((await f.request(`${f.base}/weekly-statements/${testing}.csv?scope=live`)).status,404);
    assert.equal((await f.request(`${f.base}/weekly-statements/${live}.csv?scope=testing`)).status,404);
    const a=await f.request(`${f.base}/weekly-statements/${testing}.csv?scope=testing`),b=await f.request(`${f.base}/weekly-statements/${live}.csv?scope=live`);
    assert.equal(a.status,202,a.text);assert.equal(b.status,202,b.text);assert.equal(a.body.data.financialScope,"testing");assert.equal(b.body.data.financialScope,"live");
    assert.equal(row(f,a.body.data.id).csv,"scope\r\ntesting\r\n");assert.equal(row(f,b.body.data.id).csv,"scope\r\nlive\r\n");
  }finally{await f.close();}
});

test("owner changes, stale financial environments and ambiguous dispatches fail closed without resending",async()=>{
  const f=await setup();try{
    const first=await f.request(`${f.base}/menu-template.csv`);assert.equal(first.status,202);
    let calls=0;const changed=await runBusinessReportEmails(f.db,f.config,{beforeDispatch:()=>f.db.prepare("UPDATE users SET email='changed@example.test' WHERE id=?").run(f.actor.id),adapter:async()=>{calls++;return{status:"sent"};}});assert.equal(changed.cancelled,1);assert.equal(calls,0);
    f.db.prepare("UPDATE users SET email=? WHERE id=?").run(f.actor.email,f.actor.id);
    const target=`${f.base}/dashboard/metrics.csv?period=today`,key="uncertain-report-owner-001",queued=await f.request(target,key);assert.equal(queued.status,202);
    const outcome=await runBusinessReportEmails(f.db,f.config,{adapter:async(message,{beforeSend})=>{assert.equal(beforeSend(),true);calls++;return{status:"unknown",errorCode:"SMTP_NETWORK_UNCERTAIN"};}});assert.equal(outcome.unknown,1);
    assert.equal((await f.request(target,key)).body.data.status,"unknown");
    f.advance(11*60000);assert.equal((await f.request(target)).status,409);
    await runBusinessReportEmails(f.db,f.config,{adapter:async()=>{calls++;return{status:"sent"};}});assert.equal(calls,1);
    const third=await f.request(`${f.base}/finance/statement.csv`);assert.equal(third.status,202);
    f.config.paymentProviderMode="stripe_live";
    assert.equal((await runBusinessReportEmails(f.db,f.config,{adapter:async()=>{calls++;return{status:"sent"};}})).cancelled,1);assert.equal(calls,1);
  }finally{await f.close();}
});

test("expired claims distinguish pre-dispatch recovery from uncertain sends and delivery metadata expires after30days",async()=>{
  const f=await setup();try{
    const a=(await f.request(`${f.base}/menu-template.csv`)).body.data,b=(await f.request(`${f.base}/dashboard/metrics.csv`)).body.data,stamp=f.config.now().toISOString();
    f.db.prepare("UPDATE business_report_email_outbox SET status='claimed',lease_owner='dead-worker',lease_expires_at=? WHERE id IN (?,?)").run(stamp,a.id,b.id);
    f.db.prepare("UPDATE business_report_email_outbox SET dispatch_started_at=? WHERE id=?").run(stamp,b.id);
    let sends=0;await runBusinessReportEmails(f.db,f.config,{adapter:async(m,{beforeSend})=>{assert.equal(beforeSend(),true);sends++;return{status:"sent"};}});assert.equal(sends,1);assert.equal(row(f,a.id).status,"sent");assert.equal(row(f,b.id).status,"unknown");assert.equal(row(f,b.id).csv,null);
    f.advance(31*86400000);await runBusinessReportEmails(f.db,f.config,{adapter:async()=>{throw Error("Must not send");}});assert.equal(f.db.prepare("SELECT COUNT(*) n FROM business_report_email_outbox").get().n,0);
  }finally{await f.close();}
});

test("a populated contiguous schema62 upgrades to63 without changing customers or financial records",async()=>{
  const f=await setup();try{
    const item=(await f.json(`/api/restaurants/${f.restaurant.id}/menu`)).body.data.items[0];
    const placed=await f.json("/api/orders",{cookie:f.customer,method:"POST",headers:{"Idempotency-Key":"migration63-existing-order"},body:{restaurantId:f.restaurant.id,items:[{menuItemId:item.id,quantity:1}],fulfillment:"collection",paymentMethod:"mock_card"}});assert.equal(placed.status,201,placed.text);
    const stamp=f.config.now().toISOString();f.db.prepare("INSERT INTO marketplace_operations(id,operation_key,restaurant_id,order_id,kind,status,amount_minor,currency,provider_mode,metadata,created_at,updated_at) VALUES(?,?,?,?,'merchant_transfer','confirmed',372,'GBP','stripe_test','{}',?,?)").run(randomUUID(),"migration63-existing-transfer",f.restaurant.id,placed.body.data.id,stamp,stamp);
    const before={users:f.db.prepare("SELECT * FROM users ORDER BY id").all(),orders:f.db.prepare("SELECT * FROM orders ORDER BY id").all(),operations:f.db.prepare("SELECT * FROM marketplace_operations ORDER BY id").all()};
    assert.ok(before.orders.length>0);assert.ok(before.operations.length>0);
    f.db.exec("DROP TABLE business_report_email_outbox; DELETE FROM schema_migrations WHERE version=63;");
    assert.equal(f.db.prepare("SELECT MAX(version) n FROM schema_migrations").get().n,62);
    migrateDatabase(f.db);migrateDatabase(f.db);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE version=63").get().n,1);
    for(const[table,key]of [["users","users"],["orders","orders"],["marketplace_operations","operations"]])assert.deepEqual(f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),before[key]);
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").get(),undefined);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM business_report_email_outbox").get().n,0);
  }finally{await f.close();}
});

test("existing SMTP adapter carries requested CSV attachments with the server-generated statement identity",async()=>{
  let captured;const settings={mode:"smtp",enabled:true,from:"caleats-support@calai.info",host:"smtp.ionos.co.uk",port:587,user:"fixture",password:"fixture-private"};
  const adapter=createOrderAlertEmailAdapter(settings,{transportFactory:()=>({sendMail:async message=>{captured=message;return{accepted:["owner@example.test"]};}})});
  let guarded=0;const result=await adapter({id:randomUUID(),to:"owner@example.test",from:settings.from,subject:"Cal-Eats report",text:"Attached",messageId:`<cal-eats-business-statement-${randomUUID()}@calai.info>`,attachments:[{filename:"Cal-Eats-report.csv",contentType:"text/csv",contentBase64:Buffer.from("heading\nvalue\n").toString("base64")}]},{beforeSend:()=>{guarded++;return true;}});
  assert.equal(result.status,"sent");assert.equal(guarded,1);assert.equal(captured.attachments[0].content.toString(),"heading\nvalue\n");assert.equal(captured.disableFileAccess,true);assert.equal(captured.disableUrlAccess,true);
});
