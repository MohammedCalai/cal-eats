import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {journeyFixture} from './helpers.js';
import {HttpError} from '../src/http.js';
import {tokenHash,readSession} from '../src/auth/sessions.js';
import {encryptPlatformTokens,decryptPlatformTokens,loadPlatformAdminConfig} from '../src/platform-admin-config.js';
import {createCalaiAdminAdapter} from '../src/calai-admin-adapter.js';
import {validatePlatformUpload} from '../src/platform-admin-uploads.js';
import {hashPassword} from '../src/auth/passwords.js';
import {createBackup,BACKUP_ROOT} from '../../../scripts/backup.js';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import {createApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import {migrations} from '../src/db/migrations.js';
import {openDatabase,migrateDatabase} from '../src/db/index.js';

const sourceId='b25f9f46-efb5-41b9-9a53-226b861df2fe',localPassword='ChangedPlatformAdmin!4310',upstreamPassword='SyntheticUpstream!4310';
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};};
function fake(clock){
 const state={id:sourceId,email:'upstream-admin@example.invalid',role:'SYSTEM_OWNER',active:true,verified:true,available:true,requests:[],refreshes:0,logins:0,probes:0,handler:null};
 const jwt=(days=1)=>[Buffer.from('{"alg":"HS256"}').toString('base64url'),Buffer.from(JSON.stringify({id:state.id,email:state.email,role:state.role,exp:Math.floor(clock()/1000)+days*86400})).toString('base64url'),'synthetic_signature'].join('.');
 const authorize=()=>{if(!state.available)throw new HttpError(503,'CALAI_UNAVAILABLE','Synthetic unavailable');if(!state.active)throw new HttpError(401,'CALAI_AUTHORITY_UNAVAILABLE','Synthetic inactive');};
 const adapter={async login(email,password){state.logins++;authorize();if(password!==upstreamPassword||(state.caseSensitiveEmail&&email!==state.email))throw new HttpError(401,'CALAI_SIGN_IN_FAILED','Synthetic bad credentials');return{user:{id:state.id,email:state.email,firstName:'Synthetic',lastName:'Administrator',role:state.role},accessToken:jwt(),refreshToken:jwt(7)};},async refresh(){state.refreshes++;authorize();return jwt();},async probe(){state.probes++;authorize();if(state.role!=='SYSTEM_OWNER'||!state.verified)throw new HttpError(403,'CALAI_ADMIN_REQUIRED','Synthetic denied');return true;},async request(method,path,body,accessToken){state.requests.push({method,path,body,accessToken});return state.handler?state.handler(method,path,body):{status:200,success:true,data:{id:sourceId,name:'Source tenant',password:'must-not-leak',nested:{accessToken:'must-not-leak'}}};}};
 return{state,adapter,jwt};
}
async function fixture(){let time=Date.parse('2026-01-01T01:00:00.000Z');const upstream=fake(()=>time),f=await journeyFixture({now:()=>new Date(time),rateLimit:{attempts:500,windowMs:60000},platformAdmin:{enabled:true,readOnly:false,encryptionKey:randomBytes(32).toString('base64url'),adapter:upstream.adapter}});let admin=await f.login('admin@calai.local','LocalAdmin!4310');const change=await f.json('/api/auth/password',{method:'POST',cookie:admin,body:{currentPassword:'LocalAdmin!4310',newPassword:localPassword}});assert.equal(change.status,200,change.text);
 const user=f.db.prepare("SELECT id FROM users WHERE email='admin@calai.local'").get(),session=f.db.prepare('SELECT id FROM sessions WHERE token_hash=?').get(tokenHash(admin.split('=')[1]));
 const link=async()=>{const result=await f.json('/api/admin/platform-connection/link',{method:'POST',cookie:admin,body:{currentPassword:localPassword,email:upstream.state.email,password:upstreamPassword}});if(result.status===200)admin=result.headers.get('set-cookie').split(';')[0];return result;};
 return {...f,...upstream,get admin(){return admin;},userId:user.id,get sessionId(){return f.db.prepare('SELECT id FROM sessions WHERE token_hash=?').get(tokenHash(admin.split('=')[1])).id;},link,advance:ms=>{time+=ms;}};
}

test('platform feature defaults off and rejects untrusted endpoints, weak keys and hosted adapter injection',()=>{
 assert.equal(loadPlatformAdminConfig().enabled,false);assert.throws(()=>loadPlatformAdminConfig({enabled:true}),/private/);assert.throws(()=>loadPlatformAdminConfig({origin:'https://evil.invalid'}),/origin/);assert.throws(()=>loadPlatformAdminConfig({encryptionKey:'short'}),/32-byte/);assert.throws(()=>loadPlatformAdminConfig({adapter:{}},{runMode:'hosted-preview'}),/local-test/);
 assert.equal(loadPlatformAdminConfig().responseLimitBytes,8*1024*1024);assert.throws(()=>loadPlatformAdminConfig({responseLimitBytes:33*1024*1024}),/response limit/);
 assert.equal(loadPlatformAdminConfig().readOnly,true);assert.throws(()=>loadPlatformAdminConfig({readOnly:'false'}),/boolean/);
});

