import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,scryptSync} from 'node:crypto';
import {journeyFixture} from './helpers.js';
import {hashPassword,passwordNeedsRehash} from '../src/auth/passwords.js';
import {loadPlatformAdminConfig} from '../src/platform-admin-config.js';
import {HttpError} from '../src/http.js';

const route='/api/platform-auth/local-login',email='admin@calai.local',password='LocalAdmin!4310';
const cookie=result=>result.headers.get('set-cookie').split(';',1)[0];
const count=f=>f.db.prepare('SELECT COUNT(*) n FROM sessions').get().n;

test('existing local administrator can start an unlinked setup even when federation is disabled, without source calls or provisioning',async()=>{
 let calls=0;const adapter={login:async()=>{calls++;throw Error('No source login expected');},refresh:async()=>{calls++;throw Error('No source refresh expected');},probe:async()=>{calls++;throw Error('No source probe expected');}};
 const f=await journeyFixture({rateLimit:{attempts:100,windowMs:60000},platformAdmin:{enabled:false,adapter}});try{
  const settings=await f.json('/api/platform-auth/settings');assert.equal(settings.body.data.localLoginAvailable,true);assert.equal(settings.body.data.loginAvailable,false);
  const users=f.db.prepare('SELECT COUNT(*) n FROM users').get().n,result=await f.json(route,{method:'POST',body:{email:' ADMIN@CALAI.LOCAL ',password}});assert.equal(result.status,200,result.text);assert.equal(result.body.data.user.role,'admin');assert.match(result.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);assert.equal(JSON.stringify(result.body).includes('password'),false);
  const current=await f.json('/api/admin/platform-connection',{cookie:cookie(result)});assert.equal(current.status,200,current.text);assert.equal(current.body.data.linked,false);assert.equal(current.body.data.session.federated,false);
  f.config.platformAdmin=loadPlatformAdminConfig({enabled:true,encryptionKey:randomBytes(32).toString('base64url'),adapter});
  const unlinked=await f.json(route,{method:'POST',body:{email,password}});assert.equal(unlinked.status,200,unlinked.text);assert.equal((await f.json('/api/platform-auth/settings')).body.data.loginAvailable,false);
  const link=await f.json('/api/admin/platform-connection/link',{method:'POST',cookie:cookie(unlinked),body:{currentPassword:password,email:'source@example.invalid',password:'NoSourceCall!4310'}});assert.equal(link.status,403,link.text);assert.equal(link.body.error.code,'PLATFORM_PASSWORD_SECURITY_REQUIRED');
  assert.equal(calls,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM users').get().n,users);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM platform_admin_links').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM platform_admin_sessions').get().n,0);
 }finally{await f.close();}
});

test('wrong-role, missing, incorrect and disabled accounts cannot receive or replace a local administrator session',async()=>{
 const f=await journeyFixture({rateLimit:{attempts:100,windowMs:60000}});try{
  const prior=await f.login(email,password),before=count(f);
  for(const input of [{email:'customer@calai.local',password:'LocalCustomer!4310'},{email:'restaurant@calai.local',password:'LocalRestaurant!4310'},{email,password:'WrongAdministrator!4310'},{email:'missing@example.invalid',password}]){
   const result=await f.json(route,{method:'POST',cookie:prior,body:input});assert.equal(result.status,401,result.text);assert.equal(result.body.error.code,'INVALID_CREDENTIALS');assert.equal(result.headers.has('set-cookie'),false);assert.equal(count(f),before);
  }
  f.db.prepare('UPDATE users SET account_enabled=0 WHERE email=?').run(email);const disabled=await f.json(route,{method:'POST',cookie:prior,body:{email,password}});assert.equal(disabled.status,401);assert.equal(disabled.headers.has('set-cookie'),false);assert.equal(count(f),before);
  f.db.prepare('UPDATE users SET account_enabled=1 WHERE email=?').run(email);assert.equal((await f.json('/api/auth/me',{cookie:prior})).status,200,'Failed attempts leave the previous valid session unchanged');
 }finally{await f.close();}
});

test('local administrator login shares the existing Origin protection and password rate-limit buckets',async()=>{
 const f=await journeyFixture({runMode:'hosted-preview',origin:'https://eats.calai.info',secureCookies:true,rateLimit:{attempts:2,windowMs:60000}});try{
  for(const headers of [{},{origin:'https://other.invalid'}]){const denied=await f.json(route,{method:'POST',headers,body:{email,password}});assert.equal(denied.status,403,denied.text);assert.equal(denied.body.error.code,'INVALID_ORIGIN');assert.equal(denied.headers.has('set-cookie'),false);}
  assert.equal(count(f),0);
  const headers={origin:f.config.origin};assert.equal((await f.json('/api/auth/login',{method:'POST',headers,body:{email,password:'IncorrectPassword!4310'}})).status,401);
  assert.equal((await f.json(route,{method:'POST',headers,body:{email:' ADMIN@CALAI.LOCAL ',password:'IncorrectPassword!4310'}})).status,401);
  const limited=await f.json(route,{method:'POST',headers,body:{email,password}});assert.equal(limited.status,429,limited.text);assert.equal(limited.headers.has('set-cookie'),false);assert.equal(count(f),0);
  assert.equal(f.db.prepare('SELECT attempt_count FROM auth_rate_limits WHERE bucket_key=?').get('identity:127.0.0.1|'+email).attempt_count,2);
 }finally{await f.close();}
});

