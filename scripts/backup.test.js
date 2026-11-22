import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {randomUUID} from "node:crypto";
import { BACKUP_ROOT, createBackup } from "./backup.js";
import { checkBackup } from "./restore-check.js";
import { journeyFixture } from "../apps/api/test/helpers.js";
import { enrolRegisteredTablet } from "../apps/api/test/registered-tablet-fixture.js";
import { addNotification } from "../apps/api/src/offers.js";
import {runTabletManagementRefresh} from "../apps/api/src/tablet-management.js";
import {runBusinessMonitoringRetention} from "../apps/api/src/business-monitoring-retention.js";

function fixture(name) {
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  const source = path.join(BACKUP_ROOT, `${name}-source.sqlite`);
  const destination = path.join(BACKUP_ROOT, `${name}-backup.sqlite`);
  for (const file of [source, destination, `${source}-wal`, `${source}-shm`]) fs.rmSync(file, { force: true });
  const db = new DatabaseSync(source);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE restaurants(id TEXT PRIMARY KEY); CREATE TABLE orders(id TEXT PRIMARY KEY); INSERT INTO schema_migrations VALUES(1); PRAGMA wal_checkpoint(TRUNCATE);");
  return { source, destination, db, cleanup() { db.close(); for (const file of [source, destination, `${source}-wal`, `${source}-shm`]) fs.rmSync(file, { force: true }); } };
}

test("online backup includes committed data still present in WAL", async () => {
  const item = fixture(`wal-${process.pid}`);
  try {
    item.db.exec("INSERT INTO users VALUES('wal-user')");
    assert.ok(fs.existsSync(`${item.source}-wal`));
    await createBackup({ source: item.source, destination: item.destination });
    const backup = new DatabaseSync(item.destination, { readOnly: true });
    try { assert.equal(backup.prepare("SELECT id FROM users").get().id, "wal-user"); } finally { backup.close(); }
    assert.equal(checkBackup(item.destination).integrity, "ok");
  } finally { item.cleanup(); }
});