test('link requires a secured local administrator and both identity proofs; login never provisions or matches by email',async()=>{
 const f=await fixture();try{
  for(const [email,password]of [['customer@calai.local','LocalCustomer!4310'],['restaurant@calai.local','LocalRestaurant!4310']]){const cookie=await f.login(email,password);assert.equal((await f.json('/api/admin/platform-connection',{cookie})).status,403);assert.equal((await f.json('/api/admin/platform-connection/link',{method:'POST',cookie,body:{currentPassword:password,email:f.state.email,password:upstreamPassword}})).status,403);}
  assert.equal(f.state.logins,0);
  const before=f.db.prepare('SELECT COUNT(*) n FROM users').get().n,unlinked=await f.json('/api/platform-auth/login',{method:'POST',body:{email:'admin@calai.local',password:upstreamPassword}});assert.equal(unlinked.status,403,unlinked.text);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM users').get().n,before);
  assert.equal((await f.json('/api/admin/calai/tenants',{cookie:f.admin})).status,403);assert.equal((await f.json('/api/auth/me',{cookie:f.admin})).status,200,'Unconnected source request must not destroy local recovery session');
  const linked=await f.link();assert.equal(linked.status,200,linked.text);assert.equal(linked.body.data.identity.id,sourceId);assert.equal(linked.body.data.session.federated,true);assert.equal(linked.body.data.capabilities.uploads,true);
  const row=f.db.prepare('SELECT * FROM platform_admin_sessions').get();assert.ok(row.encrypted_tokens.startsWith('v1.'));assert.ok(!row.encrypted_tokens.includes(f.jwt()));assert.ok(!JSON.stringify(linked.body).includes('refreshToken'));
  const signed=await f.json('/api/platform-auth/login',{method:'POST',body:{email:f.state.email,password:upstreamPassword}});assert.equal(signed.status,200,signed.text);assert.equal(signed.body.data.user.id,f.userId);assert.equal(signed.body.data.user.role,'admin');assert.match(signed.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);assert.ok(!JSON.stringify(signed.body).includes('Token'));
  f.state.id=randomUUID();assert.equal((await f.json('/api/platform-auth/login',{method:'POST',body:{email:f.state.email,password:upstreamPassword}})).status,403,'Same email with a different immutable Calai id must not sign in');
 }finally{await f.close();}
});

test('source requests are fixed and namespaced, redact secrets, and revalidate active/current role without a stale cache',async()=>{
 const f=await fixture();try{
  assert.equal((await f.link()).status,200);const before=f.state.refreshes;
  const first=await f.json('/api/admin/calai/tenants',{cookie:f.admin});assert.equal(first.status,200,first.text);assert.equal(first.body.meta.source,'calai');assert.equal(first.body.data.id,sourceId);assert.equal(first.body.data.password,undefined);assert.equal(first.body.data.nested.accessToken,undefined);assert.equal(f.db.prepare('SELECT 1 FROM restaurants WHERE id=?').get(sourceId),undefined);
  assert.equal((await f.json('/api/admin/calai/dashboard/operations?end=2026-01-02&start=2026-01-01',{cookie:f.admin})).status,200);assert.equal(f.state.refreshes,before+2);
  for(const path of ['/api/admin/calai/tenants/'+sourceId+'/impersonate','/api/admin/calai/https://evil.invalid','/api/admin/calai/tenants?url=https://evil.invalid','/api/admin/calai/../tenants','/api/admin/calai/individual-tenant/download/'+sourceId])assert.ok((await f.json(path,{cookie:f.admin})).status>=400,path);
  const calls=f.state.requests.length;f.state.active=false;const denied=await f.json('/api/admin/calai/tenants',{cookie:f.admin});assert.equal(denied.status,401,denied.text);assert.equal(f.state.requests.length,calls);assert.equal(f.db.prepare('SELECT encrypted_tokens FROM platform_admin_sessions WHERE session_id=?').get(f.sessionId).encrypted_tokens,null);assert.equal((await f.json('/api/auth/me',{cookie:f.admin})).status,401);
 }finally{await f.close();}
});

test('source email casing is preserved for the original case-sensitive login while account linking stays bound to immutable id',async()=>{
 const f=await fixture();try{
  f.state.email='Mixed.Case@Example.invalid';f.state.caseSensitiveEmail=true;const linked=await f.link();assert.equal(linked.status,200,linked.text);assert.equal(linked.body.data.identity.email,'Mixed.Case@Example.invalid');
  const signed=await f.json('/api/platform-auth/login',{method:'POST',body:{email:'  Mixed.Case@Example.invalid  ',password:upstreamPassword}});assert.equal(signed.status,200,signed.text);assert.equal(signed.body.data.user.id,f.userId);
  assert.equal((await f.json('/api/platform-auth/login',{method:'POST',body:{email:'mixed.case@example.invalid',password:upstreamPassword}})).status,401);
 }finally{await f.close();}
});

test('default read-only Calai connection permits linking and viewing but cannot dispatch any client-requested mutation or upload',async()=>{
 const f=await fixture();try{
  f.config.platformAdmin=loadPlatformAdminConfig({enabled:true,encryptionKey:f.config.platformAdmin.encryptionKey,adapter:f.adapter},{runMode:'local'});
  const linked=await f.link();assert.equal(linked.status,200,linked.text);assert.equal(linked.body.data.readOnly,true);assert.equal(linked.body.data.capabilities.read,true);assert.equal(linked.body.data.capabilities.write,false);assert.equal(linked.body.data.capabilities.uploads,false);
  assert.equal((await f.json('/api/admin/calai/tenants',{cookie:f.admin})).status,200);
  for(const [method,path]of [['POST','/tenants'],['PATCH','/tenants/'+sourceId],['DELETE','/tenants/'+sourceId],['POST','/agent/create'],['PATCH','/settings/logo']]){
   const denied=await f.json('/api/admin/calai'+path,{method,cookie:f.admin,headers:{'Idempotency-Key':'read-only-'+method+'-'+path.length},body:{readOnly:false,capabilities:{write:true,uploads:true}}});assert.equal(denied.status,403,denied.text);assert.equal(denied.body.error.code,'CALAI_READ_ONLY');
  }
  assert.equal(f.state.requests.filter(request=>request.method!=='GET').length,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM platform_admin_mutations').get().n,0);assert.equal((await f.json('/api/admin/workspace/users',{cookie:f.admin})).status,200,'Cal-Eats administration remains available');
 }finally{await f.close();}
});

test('linking never takes over another administrator identity and cross-origin attempts cannot contact Calai',async()=>{
 const f=await fixture();try{
  await f.link();const otherId=randomUUID(),old='OtherLocalAdmin!4310',next='OtherChangedAdmin!4310';f.db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?, 'admin',?)").run(otherId,'Other administrator','other-admin@example.invalid',await hashPassword(old),f.config.now().toISOString());const cookie=await f.login('other-admin@example.invalid',old);
  assert.equal((await f.json('/api/auth/password',{method:'POST',cookie,body:{currentPassword:old,newPassword:next}})).status,200);
  const attempted=await f.json('/api/admin/platform-connection/link',{method:'POST',cookie,body:{currentPassword:next,email:f.state.email,password:upstreamPassword}});assert.equal(attempted.status,409,attempted.text);assert.equal(attempted.body.error.code,'PLATFORM_IDENTITY_ALREADY_LINKED');assert.equal(f.db.prepare('SELECT user_id FROM platform_admin_links WHERE revoked_at IS NULL').get().user_id,f.userId);
  const calls=f.state.logins;assert.equal((await f.json('/api/admin/platform-connection/link',{method:'POST',cookie,headers:{Origin:'https://foreign.invalid'},body:{currentPassword:next,email:f.state.email,password:upstreamPassword}})).status,403);assert.equal(f.state.logins,calls);
  const disconnected=await f.json('/api/admin/platform-connection/link',{method:'DELETE',cookie:f.admin,body:{currentPassword:localPassword}});assert.equal(disconnected.status,200,disconnected.text);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM platform_admin_sessions WHERE encrypted_tokens IS NOT NULL').get().n,0);assert.equal((await f.json('/api/platform-auth/login',{method:'POST',body:{email:f.state.email,password:upstreamPassword}})).status,403);
 }finally{await f.close();}
});

