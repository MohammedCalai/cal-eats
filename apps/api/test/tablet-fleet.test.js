import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {Readable} from 'node:stream';
import {journeyFixture} from './helpers.js';
import {enrolRegisteredTablet} from './registered-tablet-fixture.js';
import {pairingCanonical} from '../../terminal-auth/src/protocol.js';
import {readSession} from '../src/auth/sessions.js';
import {routeTabletFleet} from '../src/tablet-fleet.js';
import {assertFleetNewEnrolmentAllowed} from '../src/tablet-fleet-policy.js';
import {DatabaseSync} from 'node:sqlite';
import {tabletFleetMigration71} from '../src/tablet-fleet-migration.js';

test('additive migration inventories exact existing registrations without changing them or inventing hardware evidence',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE business_accounts(id TEXT PRIMARY KEY); CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE business_terminals(id TEXT PRIMARY KEY,name TEXT,business_id TEXT,registered_by TEXT,registered_at TEXT,revoked_at TEXT);");
  const business=randomUUID(),actor=randomUUID(),active=randomUUID(),old=randomUUID(),at='2031-01-01T12:00:00.000Z';
  db.prepare('INSERT INTO business_accounts VALUES(?)').run(business);db.prepare('INSERT INTO users VALUES(?)').run(actor);
  const insert=db.prepare('INSERT INTO business_terminals VALUES(?,?,?,?,?,?)');insert.run(active,'Existing exact terminal',business,actor,at,null);insert.run(old,'Historical terminal',business,actor,at,at);
  const before=db.prepare('SELECT * FROM business_terminals ORDER BY id').all();db.exec(tabletFleetMigration71.sql);
  assert.deepEqual(db.prepare('SELECT * FROM business_terminals ORDER BY id').all(),before);
  for(const row of db.prepare('SELECT * FROM admin_tablets').all()){assert.equal(row.id,row.terminal_id);assert.equal(row.serial_number,null);assert.equal(row.authority_blocked_at,null);assert.equal(row.intune_managed_device_id,null);assert.equal(row.requested_startup_product,null);assert.equal(row.inventory_source,'application_registration');}
  assert.equal(db.prepare('SELECT lifecycle_state FROM admin_tablets WHERE id=?').get(active).lifecycle_state,'assigned');assert.equal(db.prepare('SELECT lifecycle_state FROM admin_tablets WHERE id=?').get(old).lifecycle_state,'disabled');
  const request=db.prepare('INSERT INTO tablet_configuration_requests(id,tablet_id,record_revision,mapping_snapshot,requested_by,requested_at,state) VALUES(?,?,?,?,?,?,?)');
  for(const state of ['assigned','offered','received','applied','physically_verified'])assert.throws(()=>request.run(randomUUID(),active,1,'{}',actor,at,state),/CHECK constraint failed/);
  request.run(randomUUID(),active,1,'{}',actor,at,'requested');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();}
});

async function fixture(t){
 const f=await journeyFixture({now:()=>new Date('2031-01-01T12:00:00.000Z'),rateLimit:{attempts:1000,windowMs:60000}});t.after(()=>f.close());
 const owner=await f.login('restaurant@calai.local','LocalRestaurant!4310'),other=await f.login('restaurant2@calai.local','LocalRestaurant2!4310'),customer=await f.login('customer@calai.local','LocalCustomer!4310'),admin=await f.login('admin@calai.local','LocalAdmin!4310');
 const changed=await f.json('/api/auth/password',{method:'POST',cookie:admin,body:{currentPassword:'LocalAdmin!4310',newPassword:'SecureFleetAdmin!4310'}});assert.equal(changed.status,200,changed.text);
 const business=(await f.json('/api/business/context',{cookie:owner})).body.data,otherBusiness=(await f.json('/api/business/context',{cookie:other})).body.data;
 const call=(path='',options={})=>f.json('/api/admin/tablets'+path,{cookie:admin,...options});
 const create=(body={})=>call('',{method:'POST',body:{displayName:'Synthetic Surface',businessId:business.id,...body}});
 const session=()=>readSession(f.db,admin.split('=')[1],f.config);
 return{...f,owner,other,customer,admin,business,otherBusiness,call,create,session};
}