test("restorable backups omit phone tokens and pending alerts without changing the live source or order history", async () => {
  const item = fixture(`push-${process.pid}`);
  try {
    item.db.exec("CREATE TABLE customer_push_devices(id TEXT PRIMARY KEY,ciphertext TEXT); CREATE TABLE customer_push_outbox(id TEXT PRIMARY KEY,device_id TEXT REFERENCES customer_push_devices(id)); INSERT INTO customer_push_devices VALUES('phone-one','private-fixture-token-material'); INSERT INTO customer_push_outbox VALUES('alert-one','phone-one'); INSERT INTO orders VALUES('retained-order');");
    await createBackup({ source: item.source, destination: item.destination });
    const backup = new DatabaseSync(item.destination, { readOnly: true });
    try {
      assert.equal(backup.prepare("SELECT COUNT(*) n FROM customer_push_devices").get().n, 0);
      assert.equal(backup.prepare("SELECT COUNT(*) n FROM customer_push_outbox").get().n, 0);
      assert.equal(backup.prepare("SELECT id FROM orders").get().id, "retained-order");
      assert.equal(backup.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(backup.prepare("PRAGMA foreign_key_check").all().length, 0);
    } finally { backup.close(); }
    assert.equal(item.db.prepare("SELECT ciphertext FROM customer_push_devices").get().ciphertext, "private-fixture-token-material");
    assert.equal(item.db.prepare("SELECT COUNT(*) n FROM customer_push_outbox").get().n, 1);
    assert.equal(fs.readFileSync(item.destination).includes(Buffer.from("private-fixture-token-material")), false);
  } finally { item.cleanup(); }
});

test("restorable backups cannot resend on-demand report emails or retain their attachment copies", async () => {
  const item = fixture(`report-email-${process.pid}`);
  const marker = "private-report-attachment-must-not-replay";
  try {
    item.db.exec("CREATE TABLE business_report_email_outbox(id TEXT PRIMARY KEY,status TEXT,csv TEXT); INSERT INTO orders VALUES('retained-financial-order');");
    item.db.prepare("INSERT INTO business_report_email_outbox VALUES('requested-report','pending',?)").run(marker);
    await createBackup({ source: item.source, destination: item.destination });
    const backup = new DatabaseSync(item.destination, { readOnly: true });
    try {
      assert.equal(backup.prepare("SELECT COUNT(*) n FROM business_report_email_outbox").get().n, 0);
      assert.equal(backup.prepare("SELECT id FROM orders").get().id, "retained-financial-order");
      assert.equal(backup.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally { backup.close(); }
    assert.equal(item.db.prepare("SELECT csv FROM business_report_email_outbox").get().csv, marker);
    assert.equal(fs.readFileSync(item.destination).includes(Buffer.from(marker)), false);
  } finally { item.cleanup(); }
});

test("a migrated backup cannot revive native customer sessions or replay Live Activity and push delivery", async () => {
  const f = await journeyFixture();
  const destination = path.join(BACKUP_ROOT, `live-activity-${process.pid}-backup.sqlite`);
  fs.rmSync(destination, { force: true });
  try {
    const customer = await f.login("customer@calai.local", "LocalCustomer!4310");
    const owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310");
    const restaurant = f.db.prepare("SELECT id FROM restaurants WHERE name='Calai Kitchen'").get();
    const menu = f.db.prepare("SELECT id FROM menu_items WHERE restaurant_id=? LIMIT 1").get(restaurant.id);
    const response = await f.json("/api/orders", { method: "POST", cookie: customer, headers: { "Idempotency-Key": "backup-privacy-fixture" }, body: {
      restaurantId: restaurant.id, items: [{ menuItemId: menu.id, quantity: 1 }], paymentMethod: "cash", fulfillment: "collection",
      customerPhone: "07100000000", allergyNotes: "fixture allergy note retained with order"
    } });
    assert.equal(response.status, 201, response.text);
    const order = response.body.data;
    const tablet = await enrolRegisteredTablet(f, { ownerCookie: owner });
    const accepted = await tablet.json(`/api/restaurant/orders/${order.id}/status`, { method: "PATCH", body: { status: "accepted", estimatedReadyAt: "2026-01-01T01:30:00.000Z" } });
    assert.equal(accepted.status, 200, accepted.text);
    assert.ok(f.db.prepare("SELECT COUNT(*) n FROM ledger_entries WHERE order_id=?").get(order.id).n > 0);
    const stamp = "2026-01-01T01:01:00.000Z", expires = "2026-01-01T08:00:00.000Z";
    f.db.prepare("INSERT INTO native_sessions VALUES(?,?,?,?,?,NULL)").run("backup-native-session", order.customerId, "private-fixture-session-hash", stamp, expires);
    f.db.prepare(`INSERT INTO customer_push_devices(id,installation_id,user_id,session_id,token_hash,ciphertext,nonce,auth_tag,key_version,platform,project_id,generation,sound_enabled,expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'ios',?,1,0,?,?,?)`).run("backup-push-device", "backup-installation", order.customerId, "backup-native-session", "backup-push-hash", "private-fixture-push-ciphertext", "nonce", "tag", "v1", "5bf59184-c670-44f4-be78-5229cbd02300", expires, stamp, stamp);
    f.db.prepare(`INSERT INTO customer_order_live_activities(id,activity_id,installation_id,user_id,session_id,order_id,project_id,token_hash,ciphertext,nonce,auth_tag,key_version,generation,state,expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,'active',?,?,?)`).run("backup-live-binding", "backup-activity", "backup-installation", order.customerId, "backup-native-session", order.id, "5bf59184-c670-44f4-be78-5229cbd02300", "backup-live-hash", "private-fixture-live-ciphertext", "nonce", "tag", "v1", expires, stamp, stamp);
    f.db.prepare("INSERT INTO order_live_activity_outbox(activity_id,generation,revision,status,available_at,updated_at) VALUES(?,1,1,'pending',?,?)").run("backup-live-binding", stamp, stamp);
    addNotification(f.db, { userId: order.customerId, type: "order_status", title: "Fixture order", message: "Fixture update", orderId: order.id, restaurantId: restaurant.id, eventKey: "backup-fixture-before", now: stamp });
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM customer_push_outbox").get().n, 1);
    const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    const snapshot = db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name}) => [name, rows(db, name)]));
    const before = snapshot(f.db);
    await createBackup({ source: f.config.dbPath, destination });
    assert.deepEqual(snapshot(f.db), before, "Backup sanitation must not modify any source row");
    const copy = new DatabaseSync(destination);
    try {
      copy.exec("PRAGMA foreign_keys=ON");
      for (const table of ["order_live_activity_outbox", "customer_order_live_activities", "customer_push_outbox", "customer_push_devices", "native_sessions"]) {
        assert.equal(rows(copy, table).length, 0, table);
      }
      for (const table of ["users", "restaurants", "orders", "order_items", "order_events", "ledger_entries", "contracts", "commission_policies", "order_live_activity_revisions"]) {
        assert.deepEqual(rows(copy, table), before[table], `Preserve ${table}`);
      }
      // Exercise the real database triggers on the restored copy: an order
      // update or new alert cannot resurrect a registration from the snapshot.
      copy.prepare("UPDATE orders SET status='preparing',updated_at=? WHERE id=?").run(stamp, order.id);
      addNotification(copy, { userId: order.customerId, type: "order_status", title: "Fixture restored order", message: "Fixture restored update", orderId: order.id, restaurantId: restaurant.id, eventKey: "backup-fixture-after", now: stamp });
      assert.equal(rows(copy, "order_live_activity_outbox").length, 0);
      assert.equal(rows(copy, "customer_push_outbox").length, 0);
      assert.equal(copy.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(copy.prepare("PRAGMA foreign_key_check").all().length, 0);
    } finally { copy.close(); }
    const bytes = fs.readFileSync(destination);
    for (const marker of ["private-fixture-session-hash", "private-fixture-push-ciphertext", "private-fixture-live-ciphertext"]) assert.equal(bytes.includes(Buffer.from(marker)), false, marker);
    assert.equal(checkBackup(destination).integrity, "ok");
  } finally {
    await f.close();
    for (const file of [destination, `${destination}-wal`, `${destination}-shm`]) fs.rmSync(file, { force: true });
  }
});