test('upstream role/verification changes or failed authority checks prevent privileged local writes and wipe federated credentials',async()=>{
 const f=await fixture();try{
  f.state.verified=false;assert.equal((await f.link()).status,403);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM platform_admin_links').get().n,0);f.state.verified=true;await f.link();
  f.state.role='BUSINESS_OWNER';assert.equal((await f.json('/api/admin/calai/tenants',{cookie:f.admin})).status,403);assert.equal(f.state.requests.length,0);
  f.state.role='SYSTEM_OWNER';const local=await f.login('admin@calai.local',localPassword),reconnected=await f.json('/api/admin/platform-connection/link',{method:'POST',cookie:local,body:{currentPassword:localPassword,email:f.state.email,password:upstreamPassword}});assert.equal(reconnected.status,200);const connectedCookie=reconnected.headers.get('set-cookie').split(';')[0];
  f.state.available=false;const writes=f.db.prepare('SELECT COUNT(*) n FROM audit_events').get().n,result=await f.json('/api/admin/service-areas',{method:'POST',cookie:connectedCookie,body:{}});assert.equal(result.status,503,result.text);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM audit_events').get().n,writes);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM platform_admin_sessions WHERE encrypted_tokens IS NOT NULL').get().n,0);
 }finally{await f.close();}
});

test('disabled source identity cannot retain private Cal-Eats reads while static pages and local recovery remain available',async()=>{
 const f=await fixture();try{
  await f.link();const oldCookie=f.admin;assert.equal((await f.json('/api/admin/workspace/users',{cookie:oldCookie})).status,200);
  f.state.available=false;const checks=f.state.refreshes;
  for(const route of ['/business/login','/business/admin/dashboard','/download/']){const response=await f.request(route,{cookie:oldCookie});assert.equal(response.status,200,route);assert.match(response.headers.get('content-type'),/text\/html/);}
  assert.equal(f.state.refreshes,checks,'A source outage must not replace application HTML with an authentication JSON error');
  const recovery=await f.json('/api/auth/login',{method:'POST',cookie:oldCookie,body:{email:'admin@calai.local',password:localPassword}});assert.equal(recovery.status,200,recovery.text);const localCookie=recovery.headers.get('set-cookie').split(';')[0];assert.equal((await f.json('/api/admin/workspace/users',{cookie:localCookie})).status,200,'Explicit local recovery stays independent');
  f.state.available=true;f.state.active=false;const denied=await f.json('/api/admin/workspace/users',{cookie:oldCookie});assert.equal(denied.status,401,denied.text);assert.equal((await f.json('/api/auth/me',{cookie:oldCookie})).status,401);assert.equal(f.db.prepare('SELECT encrypted_tokens FROM platform_admin_sessions WHERE session_id=?').get(f.sessionId).encrypted_tokens,null);
 }finally{await f.close();}
});

test('single-flight checks cover only concurrent requests and late local revocation cannot publish source data',async()=>{
 const f=await fixture();try{
  await f.link();const original=f.adapter.refresh,entered=deferred(),release=deferred();f.adapter.refresh=async(...args)=>{entered.resolve();await release.promise;return original(...args);};
  const a=f.json('/api/admin/calai/tenants',{cookie:f.admin}),b=f.json('/api/admin/calai/telephony',{cookie:f.admin});await entered.promise;const before=f.state.refreshes;release.resolve();assert.equal((await a).status,200);assert.equal((await b).status,200);assert.equal(f.state.refreshes,before+1);
  f.adapter.refresh=original;const sourceEntered=deferred(),sourceRelease=deferred();f.state.handler=async()=>{sourceEntered.resolve();await sourceRelease.promise;return{status:200,success:true,data:{private:'must not return'}};};const pending=f.json('/api/admin/calai/tenants',{cookie:f.admin});await sourceEntered.promise;f.db.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').run(f.config.now().toISOString(),f.sessionId);sourceRelease.resolve();assert.equal((await pending).status,401);assert.equal(f.db.prepare('SELECT encrypted_tokens FROM platform_admin_sessions WHERE session_id=?').get(f.sessionId).encrypted_tokens,null);
 }finally{await f.close();}
});

