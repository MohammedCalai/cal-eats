import assert from "node:assert/strict";
import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign} from "node:crypto";
import path from "node:path";
import test from "node:test";
import {journeyFixture} from "./helpers.js";
import {TerminalClient} from "../../print-bridge/src/terminal-client.js";
import {ApiClient} from "../../print-bridge/src/api-client.js";
import {formatReceipt} from "../../print-bridge/src/receipt.js";
import {openDatabase,migrateDatabase} from "../src/db/index.js";
import {migrations} from "../src/db/migrations.js";
import {seedDemoData} from "../src/seed.js";

const hash=value=>createHash('sha256').update(value).digest('hex');
async function kitchen(){
  let time=Date.parse('2026-01-01T01:00:00Z');
  const f=await journeyFixture({now:()=>new Date(time),rateLimit:{attempts:500,windowMs:60000}}),owner=await f.login('restaurant@calai.local','LocalRestaurant!4310'),customer=await f.login('customer@calai.local','LocalCustomer!4310'),other=await f.login('restaurant2@calai.local','LocalRestaurant2!4310');
  const restaurant=(await f.json('/api/restaurant/restaurants',{cookie:owner})).body.data[0],root=`/api/restaurant/restaurants/${restaurant.id}`;
  const issued=await f.json(`${root}/terminal/pairing-code`,{method:'POST',cookie:owner,body:{}});assert.equal(issued.status,201,issued.text);
  const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicKeySpki=keys.publicKey.export({type:'spki',format:'der'}).toString('base64');
  const terminal=new TerminalClient({baseUrl:'http://127.0.0.1:4310',identityPath:path.join(f.directory,'terminal.public.json'),clock:()=>time,keyFactory:()=>({publicKey:async()=>({publicKeySpki}),sign:async canonical=>sign('sha256',Buffer.from(canonical),{key:keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url')}),fetchImpl:async(url,options)=>{
    const response=await f.request(url.pathname+url.search,{method:options.method,headers:options.headers,...(options.body?{body:JSON.parse(options.body)}:{})});
    return new Response(response.bodyBuffer,{status:response.status,headers:Object.fromEntries(response.headers)});
  }});
  await terminal.pair({...issued.body.data,deviceName:'Synthetic Windows terminal'});
  const screenId=randomBytes(18).toString('base64url');
  let userProof;
  const forward=request=>terminal.forward(request,{userProof});
  const pulse=async()=>{const result=await f.json(`${root}/terminal/screen-challenge`,{method:'POST',cookie:owner,body:{screenId}});assert.equal(result.status,201,result.text);await terminal.screenHeartbeat({screenId,challenge:result.body.data.challenge},{userProof});};
  const handoff=await f.json(`${root}/terminal/session-handoff`,{method:'POST',cookie:owner,body:{screenId}});({userProof}=await terminal.connectSession({terminalId:terminal.identity.terminalId,handoffToken:handoff.body.data.handoffToken}));await pulse();
  const created=await f.json(`${root}/printers`,{method:'POST',cookie:owner,body:{name:'Synthetic printer',enabled:true,ipAddress:'192.0.2.40'}});assert.equal(created.status,201,created.text);const printer=created.body.data,printerPath=`${root}/printers/${printer.id}`;
  const code=await f.json(`${printerPath}/pairing-code`,{method:'POST',cookie:owner,body:{}});assert.equal(code.status,201,code.text);
  const api=new ApiClient({baseUrl:terminal.baseUrl,terminal,timeoutMs:1000,retry:{maxAttempts:1,baseDelayMs:10,maxDelayMs:10,jitterRatio:0}}),paired=await api.pair(code.body.data.code,'Synthetic queue worker',randomBytes(32).toString('base64url'));api.token=paired.token;
  await api.heartbeat({printerReachable:true,transport:'windows-spooler'});
  const place=async()=>{const item=f.db.prepare('SELECT id FROM menu_items WHERE restaurant_id=? AND available=1 LIMIT 1').get(restaurant.id);const result=await f.json('/api/orders',{method:'POST',cookie:customer,headers:{'Idempotency-Key':randomUUID()},body:{restaurantId:restaurant.id,items:[{menuItemId:item.id,quantity:1}],fulfillment:'collection',paymentMethod:'mock_card'}});assert.equal(result.status,201,result.text);return result.body.data;};
  const accept=async()=>{const order=await place();await forward({method:'PATCH',path:`/api/restaurant/orders/${order.id}/status`,body:{status:'accepted'}});return order;};
  return{...f,owner,other,restaurant,root,printer,printerPath,terminal,api,pulse,place,accept,forward,advance:ms=>{time+=ms;}};
}

test('actual signed companion/API pipeline records submitted plus spooler ID without claiming physical printing',async()=>{
  const f=await kitchen();try{
    const order=await f.accept(),job=await f.api.claim();assert.equal(job.status,'dispatched');assert.equal(job.attempt,1);
    await assert.rejects(f.api.ack(job.id,{claimToken:job.claimToken,outcome:'submitted'}),error=>error.code==='PRINT_SUBMISSION_REQUIRED');
    const marker=await f.api.submitting(job.id,job.claimToken);assert.ok(marker.submissionStartedAt);
    assert.deepEqual(await f.api.submitting(job.id,job.claimToken),marker,'Lost marker response replays without dispatching another job');
    const acknowledgement={claimToken:job.claimToken,outcome:'submitted',spoolerJobId:'42',detail:'Spooler accepted; physical output unverified'};
    const first=await f.api.ack(job.id,acknowledgement),again=await f.api.ack(job.id,acknowledgement);assert.deepEqual(first,again);assert.equal(first.status,'submitted');assert.equal(first.physicalPrinted,false);assert.equal(first.spoolerJobId,'42');
    const row=f.db.prepare('SELECT * FROM device_print_jobs WHERE id=?').get(job.id);assert.equal(row.terminal_device_id,f.terminal.identity.terminalId);assert.equal(row.order_id,order.id);assert.equal(row.spooler_job_id,'42');
    assert.equal((await f.api.claim()),null);
    const history=await f.json(`${f.printerPath}/jobs`,{cookie:f.owner});assert.equal(history.status,200,history.text);assert.equal(history.body.data.items[0].spoolerJobId,'42');assert.equal(history.body.data.items[0].status,'submitted');
    assert.equal((await f.json(`${f.printerPath}/jobs`,{cookie:f.other})).status,404);
  }finally{await f.close();}
});
test('only proven pre-submission expiry retries with backoff and old tokens cannot authorize a later attempt',async()=>{
  const f=await kitchen();try{
    await f.accept();let job=await f.api.claim();const original=job;
    f.advance(30001);assert.equal(await f.api.claim(),null);let row=f.db.prepare('SELECT * FROM device_print_jobs WHERE id=?').get(job.id);assert.equal(row.status,'queued');assert.ok(row.available_at);
    await assert.rejects(f.api.submitting(job.id,job.claimToken),error=>error.code==='INVALID_CLAIM_TOKEN');
    f.advance(5000);job=await f.api.claim();assert.equal(job.id,original.id);assert.equal(job.attempt,2);
    f.advance(30001);assert.equal(await f.api.claim(),null);f.advance(10000);job=await f.api.claim();assert.equal(job.attempt,3);
    f.advance(30001);assert.equal(await f.api.claim(),null);row=f.db.prepare('SELECT status FROM device_print_jobs WHERE id=?').get(job.id);assert.equal(row.status,'failed');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM printer_job_claim_tokens WHERE job_id=?').get(job.id).n,0);
  }finally{await f.close();}
});
test('submission uncertainty requires an audited tablet check before an idempotent labelled reprint',async()=>{
  const f=await kitchen();try{
    const order=await f.accept(),job=await f.api.claim();await f.api.submitting(job.id,job.claimToken);f.advance(30001);assert.equal(await f.api.claim(),null);
    assert.equal(f.db.prepare('SELECT status FROM device_print_jobs WHERE id=?').get(job.id).status,'uncertain');
    const requestId=randomUUID(),reprint=()=>f.forward({method:'POST',path:`${f.printerPath}/reprints`,body:{orderId:order.id,requestId}});
    await assert.rejects(reprint(),error=>error.code==='PRINT_RESULT_REVIEW_REQUIRED');
    const checkPath=`${f.printerPath}/jobs/${job.id}/check`;
    assert.equal((await f.json(checkPath,{method:'POST',cookie:f.owner,body:{result:'not_printed'}})).status,403);
    const before=f.db.prepare('SELECT total_minor,commission_minor,payment_status FROM orders WHERE id=?').get(order.id);
    const checked=await f.forward({method:'POST',path:checkPath,body:{result:'not_printed'}});assert.equal(checked.status,'cancelled');
    assert.equal((await f.forward({method:'POST',path:checkPath,body:{result:'not_printed'}})).replay,true);
    const copy=await reprint(),replay=await reprint();assert.equal(copy.id,replay.id);assert.equal(copy.receiptRevision,2);
    await assert.rejects(f.forward({method:'POST',path:`${f.printerPath}/reprints`,body:{orderId:order.id,requestId:randomUUID()}}),error=>error.code==='PRINT_JOB_PENDING');
    const next=await f.api.claim();assert.equal(next.manualReprint,true);assert.match(formatReceipt(next.receipt,{manualReprint:next.manualReprint}).text,/REPRINT/);
    assert.deepEqual(f.db.prepare('SELECT total_minor,commission_minor,payment_status FROM orders WHERE id=?').get(order.id),before);
    const audit=f.db.prepare("SELECT details FROM audit_events WHERE entity_id=? AND action='printer_job_checked'").all(job.id);assert.equal(audit.length,1);assert.deepEqual(JSON.parse(audit[0].details).result,'not_printed');
  }finally{await f.close();}
});
test('obsolete completed originals cancel, intentional pending/future receipts remain and legacy printed maps to submitted',async()=>{
  const f=await kitchen();try{
    const completed=await f.accept();f.db.prepare("UPDATE orders SET status='completed' WHERE id=?").run(completed.id);assert.equal(await f.api.claim(),null);assert.equal(f.db.prepare('SELECT status FROM device_print_jobs WHERE order_id=?').get(completed.id).status,'cancelled');
    const order=await f.accept();f.db.prepare("UPDATE orders SET status='placed',scheduled_for=? WHERE id=?").run('2026-01-04T01:00:00Z',order.id);f.db.prepare('UPDATE device_print_jobs SET created_at=? WHERE order_id=?').run('2025-12-29T00:00:00Z',order.id);
    const job=await f.api.claim();assert.equal(job.receipt.orderNumber,order.id);assert.equal((await f.api.ack(job.id,{claimToken:job.claimToken,outcome:'printed'})).status,'submitted');
    const legacy=await f.accept();f.db.prepare("UPDATE device_print_jobs SET status='claimed',attempt=1,lease_expires_at=? WHERE order_id=?").run('2026-01-01T01:05:00Z',legacy.id);
    assert.equal(await f.api.claim(),null);assert.equal(f.db.prepare('SELECT status FROM device_print_jobs WHERE order_id=?').get(legacy.id).status,'uncertain','An old claimed row is never proof that submission did not begin, even before its lease expires');
  }finally{await f.close();}
});
test('populated 63 to 65 migration preserves old print rows/tokens/payloads and a synthetic paid snapshot',async()=>{
  const db=openDatabase(':memory:'),now='2026-01-01T01:00:00Z';
  try{
    db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
    for(const migration of migrations.filter(row=>row.version<=63)){if(migration.foreignKeysOff)db.exec('PRAGMA foreign_keys=OFF');db.exec('BEGIN IMMEDIATE');db.exec(migration.sql);db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(migration.version,migration.name,now);db.exec('COMMIT');if(migration.foreignKeysOff)db.exec('PRAGMA foreign_keys=ON');}
    await seedDemoData(db,new Date(now));const owner=db.prepare("SELECT u.id,r.id restaurant_id,r.name FROM users u JOIN restaurant_memberships m ON m.user_id=u.id JOIN restaurants r ON r.id=m.restaurant_id WHERE u.email='restaurant@calai.local'").get(),customer=db.prepare("SELECT id FROM users WHERE email='customer@calai.local'").get();
    db.prepare("INSERT INTO orders(id,restaurant_id,restaurant_name,customer_id,status,currency,subtotal_minor,delivery_fee_minor,total_minor,commission_minor,payment_method,payment_status,fulfillment,idempotency_key,request_hash,created_at,updated_at) VALUES('synthetic-paid',?,?,?,'completed','GBP',400,0,400,28,'mock_card','mock_captured','collection','synthetic-paid-key','synthetic-hash',?,?)").run(owner.restaurant_id,owner.name,customer.id,now,now);
    db.prepare("INSERT INTO marketplace_operations(id,operation_key,restaurant_id,order_id,kind,status,amount_minor,currency,provider_mode,metadata,created_at,updated_at) VALUES('synthetic-transfer','synthetic-transfer-key',?,'synthetic-paid','merchant_transfer','confirmed',372,'GBP','local_simulator','{}',?,?)").run(owner.restaurant_id,now,now);
    db.prepare("INSERT INTO restaurant_printers(id,restaurant_id,name,enabled,created_at,updated_at) VALUES('legacy-printer',?,'Legacy',1,?,?)").run(owner.restaurant_id,now,now);
    db.prepare("INSERT INTO printer_devices(id,printer_id,restaurant_id,name,token_hash,created_at) VALUES('legacy-device','legacy-printer',?,'Legacy',?,?)").run(owner.restaurant_id,hash('synthetic-printer-token'),now);
    for(const status of ['printed','claimed']){
      const id=`legacy-${status}`;db.prepare("INSERT INTO device_print_jobs(id,printer_id,order_id,operation_key,receipt,status,attempt,claim_token_hash,lease_expires_at,claimed_by_device_id,detail,created_at,updated_at) VALUES(?,'legacy-printer','synthetic-paid',?,'{\"legacy\":true}',?,1,?,?,'legacy-device','historical detail',?,?)").run(id,id,status,hash(id),now,now,now);
      db.prepare('INSERT INTO printer_job_claim_tokens VALUES(?,?,?,?)').run(id,'legacy-device',hash(`token-${id}`),now);
      db.prepare("INSERT INTO printer_test_jobs(id,printer_id,restaurant_id,request_id,requested_by_user_id,receipt,status,attempt,claim_token_hash,lease_expires_at,claimed_by_device_id,detail,expires_at,created_at,updated_at) VALUES(?,'legacy-printer',?,?,?,'{\"sample\":true}',?,1,?,?,'legacy-device','sample historical detail',?,?,?)").run(`sample-${status}`,owner.restaurant_id,`request-${status}`,owner.id,status,hash(`sample-${status}`),now,'2026-01-01T01:05:00Z',now,now);
      db.prepare('INSERT INTO printer_test_job_claim_tokens VALUES(?,?,?,?)').run(`sample-${status}`,'legacy-device',hash(`sample-token-${status}`),now);
    }
    const tables=['device_print_jobs','printer_test_jobs','printer_job_claim_tokens','printer_test_job_claim_tokens','orders','marketplace_operations'],before=Object.fromEntries(tables.map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    migrateDatabase(db);migrateDatabase(db);
    for(const table of tables){const columns=Object.keys(before[table][0]);assert.deepEqual(db.prepare(`SELECT ${columns.join(',')} FROM ${table} ORDER BY rowid`).all(),before[table],table);}
    assert.deepEqual({...db.prepare('SELECT total_minor,commission_minor FROM orders WHERE id=?').get('synthetic-paid')},{total_minor:400,commission_minor:28});assert.equal(db.prepare('SELECT amount_minor FROM marketplace_operations WHERE id=?').get('synthetic-transfer').amount_minor,372);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');assert.equal(db.prepare('SELECT MAX(version) version FROM schema_migrations').get().version,65);
  }finally{db.close();}
});