test("backup refuses to overwrite an existing destination", async () => {
  const item = fixture(`overwrite-${process.pid}`);
  try {
    fs.writeFileSync(item.destination, "keep me");
    await assert.rejects(createBackup({ source: item.source, destination: item.destination }), /Refusing to overwrite/);
    assert.equal(fs.readFileSync(item.destination, "utf8"), "keep me");
  } finally { item.cleanup(); }
});

test("business-only backup clears connection secrets and revoked-device authority from bytes without altering its source",async()=>{
  const item=fixture(`business-monitoring-${process.pid}`),marker='private-business-connection-sentinel-never-restored';
  try{
    item.db.exec("CREATE TABLE business_terminal_grants(id TEXT); CREATE TABLE surface_application_presence(id TEXT); CREATE TABLE native_business_sessions(id TEXT); CREATE TABLE native_platform_sessions(id TEXT); CREATE TABLE business_terminals(id TEXT,revoked_at TEXT,last_contact_at TEXT,last_screen_at TEXT,screen_id TEXT); CREATE TABLE business_product_links(product TEXT,source_account_id TEXT,encrypted_credentials TEXT,credential_expires_at TEXT,credential_checked_at TEXT,last_error_code TEXT); INSERT INTO business_terminal_grants VALUES('retired-grant'); INSERT INTO surface_application_presence VALUES('presence'); INSERT INTO native_business_sessions VALUES('phone-session'); INSERT INTO native_platform_sessions VALUES('platform-session'); INSERT INTO business_terminals VALUES('surface',NULL,'contact','screen','screen-id'); INSERT INTO orders VALUES('retained-financial-order');");
    item.db.prepare("INSERT INTO business_product_links VALUES('calai','native-account',?,'expiry','checked',NULL)").run(marker);
    await createBackup({source:item.source,destination:item.destination});
    const copy=new DatabaseSync(item.destination,{readOnly:true});
    try{for(const table of ['business_terminal_grants','surface_application_presence','native_business_sessions','native_platform_sessions'])assert.equal(copy.prepare('SELECT COUNT(*) n FROM '+table).get().n,0);assert.ok(copy.prepare('SELECT revoked_at FROM business_terminals').get().revoked_at);const link=copy.prepare('SELECT * FROM business_product_links').get();assert.equal(link.source_account_id,'native-account');assert.equal(link.encrypted_credentials,null);assert.equal(link.last_error_code,'CALAI_RECONNECT_REQUIRED');assert.equal(copy.prepare('SELECT id FROM orders').get().id,'retained-financial-order');}finally{copy.close();}
    assert.equal(item.db.prepare('SELECT encrypted_credentials FROM business_product_links').get().encrypted_credentials,marker);assert.equal(item.db.prepare('SELECT revoked_at FROM business_terminals').get().revoked_at,null);assert.equal(fs.readFileSync(item.destination).includes(Buffer.from(marker)),false);
  }finally{item.cleanup();}
});