test('link rotates opaque sessions and late refresh or link responses cannot wipe the replacement connection',async()=>{
 const f=await fixture();try{
  const originalCookie=f.admin;await f.link();assert.notEqual(f.admin,originalCookie);assert.equal((await f.json('/api/auth/me',{cookie:originalCookie})).status,401);
  const oldCookie=f.admin,oldId=f.sessionId,refresh=f.adapter.refresh,entered=deferred(),release=deferred();let held=false;
  f.adapter.refresh=async(...args)=>{if(!held){held=true;entered.resolve();await release.promise;throw new HttpError(503,'CALAI_UNAVAILABLE','Synthetic late failure');}return refresh(...args);};
  const stale=f.json('/api/admin/calai/tenants',{cookie:oldCookie});await entered.promise;const reconnected=await f.link();assert.equal(reconnected.status,200,reconnected.text);const newId=f.sessionId;assert.notEqual(newId,oldId);release.resolve();assert.equal((await stale).status,503);f.adapter.refresh=refresh;
  assert.equal((await f.json('/api/admin/calai/tenants',{cookie:f.admin})).status,200);assert.equal(f.db.prepare('SELECT encrypted_tokens FROM platform_admin_sessions WHERE session_id=?').get(oldId).encrypted_tokens,null);assert.ok(f.db.prepare('SELECT encrypted_tokens FROM platform_admin_sessions WHERE session_id=?').get(newId).encrypted_tokens);
  const login=f.adapter.login,authEntered=deferred(),authRelease=deferred();let first=true;f.adapter.login=async(...args)=>{if(first){first=false;authEntered.resolve();await authRelease.promise;}return login(...args);};
  const olderLink=f.link();await authEntered.promise;const latest=await f.link();assert.equal(latest.status,200,latest.text);const latestCookie=f.admin;authRelease.resolve();assert.equal((await olderLink).status,401);assert.equal(f.admin,latestCookie);assert.equal((await f.json('/api/admin/calai/tenants',{cookie:latestCookie})).status,200);
 }finally{await f.close();}
});

test('authority revoked immediately after proof storage cannot journal or dispatch a source mutation',async()=>{
 const f=await fixture();try{
  await f.link();const prepare=f.db.prepare.bind(f.db);let revoked=false;
  f.db.prepare=sql=>{const statement=prepare(sql);if(sql.startsWith('UPDATE platform_admin_sessions SET encrypted_tokens=?'))return {run(...args){const result=statement.run(...args);if(!revoked){revoked=true;prepare('UPDATE sessions SET revoked_at=? WHERE id=?').run(f.config.now().toISOString(),f.sessionId);}return result;}};return statement;};
  const result=await f.json('/api/admin/calai/tenants/'+sourceId,{method:'PATCH',cookie:f.admin,headers:{'Idempotency-Key':'revoked-before-dispatch'},body:{name:'Must not apply'}});assert.equal(result.status,401,result.text);assert.equal(f.state.requests.length,0);assert.equal(prepare('SELECT COUNT(*) n FROM platform_admin_mutations').get().n,0);f.db.prepare=prepare;
 }finally{await f.close();}
});

test('administrator mutations deduplicate exact requests durably and hold unknown outcomes without blind retries',async()=>{
 const f=await fixture();try{
  await f.link();const path='/api/admin/calai/tenants/'+sourceId,options={method:'PATCH',cookie:f.admin,headers:{'Idempotency-Key':'admin-update-one'},body:{name:'Updated tenant'}};
  const first=await f.json(path,options);assert.equal(first.status,200,first.text);assert.equal(first.body.meta.state,'confirmed');const replay=await f.json(path,options);assert.deepEqual(replay.body,first.body);assert.equal(f.state.requests.length,1);
  assert.equal((await f.json(path,{...options,body:{name:'Different intent'}})).status,409);assert.equal((await f.json(path,{...options,headers:{}})).status,400);assert.equal(f.state.requests.length,1);
  f.state.handler=async()=>{throw Error('Synthetic lost success response');};const uncertain=await f.json(path,{...options,headers:{'Idempotency-Key':'admin-update-unknown'},body:{status:'suspended'}});assert.equal(uncertain.status,409);assert.equal(uncertain.body.error.code,'CALAI_MUTATION_UNCERTAIN');assert.equal(uncertain.body.meta.state,'unknown');
  const id=uncertain.body.meta.requestId,check=await f.json('/api/admin/platform-connection/requests/'+id,{cookie:f.admin});assert.equal(check.body.data.status,'unknown');assert.equal(check.body.data.canRetry,false);
  assert.equal((await f.json(path,{...options,headers:{'Idempotency-Key':'admin-update-unknown'},body:{status:'suspended'}})).body.meta.requestId,id);
  assert.equal((await f.json(path,{...options,headers:{'Idempotency-Key':'fresh-key-no-blind-retry'},body:{status:'suspended'}})).body.meta.requestId,id);assert.equal(f.state.requests.length,2);
  const stored=JSON.stringify(f.db.prepare('SELECT * FROM platform_admin_mutations').all());assert.ok(!stored.includes(upstreamPassword));assert.ok(!stored.includes('must-not-leak'));assert.ok(!stored.includes(f.jwt()));
 }finally{await f.close();}
});

test('delegated source telephony400 is held as an uncertain effect and never retried with the same or a fresh key',async()=>{
 const f=await fixture();try{
  await f.link();f.state.handler=async()=>({status:400,success:false,data:null});const body={assistant_id:sourceId,twilio_number:'+441234567890',manager_number:'+447000000000',businessId:sourceId},options={method:'POST',cookie:f.admin,headers:{'Idempotency-Key':'telephony-delegated-unknown'},body};
  const first=await f.json('/api/admin/calai/telephony',options);assert.equal(first.status,409,first.text);assert.equal(first.body.meta.state,'unknown');const id=first.body.meta.requestId;
  assert.equal((await f.json('/api/admin/calai/telephony',options)).body.meta.requestId,id);assert.equal((await f.json('/api/admin/calai/telephony',{...options,headers:{'Idempotency-Key':'telephony-fresh-no-retry'}})).body.meta.requestId,id);assert.equal(f.state.requests.length,1);
 }finally{await f.close();}
});