test('local administrator login rehashes old credentials and rechecks password, role and account status after asynchronous verification',async()=>{
 const f=await journeyFixture({rateLimit:{attempts:100,windowMs:60000}});try{
  const salt=randomBytes(16),legacy=`scrypt$16384$8$1$${salt.toString('hex')}$${scryptSync(password,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024}).toString('hex')}`;
  f.db.prepare('UPDATE users SET password_hash=? WHERE email=?').run(legacy,email);const upgraded=await f.json(route,{method:'POST',body:{email,password}});assert.equal(upgraded.status,200,upgraded.text);const currentHash=f.db.prepare('SELECT password_hash FROM users WHERE email=?').get(email).password_hash;assert.equal(passwordNeedsRehash(currentHash),false);assert.notEqual(currentHash,legacy);
  const replacement=await hashPassword('ReplacementLocalAdmin!4310'),prepare=f.db.prepare;
  for(const [field,value] of [['role','restaurant'],['account_enabled',0],['password_hash',replacement]]){
   let changed=false;const before=count(f);
   f.db.prepare=function(sql,...args){const statement=prepare.call(this,sql,...args);if(sql==='SELECT * FROM users WHERE email=? AND account_enabled=1')return{get(...values){const row=statement.get(...values);if(!changed){changed=true;prepare.call(f.db,'UPDATE users SET '+field+'=? WHERE email=?').run(value,email);}return row;}};return statement;};
   let result;try{result=await f.json(route,{method:'POST',body:{email,password}});}finally{f.db.prepare=prepare;}
   assert.equal(changed,true);assert.equal(result.status,401,result.text);assert.equal(result.headers.has('set-cookie'),false);assert.equal(count(f),before,'A changed credential or role cannot mint a session');
   f.db.prepare("UPDATE users SET password_hash=?,role='admin',account_enabled=1 WHERE email=?").run(currentHash,email);
  }
 }finally{await f.close();}
});

test('a broken previous federated cookie cannot prevent explicit local administrator recovery',async()=>{
 let calls=0,available=true;const sourceId='c773c670-393c-4cad-a3a5-84dcbde0c7ea',now=()=>new Date('2026-01-01T01:00:00.000Z');
 const token=()=>[Buffer.from('{"alg":"HS256"}').toString('base64url'),Buffer.from(JSON.stringify({id:sourceId,role:'SYSTEM_OWNER',exp:Math.floor(now().getTime()/1000)+86400})).toString('base64url'),'synthetic_signature'].join('.');
 const check=()=>{calls++;if(!available)throw new HttpError(503,'CALAI_UNAVAILABLE','Synthetic unavailable');};
 const adapter={async login(){check();return{user:{id:sourceId,email:'source@example.invalid',role:'SYSTEM_OWNER'},accessToken:token(),refreshToken:token()};},async refresh(){check();return token();},async probe(){check();return true;}};
 const f=await journeyFixture({now,rateLimit:{attempts:100,windowMs:60000},platformAdmin:{enabled:true,encryptionKey:randomBytes(32).toString('base64url'),adapter}});try{
  const prior=await f.login(email,password),next='SecuredLocalAdmin!4310';assert.equal((await f.json('/api/auth/password',{method:'POST',cookie:prior,body:{currentPassword:password,newPassword:next}})).status,200);
  const linked=await f.json('/api/admin/platform-connection/link',{method:'POST',cookie:prior,body:{currentPassword:next,email:'source@example.invalid',password:'SyntheticSource!4310'}});assert.equal(linked.status,200,linked.text);assert.equal(linked.body.data.session.federated,true);
  available=false;const before=calls,recovery=await f.json(route,{method:'POST',cookie:cookie(linked),body:{email,password:next}});assert.equal(recovery.status,200,recovery.text);assert.equal(calls,before,'Recovery does not consult unavailable source authority');assert.notEqual(cookie(recovery),cookie(linked));
  const recovered=await f.json('/api/admin/platform-connection',{cookie:cookie(recovery)});assert.equal(recovered.status,200,recovered.text);assert.equal(recovered.body.data.linked,true);assert.equal(recovered.body.data.session.federated,false);assert.equal(calls,before);assert.equal((await f.json('/api/auth/me',{cookie:cookie(recovery)})).status,200);
 }finally{await f.close();}
});