async function centralTabletFixture(){
 let clock=Date.parse('2031-01-01T12:00:00.000Z');
 const f=await journeyFixture({now:()=>new Date(clock),rateLimit:{attempts:1000,windowMs:60000},tabletManagement:{enabled:true,tenantId:randomUUID(),clientId:randomUUID(),certificateThumbprint:'a'.repeat(64),privateKey:'SYNTHETIC_TEST_ONLY',approvedScripts:[]}});
 try{
  const admin=await f.login('admin@calai.local','LocalAdmin!4310');
  const secured=await f.json('/api/auth/password',{method:'POST',cookie:admin,body:{currentPassword:'LocalAdmin!4310',newPassword:'SecureBackupAdmin!4310'}});assert.equal(secured.status,200,secured.text);
  const business=f.db.prepare("SELECT business_id FROM business_product_links WHERE product='cal-eats' ORDER BY business_id LIMIT 1").get().business_id;
  const call=(route,body)=>f.json('/api/admin/tablets'+route,{method:'POST',cookie:admin,body});
  async function create(suffix){const response=await call('',{displayName:'Synthetic backup tablet '+suffix,businessId:business,serialNumber:'BACKUP-SYNTHETIC-'+suffix,intuneManagedDeviceId:randomUUID(),entraDeviceId:randomUUID()});assert.equal(response.status,201,response.text);return response.body.data;}
  async function queue(record){const response=await call('/'+record.id+'/management/refresh',{expectedRevision:record.revision});assert.equal(response.status,202,response.text);return response.body.data.job;}
  return{...f,call,create,queue,advance(seconds){clock+=seconds*1000;}};
 }catch(error){await f.close();throw error;}
}