test('uppercase source UUIDs cannot bypass an uncertain tenant, telephony or agent operation and UUID query values are canonical',async()=>{
 const f=await fixture();try{
  await f.link();f.state.handler=async()=>({status:400,success:false,data:null});const changes=[['/tenants/'+sourceId,{name:'Case-normalized tenant'}],['/telephony/'+sourceId,{twilioNumber:'+441234567890'}],['/agent/'+sourceId+'/special-offers',{enabled:true}]];
  for(const [index,[path,body]]of changes.entries()){
   const lower='/api/admin/calai'+path,upper='/api/admin/calai'+path.replace(sourceId,sourceId.toUpperCase()),options={method:'PATCH',cookie:f.admin,headers:{'Idempotency-Key':'case-lower-'+index},body},first=await f.json(lower,options);assert.equal(first.status,409,first.text);assert.equal(first.body.meta.state,'unknown');const count=f.state.requests.length;
   const sameKey=await f.json(upper,options);assert.equal(sameKey.status,409,sameKey.text);assert.equal(sameKey.body.meta.requestId,first.body.meta.requestId);const newKey=await f.json(upper,{...options,headers:{'Idempotency-Key':'case-upper-'+index}});assert.equal(newKey.status,409,newKey.text);assert.equal(newKey.body.meta.requestId,first.body.meta.requestId);assert.equal(f.state.requests.length,count);assert.equal(f.state.requests.at(-1).path,path);
  }
  f.state.handler=async()=>({status:200,success:true,data:[]});const list=await f.json('/api/admin/calai/agent?'+new URLSearchParams({businessId:sourceId.toUpperCase()}),{cookie:f.admin});assert.equal(list.status,200,list.text);assert.equal(f.state.requests.at(-1).path,'/agent?businessId='+sourceId);
 }finally{await f.close();}
});

test('unlink/relink recovery preserves uncertain operation identity and cannot redispatch with a new modal key',async()=>{
 const f=await fixture();try{
  await f.link();f.state.handler=async()=>({status:400,success:false,data:null});const route='/api/admin/calai/telephony',body={assistant_id:sourceId,twilio_number:'+441234567890',manager_number:'+447000000000',businessId:sourceId},options={method:'POST',cookie:f.admin,headers:{'Idempotency-Key':'uncertain-before-reconnect'},body},first=await f.json(route,options);assert.equal(first.body.meta.state,'unknown');const id=first.body.meta.requestId,oldLink=f.db.prepare('SELECT id FROM platform_admin_links WHERE revoked_at IS NULL').get().id;
  assert.equal((await f.json('/api/admin/platform-connection/link',{method:'DELETE',cookie:f.admin,body:{currentPassword:localPassword}})).status,200);const recovery=await f.login('admin@calai.local',localPassword),linked=await f.json('/api/admin/platform-connection/link',{method:'POST',cookie:recovery,body:{currentPassword:localPassword,email:f.state.email,password:upstreamPassword}});assert.equal(linked.status,200,linked.text);const cookie=linked.headers.get('set-cookie').split(';')[0];assert.notEqual(f.db.prepare('SELECT id FROM platform_admin_links WHERE revoked_at IS NULL').get().id,oldLink);
  const exact=await f.json(route,{...options,cookie});assert.equal(exact.status,409);assert.equal(exact.body.meta.requestId,id);const fresh=await f.json(route,{...options,cookie,headers:{'Idempotency-Key':'new-modal-after-reconnect'}});assert.equal(fresh.status,409);assert.equal(fresh.body.meta.requestId,id);assert.equal(f.state.requests.length,1);
 }finally{await f.close();}
});

test('lost-response aliases recover by GET only and source resource holds survive key rotation and changed-payload retries',async()=>{
 const f=await fixture();try{
  await f.link();f.state.handler=async()=>({status:400,success:false,data:null});const route='/api/admin/calai/tenants/'+sourceId,options={method:'PATCH',cookie:f.admin,headers:{'Idempotency-Key':'lost-first-reference'},body:{name:'Initial uncertain change'}};
  await f.json(route,options); // Deliberately discard the entire dispatch response.
  const lookup=key=>'/api/admin/platform-connection/requests/lookup?'+new URLSearchParams({key}),first=await f.json(lookup('lost-first-reference'),{cookie:f.admin});assert.equal(first.status,200,first.text);const id=first.body.data.id;assert.equal(first.body.data.status,'unknown');assert.equal(f.state.requests.length,1);
  await f.json(route,{...options,headers:{'Idempotency-Key':'lost-alias-reference'},body:{name:'Changed payload must still be held'}});const alias=await f.json(lookup('lost-alias-reference'),{cookie:f.admin});assert.equal(alias.status,200,alias.text);assert.equal(alias.body.data.id,id);assert.equal(f.state.requests.length,1);
  assert.equal((await f.json(lookup('missing-reference'),{cookie:f.admin})).status,404);assert.equal((await f.json(lookup('lost-alias-reference')+'&key=duplicate',{cookie:f.admin})).status,400);
  const customer=await f.login('customer@calai.local','LocalCustomer!4310');assert.equal((await f.json(lookup('lost-alias-reference'),{cookie:customer})).status,403);
  f.config.platformAdmin=loadPlatformAdminConfig({enabled:true,readOnly:false,encryptionKey:randomBytes(32).toString('base64url'),adapter:f.adapter},{runMode:'local'});assert.equal((await f.json('/api/auth/me',{cookie:f.admin})).status,401);
  const local=await f.login('admin@calai.local',localPassword),linked=await f.json('/api/admin/platform-connection/link',{method:'POST',cookie:local,body:{currentPassword:localPassword,email:f.state.email,password:upstreamPassword}});assert.equal(linked.status,200,linked.text);const cookie=linked.headers.get('set-cookie').split(';')[0];
  const held=await f.json(route,{...options,cookie,headers:{'Idempotency-Key':'after-key-rotation'},body:{name:'Different body under a new encryption key'}});assert.equal(held.status,409,held.text);assert.equal(held.body.meta.requestId,id);assert.equal((await f.json(lookup('after-key-rotation'),{cookie})).body.data.id,id);assert.equal(f.state.requests.length,1);
  const reviewed=await f.json('/api/admin/platform-connection/requests/'+id+'/check',{method:'POST',cookie,body:{currentPassword:localPassword,result:'not_applied',note:'Inspected the source tenant and verified no previous name change was applied.'}});assert.equal(reviewed.status,200,reviewed.text);
  f.state.handler=async()=>({status:200,success:true,data:{id:sourceId}});assert.equal((await f.json(route,{...options,cookie,headers:{'Idempotency-Key':'explicit-after-reviewed-rotation'}})).status,200);assert.equal(f.state.requests.length,2);
 }finally{await f.close();}
});