test('central fleet is current secure-admin only, paginated and supports Calai-only locations without dummy Eats accounts',async t=>{
 const f=await fixture(t);
 const before=f.db.prepare('SELECT COUNT(*) n FROM restaurants').get().n,calaiOnly=randomUUID(),native=randomUUID(),now=f.config.now().toISOString();
 f.db.prepare('INSERT INTO business_accounts(id,name,created_at,updated_at) VALUES(?,?,?,?)').run(calaiOnly,'Native Calai-only place',now,now);
 f.db.prepare("INSERT INTO business_native_references VALUES(?,'calai',?,?,'active',?)").run(calaiOnly,native,'Native place',now);
 for(const cookie of [f.owner,f.customer,null])assert.equal((await f.call('',{cookie})).status,cookie?403:401);
 const created=await f.create({displayName:'Calai-only Surface',businessId:calaiOnly,serialNumber:'SERIAL-001',requestedStartupProduct:'calai',intuneManagedDeviceId:randomUUID()});assert.equal(created.status,201,created.text);
 const d=created.body.data;assert.equal(d.business.products.calai.nativeAccountId,native);assert.equal(d.business.eatsRestaurantId,null);assert.equal(d.startup.state,'requested');
 for(const stage of ['assignedAt','offeredAt','receivedAt','appliedAt','physicallyVerifiedAt'])assert.equal(d.startup[stage],null);
 assert.equal(d.mapping.provesHardwareIdentity,false);assert.equal(d.management.lastContactAt,null);assert.equal(d.application,null);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM restaurants').get().n,before);
 const locations=await f.call('/locations?q=Calai-only&pageSize=1');assert.equal(locations.status,200,locations.text);assert.equal(locations.body.data.items[0].id,calaiOnly);
 for(let i=0;i<3;i++)assert.equal((await f.create({displayName:'Paged tablet '+i,businessId:null})).status,201);
 const page=await f.call('?q=Paged&page=2&pageSize=2');assert.equal(page.status,200,page.text);assert.equal(page.body.data.items.length,1);assert.equal(page.body.data.pagination.total,3);
 assert.equal((await f.call('?pageSize=1001')).status,400);
 assert.equal(JSON.stringify(page.body).includes('public_key_spki'),false);assert.equal(JSON.stringify(page.body).includes('password_hash'),false);
});

test('display alias and requested setup preserve Windows/application names and expose no fabricated device acknowledgement',async t=>{
 const f=await fixture(t),tablet=await enrolRegisteredTablet(f,{ownerCookie:f.owner});
 const inventory=await f.call(`/${tablet.terminalId}`);assert.equal(inventory.status,200,inventory.text);assert.equal(inventory.body.data.identitySource,'application_registration');
 const original=f.db.prepare('SELECT * FROM business_terminals WHERE id=?').get(tablet.terminalId);
 const renamed=await f.call(`/${tablet.terminalId}`,{method:'PATCH',body:{expectedRevision:1,displayName:'Friendly kitchen alias',serialNumber:'SER-ABC',requestedStartupProduct:'cal-eats',startupProfileId:randomUUID()}});
 assert.equal(renamed.status,200,renamed.text);assert.equal(renamed.body.data.displayName,'Friendly kitchen alias');assert.equal(renamed.body.data.registration.name,original.name);assert.deepEqual(f.db.prepare('SELECT * FROM business_terminals WHERE id=?').get(tablet.terminalId),original);
 assert.equal(renamed.body.data.startup.state,'requested');assert.equal(renamed.body.data.startup.appliedProduct,null);assert.equal(renamed.body.data.startup.receivedAt,null);
 for(const body of [{appliedAt:'2031-01-01T12:00:00Z'},{businessId:f.otherBusiness.id},{lifecycleState:'assigned'},{physicallyVerified:true}])assert.equal((await f.call(`/${tablet.terminalId}`,{method:'PATCH',body:{expectedRevision:2,...body}})).status,400);
 const duplicate=await f.create({serialNumber:'ser-abc'});assert.equal(duplicate.status,409,duplicate.text);
 const event=f.db.prepare("SELECT details FROM audit_events WHERE entity_type='tablet_fleet' AND action='tablet_metadata_updated'").get();const details=JSON.parse(event.details);assert.equal(details.previous.revision,1);assert.equal(details.current.revision,2);assert.equal(details.windowsConfigurationChanged,false);
});