test('schema72 backup removes real central pairing children and cancels queued or leased management reads without changing source history',async()=>{
 const f=await centralTabletFixture(),destination=path.join(BACKUP_ROOT,`central-tablet-${process.pid}-backup.sqlite`);
 fs.rmSync(destination,{force:true});
 try{
  assert.ok(f.db.prepare('SELECT 1 FROM schema_migrations WHERE version=72').get());
  const record=await f.create('ONE'),issued=await f.call('/'+record.id+'/enrolment',{expectedRevision:record.revision,confirmReplaceTerminalId:null});assert.equal(issued.status,201,issued.text);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tablet_fleet_pairing_requests').get().n,1);
  await f.queue(record);
  const adapter={collect:async()=>({identityMatched:true,collectedAt:f.config.now().toISOString(),contactAt:f.config.now().toISOString(),scriptRef:null,scriptSha256:null,runStateId:null,execution:null,physicalStartupVerified:false,applicationPresenceVerified:false,source:'microsoft_graph'})};
  assert.equal((await runTabletManagementRefresh(f.db,f.config,{adapter})).completed,1);
  f.advance(31);const queued=await f.queue(record),second=await f.create('TWO'),running=await f.queue(second);
  f.db.prepare("UPDATE tablet_management_refresh_jobs SET status='running',attempts=1,lease_owner='synthetic-live-reader',lease_expires_at=? WHERE id=?").run(new Date(f.config.now().getTime()+180000).toISOString(),running.id);
  const rows=(db,table)=>db.prepare('SELECT * FROM '+table+' ORDER BY id').all(),sourceJobs=rows(f.db,'tablet_management_refresh_jobs'),sourceEvidence=rows(f.db,'tablet_management_observations'),sourceOrders=rows(f.db,'orders'),sourceInventory=rows(f.db,'admin_tablets');
  await createBackup({source:f.config.dbPath,destination});
  const copy=new DatabaseSync(destination);
  try{
   for(const table of ['tablet_fleet_pairing_requests','business_terminal_pairings'])assert.equal(copy.prepare('SELECT COUNT(*) n FROM '+table).get().n,0);
   assert.equal(copy.prepare("SELECT COUNT(*) n FROM tablet_management_refresh_jobs WHERE status IN('queued','running') OR lease_owner IS NOT NULL OR lease_expires_at IS NOT NULL OR available_at IS NOT NULL").get().n,0);
   for(const id of[queued.id,running.id]){const job=copy.prepare('SELECT * FROM tablet_management_refresh_jobs WHERE id=?').get(id);assert.equal(job.status,'cancelled');assert.equal(job.error_code,'GRAPH_BACKUP_REQUIRES_FRESH_REQUEST');assert.ok(job.finished_at);}
   assert.deepEqual(rows(copy,'tablet_management_observations'),sourceEvidence,'Keep the original dated historical observation and completed parent');
   assert.deepEqual(rows(copy,'orders'),sourceOrders);assert.deepEqual(rows(copy,'admin_tablets'),sourceInventory);
   let resumed=0;const result=await runTabletManagementRefresh(copy,f.config,{adapter:{collect:async()=>{resumed++;throw Error('A restored backup must require a fresh request');}}});assert.equal(resumed,0);assert.equal(result.completed,0);
   assert.deepEqual(copy.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{copy.close();}
  assert.deepEqual(rows(f.db,'tablet_management_refresh_jobs'),sourceJobs);assert.deepEqual(rows(f.db,'tablet_management_observations'),sourceEvidence);assert.deepEqual(rows(f.db,'orders'),sourceOrders);assert.deepEqual(rows(f.db,'admin_tablets'),sourceInventory);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tablet_fleet_pairing_requests').get().n,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM business_terminal_pairings').get().n,1);
  assert.equal(fs.readFileSync(destination).includes(Buffer.from(issued.body.data.enrolment.code)),false);
 }finally{await f.close();for(const file of[destination,`${destination}-wal`,`${destination}-shm`,`${destination}.media-objects.jsonl`])fs.rmSync(file,{force:true});}
});