test('operator checks are reauthenticated, audited and distinct from provider confirmation; only a separate new intent can follow not_applied',async()=>{
 const f=await fixture();try{
  await f.link();f.state.handler=async()=>({status:400,success:false,data:null});const route='/api/admin/calai/tenants/'+sourceId,options={method:'PATCH',cookie:f.admin,headers:{'Idempotency-Key':'operator-check-unknown'},body:{status:'suspended'}},unknown=await f.json(route,options),id=unknown.body.meta.requestId,check='/api/admin/platform-connection/requests/'+id+'/check',body={currentPassword:localPassword,result:'not_applied',note:'Inspected Calai tenant status and confirmed the change was not applied.'};
  assert.equal((await f.json(check,{method:'POST',cookie:f.admin,body:{...body,currentPassword:'WrongPassword!4310'}})).status,403);assert.equal(f.db.prepare('SELECT status FROM platform_admin_mutations WHERE id=?').get(id).status,'unknown');
  f.db.prepare("UPDATE platform_admin_mutations SET status='dispatching' WHERE id=?").run(id);assert.equal((await f.json(check,{method:'POST',cookie:f.admin,body})).status,409,'Do not close a request that is still inside its processing window');f.db.prepare("UPDATE platform_admin_mutations SET status='unknown' WHERE id=?").run(id);
  const checked=await f.json(check,{method:'POST',cookie:f.admin,body});assert.equal(checked.status,200,checked.text);assert.equal(checked.body.data.status,'operator_reported_not_applied');assert.equal(checked.body.data.providerConfirmed,false);assert.equal(checked.body.data.canSubmitNewIntent,true);assert.equal(checked.body.data.canRetry,false);assert.equal(checked.body.data.review.reportedBy,'operator');assert.equal(f.state.requests.length,1);
  const audits=f.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='platform_request_operator_checked'").get().n;assert.equal((await f.json(check,{method:'POST',cookie:f.admin,body})).status,200);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='platform_request_operator_checked'").get().n,audits);assert.equal((await f.json(check,{method:'POST',cookie:f.admin,body:{...body,result:'applied'}})).status,409);
  const closed=await f.json(route,options);assert.equal(closed.status,409);assert.equal(closed.body.error.code,'CALAI_MUTATION_REVIEWED');assert.equal(f.state.requests.length,1);
  f.state.handler=async()=>({status:200,success:true,data:{id:sourceId}});const next=await f.json(route,{...options,headers:{'Idempotency-Key':'operator-explicit-new-intent'}});assert.equal(next.status,200,next.text);assert.equal(f.state.requests.length,2);const completed=await f.json('/api/admin/platform-connection/requests/'+next.body.meta.requestId+'/check',{method:'POST',cookie:f.admin,body:{...body,result:'applied'}});assert.equal(completed.status,409);assert.equal(completed.body.error.code,'CALAI_REVIEW_NOT_NEEDED');
 }finally{await f.close();}
});

test('logo preview resolves only server-owned source metadata and serves signature-checked same-origin image bytes',async()=>{
 const f=await fixture();try{
  await f.link();const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlJJOEAAAAASUVORK5CYII=','base64'),images=[];f.state.handler=async()=>({status:200,success:true,data:{logoUrl:'/uploads/platform/logo.png'}});f.adapter.image=async url=>{images.push(url);return {mimeType:'text/html',bytes:png};};
  const route='/api/admin/calai/settings/logo/image',result=await f.request(route,{cookie:f.admin});assert.equal(result.status,200,result.text);assert.equal(result.headers.get('content-type'),'image/png');assert.equal(result.headers.get('cache-control'),'no-store');assert.equal(result.headers.get('x-content-type-options'),'nosniff');assert.equal(result.headers.get('set-cookie'),undefined);assert.equal(result.headers.get('location'),undefined);assert.deepEqual(result.bodyBuffer,png);assert.deepEqual(images,['https://api.calai.info/uploads/platform/logo.png']);
  assert.equal((await f.request(route+'?url=https://evil.invalid/image.png',{cookie:f.admin})).status,400);assert.equal(images.length,1);
  f.state.handler=async()=>({status:200,success:true,data:{logoUrl:'https://evil.invalid/uploads/logo.png'}});assert.equal((await f.request(route,{cookie:f.admin})).status,502);assert.equal(images.length,1);
  f.state.handler=async()=>({status:200,success:true,data:{logoUrl:'/uploads/platform/logo.png'}});f.adapter.image=async()=>({mimeType:'image/png',bytes:Buffer.from('<html>must never serve</html>')});assert.equal((await f.request(route,{cookie:f.admin})).status,502);
 }finally{await f.close();}
});

test('logo transport has fixed origin, bounded binary bytes and no credential/header or redirect forwarding',async()=>{
 const calls=[],png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlJJOEAAAAASUVORK5CYII=','base64'),adapter=createCalaiAdminAdapter({fetchImpl:async(url,options)=>{calls.push({url:String(url),options});return new Response(png,{status:200,headers:{'content-type':'text/html','set-cookie':'must-not-forward=private'}});}});
 const result=await adapter.image('/uploads/platform/logo.png');assert.equal(result.mimeType,'image/png');assert.deepEqual(result.bytes,png);assert.equal(calls[0].url,'https://api.calai.info/uploads/platform/logo.png');assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.headers.authorization,undefined);assert.equal(calls[0].options.headers.cookie,undefined);await assert.rejects(adapter.image('https://evil.invalid/uploads/logo.png'),error=>error.code==='CALAI_LOGO_INVALID');assert.equal(calls.length,1);
 const redirect=createCalaiAdminAdapter({fetchImpl:async()=>new Response('',{status:302,headers:{location:'https://evil.invalid/logo.png'}})});await assert.rejects(redirect.image('/uploads/platform/logo.png'),error=>error.code==='CALAI_LOGO_INVALID');
});