test('reassignment revokes old terminal authority, retains old assignment/session data, and quarantines both locations from fresh pairing',async t=>{
 const f=await fixture(t),tablet=await enrolRegisteredTablet(f,{ownerCookie:f.owner}),old=f.db.prepare('SELECT * FROM business_terminals WHERE id=?').get(tablet.terminalId);
 const setup=await f.json(`/api/business/accounts/${f.business.id}/terminals/setup`,{method:'POST',cookie:f.owner,body:{replace:true,deviceName:'Outstanding replacement'}});assert.equal(setup.status,201,setup.text);
 const oldSessions=f.db.prepare('SELECT * FROM sessions ORDER BY id').all(),nativeMemberships=f.db.prepare('SELECT * FROM restaurant_memberships WHERE user_id<>? ORDER BY restaurant_id,user_id').all(old.operator_user_id);
 const changed=await f.call(`/${tablet.terminalId}/reassign`,{method:'POST',body:{expectedRevision:1,businessId:f.otherBusiness.id,requestedStartupProduct:'calai',reason:'Return to administrator for physical cleanup',confirmQuarantine:true}});assert.equal(changed.status,200,changed.text);
 const d=changed.body.data;assert.equal(d.lifecycleState,'pending_handoff');assert.equal(d.businessId,f.business.id);assert.equal(d.requestedBusinessId,f.otherBusiness.id);assert.equal(d.handoff.completionSupported,false);assert.equal(d.registration.registered,false);assert.equal(d.startup.receivedAt,null);assert.equal(d.startup.physicallyVerifiedAt,null);assert.match(d.handoff.limitation,/Previous browser\/native sessions cannot be selectively cleared/);
 assert.equal(f.db.prepare('SELECT account_enabled FROM users WHERE id=?').get(old.operator_user_id).account_enabled,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM business_terminal_grants WHERE terminal_id=? AND revoked_at IS NULL').get(old.id).n,0);
 assert.deepEqual(f.db.prepare('SELECT * FROM sessions ORDER BY id').all(),oldSessions);assert.deepEqual(f.db.prepare('SELECT * FROM restaurant_memberships WHERE user_id<>? ORDER BY restaurant_id,user_id').all(old.operator_user_id),nativeMemberships);
 assert.equal((await f.json('/api/auth/me',{cookie:f.owner})).status,200,'The inventory does not falsely claim to have cleared browser authentication');
 assert.equal((await tablet.json('/api/auth/me')).status,403);
 for(const [id,cookie]of [[f.business.id,f.owner],[f.otherBusiness.id,f.other]]){const blocked=await f.json(`/api/business/accounts/${id}/terminals/setup`,{method:'POST',cookie,body:{deviceName:'Retry old session'}});assert.equal(blocked.status,403,blocked.text);assert.equal(blocked.body.error.code,'TABLET_QUARANTINED');}
 const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicKeySpki=keys.publicKey.export({type:'spki',format:'der'}).toString('base64'),p=setup.body.data,challengeSignature=sign('sha256',Buffer.from(pairingCanonical({...p,publicKeySpki})),{key:keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
 const delayed=await f.json('/api/terminal-devices/pair',{method:'POST',body:{terminalId:p.terminalId,code:p.code,deviceName:'Delayed old setup',publicKeySpki,challengeSignature}});assert.equal(delayed.status,403,delayed.text);assert.equal(delayed.body.error.code,'TABLET_QUARANTINED');
 assert.equal((await f.call(`/${tablet.terminalId}/complete-handoff`,{method:'POST',body:{expectedRevision:2,verified:true}})).status,404);
});

test('explicit unassignment stays null and unbound metadata never claims an application identity was revoked',async t=>{
 const f=await fixture(t),created=(await f.create()).body.data;
 const changed=await f.call(`/${created.id}/reassign`,{method:'POST',body:{expectedRevision:1,businessId:null,reason:'Pending verified physical retirement',confirmQuarantine:true}});assert.equal(changed.status,200,changed.text);
 assert.equal(changed.body.data.requestedBusinessId,null);assert.equal(changed.body.data.businessId,f.business.id);assert.match(changed.body.data.handoff.limitation,/No linked Cal-Eats application identity/);
 assert.equal(f.db.prepare('SELECT business_id FROM tablet_configuration_requests WHERE tablet_id=? ORDER BY record_revision DESC LIMIT 1').get(created.id).business_id,null);
});

test('one revision wins concurrent edits, native admin remains read-only, and pending handoff cannot be hidden by metadata or aliases',async t=>{
 const f=await fixture(t),created=(await f.create()).body.data;
 const edits=await Promise.all(['First alias','Second alias'].map(displayName=>f.call(`/${created.id}`,{method:'PATCH',body:{expectedRevision:1,displayName}})));assert.deepEqual(edits.map(r=>r.status).sort(),[200,409]);
 const phone=await f.json('/api/native/platform-admin/auth/login',{method:'POST',body:{email:'admin@calai.local',password:'SecureFleetAdmin!4310'}});assert.equal(phone.status,200,phone.text);const headers={authorization:'Bearer '+phone.body.data.token};
 assert.equal((await f.call('',{cookie:null,headers})).status,200);assert.equal((await f.call('',{cookie:null,headers,method:'POST',body:{displayName:'Phone change'}})).status,403);
 const disabled=await f.call(`/${created.id}/disable`,{method:'POST',body:{expectedRevision:2,reason:'Hold tablet access for security review'}});assert.equal(disabled.status,200,disabled.text);
 const alias=randomUUID(),now=f.config.now().toISOString();f.db.prepare('INSERT INTO business_accounts(id,name,created_at,updated_at) VALUES(?,?,?,?)').run(alias,'Canonical alias target',now,now);f.db.prepare('INSERT INTO business_account_aliases VALUES(?,?,?,?)').run(f.business.id,alias,f.session().user.id,now);
 assert.throws(()=>assertFleetNewEnrolmentAllowed(f.db,alias),e=>e.code==='TABLET_QUARANTINED');
});

test('a current administrator is rechecked after delayed body arrival before any mutation or audit',async t=>{
 const f=await fixture(t),session=f.session(),before=f.db.prepare('SELECT COUNT(*) n FROM admin_tablets').get().n;
 const req=Readable.from((async function*(){f.db.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').run(f.config.now().toISOString(),session.sessionId);yield Buffer.from(JSON.stringify({displayName:'Must not save'}));})());Object.assign(req,{method:'POST',headers:{'content-type':'application/json'}});
 const res={writeHead(){throw Error('Must fail before writing');},end(){}};
 await assert.rejects(routeTabletFleet({req,res,url:new URL('/api/admin/tablets',f.config.origin),db:f.db,config:f.config,session}),e=>e.status===401);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM admin_tablets').get().n,before);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='tablet_inventory_created'").get().n,0);
});

test('registration reconciliation uses an existing same-business identity and preserves its automatic inventory history',async t=>{
 const f=await fixture(t),record=(await f.create({serialNumber:'PHYSICAL-001'})).body.data,tablet=await enrolRegisteredTablet(f,{ownerCookie:f.owner});
 const mapped=await f.call(`/${record.id}/registration`,{method:'POST',body:{expectedRevision:1,terminalId:tablet.terminalId,confirmSamePhysicalDevice:true}});assert.equal(mapped.status,200,mapped.text);
 assert.equal(mapped.body.data.registration.terminalId,tablet.terminalId);assert.equal(mapped.body.data.mapping.provesHardwareIdentity,false);assert.equal(mapped.body.data.startup.physicallyVerifiedAt,null);
 const placeholder=await f.call(`/${tablet.terminalId}`);assert.equal(placeholder.body.data.supersededBy,record.id);assert.ok(placeholder.body.data.archivedAt);
 const listing=await f.call('');assert.equal(listing.body.data.items.filter(row=>row.registration?.terminalId===tablet.terminalId).length,1);
 const foreign=await f.create({businessId:f.otherBusiness.id});const denied=await f.call(`/${foreign.body.data.id}/registration`,{method:'POST',body:{expectedRevision:1,terminalId:tablet.terminalId,confirmSamePhysicalDevice:true}});assert.equal(denied.status,409);
});