test('approved30-day monitoring retention removes old finished management evidence and jobs while preserving current and active operations',async()=>{
 const f=await centralTabletFixture();
 try{
  const record=await f.create('RETENTION'),old='2030-11-01T12:00:00.000Z',recent=f.config.now().toISOString(),actor=f.db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get().id;
  const insert=(status,at)=>{const id=randomUUID();f.db.prepare('INSERT INTO tablet_management_refresh_jobs(id,tablet_id,record_revision,requested_by,requested_at,status,attempts,available_at,lease_owner,lease_expires_at,finished_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,record.id,1,actor,at,status,1,status==='queued'?at:null,status==='running'?'active-collector':null,status==='running'?'2031-01-01T12:03:00.000Z':null,['completed','failed','cancelled'].includes(status)?at:null,at);return id;};
  const oldCompleted=insert('completed',old),recentCompleted=insert('completed',recent),oldFailed=insert('failed',old),oldCancelled=insert('cancelled',old),queued=insert('queued',old);
  // One active job per tablet is enforced; use another real inventory for the leased case.
  const other=await f.create('ACTIVE'),running=randomUUID();f.db.prepare("INSERT INTO tablet_management_refresh_jobs(id,tablet_id,record_revision,requested_by,requested_at,status,attempts,lease_owner,lease_expires_at,updated_at) VALUES(?,?,?,?,?,'running',1,'active-collector',?,?)").run(running,other.id,1,actor,old,'2031-01-01T12:03:00.000Z',old);
  const observe=(job,tablet,at)=>f.db.prepare("INSERT INTO tablet_management_observations(id,tablet_id,record_revision,refresh_job_id,source,collected_at,intune_device_id,entra_device_id,serial_number,evidence_json) VALUES(?,?,1,?,'microsoft_graph',?,?,?,?,?)").run(randomUUID(),tablet.id,job,at,tablet.mapping.intuneManagedDeviceId,tablet.mapping.entraDeviceId,tablet.serialNumber,JSON.stringify({collectedAt:at,source:'microsoft_graph'}));
  observe(oldCompleted,record,old);observe(recentCompleted,record,recent);observe(running,other,old);
  const financial=f.db.prepare('SELECT * FROM orders ORDER BY id').all(),inventory=f.db.prepare('SELECT * FROM admin_tablets ORDER BY id').all();
  const config={...f.config,customerPrivacy:{enabled:true,approvedAt:old,retention:{chatDays:30}}};
  const result=runBusinessMonitoringRetention(f.db,config,{force:true});assert.equal(result.managementObservations,1);assert.equal(result.managementJobs,3);
  for(const id of[oldCompleted,oldFailed,oldCancelled])assert.equal(f.db.prepare('SELECT 1 FROM tablet_management_refresh_jobs WHERE id=?').get(id),undefined);
  for(const id of[recentCompleted,queued,running])assert.ok(f.db.prepare('SELECT 1 FROM tablet_management_refresh_jobs WHERE id=?').get(id));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tablet_management_observations').get().n,2,'Current history and a running operation remain intact');
  assert.deepEqual(f.db.prepare('SELECT * FROM orders ORDER BY id').all(),financial);assert.deepEqual(f.db.prepare('SELECT * FROM admin_tablets ORDER BY id').all(),inventory);assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(runBusinessMonitoringRetention(f.db,config,{force:true}).managementJobs,0);
 }finally{await f.close();}
});

test("concurrent backups to one destination allow one owner and preserve its backup", async () => {
  const item = fixture(`concurrent-${process.pid}`);
  try {
    item.db.exec("INSERT INTO users VALUES('concurrent-user')");
    const attempts = await Promise.allSettled([
      createBackup({ source: item.source, destination: item.destination }),
      createBackup({ source: item.source, destination: item.destination })
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    assert.match(rejected.reason.message, /Refusing to overwrite/);
    const backup = new DatabaseSync(item.destination, { readOnly: true });
    try {
      assert.equal(backup.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(backup.prepare("SELECT id FROM users").get().id, "concurrent-user");
    } finally { backup.close(); }
  } finally { item.cleanup(); }
});

test("restore check rejects a corrupt backup", () => {
  const corrupt = path.join(BACKUP_ROOT, `corrupt-${process.pid}.sqlite`);
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  fs.writeFileSync(corrupt, Buffer.from("not a sqlite database"));
  try { assert.throws(() => checkBackup(corrupt), /database|file is not a database/i); }
  finally { fs.rmSync(corrupt, { force: true }); }
});

test("managed backup outputs cannot escape the project backup directory", async () => {
  const item = fixture(`scope-${process.pid}`);
  try { await assert.rejects(createBackup({ source: item.source, destination: path.join(BACKUP_ROOT, "..", "escape.sqlite") }), /inside/); }
  finally { item.cleanup(); }
});