test('scoped upload JSON becomes validated transient files and its durable replay contains no raw documents or private filename',async()=>{
 const f=await fixture();try{
  await f.link();const pdf=Buffer.from('%PDF-1.7\nSynthetic training document marker\n%%EOF'),file=(field,name='client-private-'+field+'.pdf')=>({field,name,mimeType:'application/pdf',base64:pdf.toString('base64')}),options={method:'POST',cookie:f.admin,headers:{'Idempotency-Key':'training-upload-create'},body:{fields:{businessId:sourceId,agent_name:'Synthetic training'},files:[file('rules_file'),file('menu_file')]}};
  const first=await f.json('/api/admin/calai/agent/create',options);assert.equal(first.status,200,first.text);assert.equal(first.body.meta.state,'confirmed');const forwarded=f.state.requests[0];assert.equal(forwarded.path,'/agent/create');assert.ok(Buffer.isBuffer(forwarded.body.files[0].bytes));assert.deepEqual(forwarded.body.files[0].bytes,pdf);assert.ok(!forwarded.body.files[0].name.includes('client-private'));
  const renamed={fields:options.body.fields,files:[file('menu_file','renamed-menu.pdf'),file('rules_file','renamed-rules.pdf')]},replay=await f.json('/api/admin/calai/agent/create',{...options,body:renamed});assert.equal(replay.status,200,replay.text);assert.deepEqual(replay.body,first.body);assert.equal(f.state.requests.length,1);
  const special=await f.json('/api/admin/calai/agent/upload-special-offers',{method:'POST',cookie:f.admin,headers:{'Idempotency-Key':'special-offers-upload'},body:{fields:{assistant_id:sourceId},files:[file('special_offers_file')]}});assert.equal(special.status,200,special.text);
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlJJOEAAAAASUVORK5CYII=',logo=await f.json('/api/admin/calai/settings/logo',{method:'PATCH',cookie:f.admin,headers:{'Idempotency-Key':'branding-logo-upload'},body:{fields:{},files:[{field:'logo',name:'business-logo.png',mimeType:'image/png',base64:png}]}});assert.equal(logo.status,200,logo.text);
  const bad=await f.json('/api/admin/calai/agent/create',{...options,headers:{'Idempotency-Key':'bad-path-upload'},body:{fields:options.body.fields,files:[file('rules_file','../rules.pdf'),file('menu_file')]}});assert.ok(bad.status>=400);assert.equal(f.state.requests.length,3);
  const stored=JSON.stringify(f.db.prepare('SELECT * FROM platform_admin_mutations').all());assert.ok(!stored.includes(pdf.toString('utf8')));assert.ok(!stored.includes(pdf.toString('base64')));assert.ok(!stored.includes('client-private'));assert.ok(!stored.includes(png));
 }finally{await f.close();}
});

test('actual adapter constructs only fixed multipart requests without forwarding client content-type or writing files',async()=>{
 const calls=[],adapter=createCalaiAdminAdapter({fetchImpl:async(url,options)=>{calls.push({url:String(url),options});return new Response(JSON.stringify({success:true,data:{id:sourceId}}),{status:200,headers:{'content-type':'application/json'}});}}),pdf=Buffer.from('%PDF-1.7\nSynthetic wire fixture\n%%EOF'),upload=validatePlatformUpload('createAgentUpload',{fields:{businessId:sourceId,agent_name:'Wire fixture'},files:['rules_file','menu_file'].map(field=>({field,name:field+'.pdf',mimeType:'application/pdf',base64:pdf.toString('base64')}))});
 await adapter.request('POST','/agent/create',upload,'synthetic-private-access');assert.equal(calls[0].url,'https://api.calai.info/api/system-owner/agent/create');assert.equal(calls[0].options.headers['content-type'],undefined);assert.equal(calls[0].options.headers.authorization,'Bearer synthetic-private-access');assert.ok(calls[0].options.body instanceof FormData);assert.equal(calls[0].options.body.get('businessId'),sourceId);assert.equal(calls[0].options.body.get('agent_name'),'Wire fixture');assert.deepEqual(Buffer.from(await calls[0].options.body.get('rules_file').arrayBuffer()),pdf);assert.equal(calls[0].options.redirect,'error');
});

test('cryptographic AAD, tamper handling, absolute expiry and logout keep upstream tokens out of restored browser authority',async()=>{
 const f=await fixture();try{
  const encrypted=encryptPlatformTokens(f.config,{refreshToken:'synthetic-private-token'},'session-one');assert.throws(()=>decryptPlatformTokens(f.config,encrypted,'session-two'),/Reconnect/);
  await f.link();const row=f.db.prepare('SELECT * FROM platform_admin_sessions').get(),expires=row.absolute_expires_at;
  assert.equal((await f.json('/api/admin/calai/tenants',{cookie:f.admin})).status,200);assert.equal(f.db.prepare('SELECT absolute_expires_at FROM platform_admin_sessions').get().absolute_expires_at,expires);
  const out=await f.json('/api/auth/logout',{method:'POST',cookie:f.admin,body:{}});assert.equal(out.status,200);assert.equal(f.db.prepare('SELECT encrypted_tokens FROM platform_admin_sessions').get().encrypted_tokens,null);assert.equal(readSession(f.db,f.admin.split('=')[1],f.config),null);
  const signed=await f.json('/api/platform-auth/login',{method:'POST',body:{email:f.state.email,password:upstreamPassword}});assert.equal(signed.status,200,signed.text);const cookie=signed.headers.get('set-cookie').split(';')[0];f.advance(4*3600000+1);assert.equal((await f.json('/api/auth/me',{cookie})).status,401);
 }finally{await f.close();}
});

test('JSON adapter follows the fixed production origin without redirects and does not forward provider cookies/data errors',async()=>{
 const calls=[],now=Math.floor(Date.now()/1000),jwt=Buffer.from('{}').toString('base64url')+'.'+Buffer.from(JSON.stringify({id:sourceId,role:'SYSTEM_OWNER',exp:now+3600})).toString('base64url')+'.signature';
 const adapter=createCalaiAdminAdapter({fetchImpl:async(url,options)=>{calls.push({url:String(url),options});return new Response(JSON.stringify({success:true,data:{user:{id:sourceId,role:'SYSTEM_OWNER'},accessToken:jwt}}),{status:200,headers:{'set-cookie':'refreshToken='+jwt+'; HttpOnly; Secure; SameSite=Strict','content-type':'application/json'}});}});
 const result=await adapter.login('synthetic@example.invalid','synthetic-password');assert.equal(result.refreshToken,jwt);await adapter.refresh(jwt);await adapter.probe(jwt);assert.ok(calls.every(call=>call.url.startsWith('https://api.calai.info/api/')&&call.options.redirect==='error'));assert.equal(calls[1].options.headers.cookie,'refreshToken='+jwt);assert.equal(calls[2].options.headers.authorization,'Bearer '+jwt);
 assert.throws(()=>adapter.request('GET','//evil.invalid',undefined,jwt),/unavailable/);
});

test('adapter data limits are bounded separately from authentication and never return truncated complete lists',async()=>{
 const large={success:true,data:[{name:'x'.repeat(1024*1024+1)}]},fetchImpl=async()=>new Response(JSON.stringify(large),{status:200,headers:{'content-type':'application/json'}});
 const adapter=createCalaiAdminAdapter({fetchImpl}),accepted=await adapter.request('GET','/tenants',undefined,'synthetic-token');assert.equal(accepted.data[0].name.length,1024*1024+1);
 const small=createCalaiAdminAdapter({fetchImpl,maxResponseBytes:1024*1024});await assert.rejects(small.request('GET','/tenants',undefined,'synthetic-token'),error=>error.status===502&&error.code==='CALAI_RESPONSE_INVALID');await assert.rejects(adapter.login('synthetic@example.invalid','synthetic-password'),error=>error.status===502&&error.code==='CALAI_RESPONSE_INVALID');
});

test('sanitized backups cannot restore upstream tokens, linked authority or a federated browser as local administrator',async()=>{
 const f=await fixture(),destination=path.join(BACKUP_ROOT,'platform-admin-'+randomUUID()+'.sqlite');try{
  await f.link();const original=f.db.prepare('SELECT encrypted_tokens FROM platform_admin_sessions WHERE session_id=?').get(f.sessionId).encrypted_tokens;
  await createBackup({source:f.config.dbPath,destination});const restored=new DatabaseSync(destination,{readOnly:true});try{
   assert.equal(restored.prepare('SELECT COUNT(*) n FROM platform_admin_sessions').get().n,0);assert.ok(restored.prepare('SELECT revoked_at FROM sessions WHERE id=?').get(f.sessionId).revoked_at);assert.ok(restored.prepare('SELECT revoked_at FROM platform_admin_links').get().revoked_at);assert.equal(restored.prepare('PRAGMA foreign_key_check').all().length,0);assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{restored.close();}assert.equal(f.db.prepare('SELECT encrypted_tokens FROM platform_admin_sessions WHERE session_id=?').get(f.sessionId).encrypted_tokens,original);assert.equal(fs.readFileSync(destination).includes(Buffer.from(original)),false);
 }finally{fs.rmSync(destination,{force:true});fs.rmSync(destination+'.media.json',{force:true});await f.close();}
});

test('populated schema65 upgrades to the current schema idempotently without changing accounts, restaurant or order financial snapshots',async()=>{
 const db=openDatabase(':memory:');try{
  db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for(const migration of migrations.filter(item=>item.version<=65)){if(migration.foreignKeysOff)db.exec('PRAGMA foreign_keys=OFF');db.exec('BEGIN IMMEDIATE');db.exec(migration.sql);db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(migration.version,migration.name,'2026-01-01T00:00:00.000Z');db.exec('COMMIT');if(migration.foreignKeysOff)db.exec('PRAGMA foreign_keys=ON');}
  const stamp='2026-01-01T00:00:00.000Z';db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES('admin-before','Administrator','before@example.invalid','opaque-existing-password','admin',?)").run(stamp);db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES('customer-before','Customer','customer-before@example.invalid','opaque-customer-password','customer',?)").run(stamp);db.prepare("INSERT INTO restaurants(id,name,status,created_at) VALUES('restaurant-before','Existing restaurant','approved',?)").run(stamp);db.prepare("INSERT INTO orders(id,restaurant_id,restaurant_name,customer_id,status,subtotal_minor,delivery_fee_minor,total_minor,commission_minor,payment_method,payment_status,fulfillment,idempotency_key,request_hash,created_at,updated_at) VALUES('paid-before','restaurant-before','Existing restaurant','customer-before','completed',400,0,400,28,'card','stripe_captured','collection','before','before',?,?)").run(stamp,stamp);
  const accounts=db.prepare('SELECT * FROM users ORDER BY id').all(),order=db.prepare('SELECT * FROM orders').get(),restaurant=db.prepare('SELECT * FROM restaurants').get();migrateDatabase(db);migrateDatabase(db);assert.deepEqual(db.prepare('SELECT '+Object.keys(accounts[0]).join(',')+' FROM users ORDER BY id').all(),accounts);assert.ok(db.prepare('SELECT principal_kind FROM users').all().every(row=>row.principal_kind==='human'));assert.deepEqual(db.prepare('SELECT * FROM orders').get(),order);assert.deepEqual(db.prepare('SELECT '+Object.keys(restaurant).join(',')+' FROM restaurants').get(),restaurant);assert.equal(db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v,migrations.at(-1).version);assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
 }finally{db.close();}
});
