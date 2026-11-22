import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {journeyFixture} from './helpers.js';
import {HttpError} from '../src/http.js';
import {readSession} from '../src/auth/sessions.js';
import {readCalaiBusinessDirectory} from '../src/platform-admin.js';
const sourceId='b25f9f46-efb5-41b9-9a53-226b861df2fe',tenantId='b2222222-2222-4222-8222-222222222222',password='ChangedPlatformAdmin!4310';
async function fixture(){
 const now=new Date('2031-01-01T12:00:00.000Z'),state={active:true,requests:[],data:[{id:tenantId,name:'Calai native restaurant',status:'active',password:'must-not-leak',owner:{email:'must-not-leak'},plan:'Existing plan'}],onRead:null};
 const jwt=days=>['e30',Buffer.from(JSON.stringify({id:sourceId,role:'SYSTEM_OWNER',exp:Math.floor(now.getTime()/1000)+days*86400})).toString('base64url'),'synthetic_signature'].join('.');
 const authorize=()=>{if(!state.active)throw new HttpError(403,'CALAI_ADMIN_REQUIRED','Synthetic source denied');};
 const adapter={async login(){authorize();return{user:{id:sourceId,email:'source-admin@example.invalid',role:'SYSTEM_OWNER'},accessToken:jwt(1),refreshToken:jwt(7)};},async refresh(){authorize();return jwt(1);},async probe(){authorize();return true;},async request(method,path,body){authorize();state.requests.push({method,path,body});await state.onRead?.();return{status:200,success:true,data:state.data};}};
 const f=await journeyFixture({now:()=>now,platformAdmin:{enabled:true,readOnly:true,encryptionKey:randomBytes(32).toString('base64url'),adapter},rateLimit:{attempts:500,windowMs:60000}});
 let cookie=await f.login('admin@calai.local','LocalAdmin!4310');assert.equal((await f.json('/api/auth/password',{method:'POST',cookie,body:{currentPassword:'LocalAdmin!4310',newPassword:password}})).status,200);
 const session=()=>readSession(f.db,cookie.split('=')[1],f.config);
 async function link(){const result=await f.json('/api/admin/platform-connection/link',{method:'POST',cookie,body:{currentPassword:password,email:'source-admin@example.invalid',password:'SyntheticUpstream!4310'}});assert.equal(result.status,200,result.text);cookie=result.headers.get('set-cookie').split(';')[0];}
 return{...f,state,session,link,get cookie(){return cookie;}};
}
test('native Calai directory requires the existing separate current system-owner connection',async()=>{
 const f=await fixture();try{await assert.rejects(readCalaiBusinessDirectory(f.db,f.config,f.session()),error=>error.code==='PLATFORM_CONNECTION_REQUIRED');assert.equal(f.state.requests.length,0);await f.link();f.state.active=false;await assert.rejects(readCalaiBusinessDirectory(f.db,f.config,f.session()),error=>error.code==='CALAI_ADMIN_REQUIRED');assert.equal(f.state.requests.length,0);}finally{await f.close();}
});
test('directory calls only the fixed read route and returns minimal source-qualified references',async()=>{
 const f=await fixture();try{await f.link();const restaurants=f.db.prepare('SELECT COUNT(*) n FROM restaurants').get().n,mutations=f.db.prepare('SELECT COUNT(*) n FROM platform_admin_mutations').get().n;const rows=await readCalaiBusinessDirectory(f.db,f.config,f.session());assert.deepEqual(rows,[{id:tenantId,name:'Calai native restaurant',status:'active'}]);assert.deepEqual(f.state.requests,[{method:'GET',path:'/tenants',body:undefined}]);assert.equal(JSON.stringify(rows).includes('must-not-leak'),false);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM restaurants').get().n,restaurants);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM platform_admin_mutations').get().n,mutations);}finally{await f.close();}
});
test('directory response cannot escape a concurrent local session revocation',async()=>{
 const f=await fixture();try{await f.link();const session=f.session();f.state.onRead=()=>f.db.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').run(f.config.now().toISOString(),session.sessionId);await assert.rejects(readCalaiBusinessDirectory(f.db,f.config,session),error=>error.code==='PLATFORM_RECONNECT_REQUIRED');assert.equal(f.state.requests.length,1);}finally{await f.close();}
});
test('malformed, duplicate, case-colliding and excessive directories fail before importing metadata',async()=>{
 const f=await fixture();try{await f.link();const session=f.session();for(const value of [{tenants:[]},[{id:'not-an-id',name:'Native',status:'active'}],[{id:tenantId,name:'',status:'active'}],[{id:tenantId,name:'Native',status:'active'},{id:tenantId.toUpperCase(),name:'Other',status:'active'}],Array(10001).fill({id:tenantId,name:'Native',status:'active'})]){f.state.data=value;await assert.rejects(readCalaiBusinessDirectory(f.db,f.config,session),error=>error.code==='CALAI_DIRECTORY_INVALID');}assert.equal(f.db.prepare('SELECT COUNT(*) n FROM platform_admin_mutations').get().n,0);}finally{await f.close();}
});
test('administrator directory sync discovers Calai-only businesses without creating merchants or enabling products',async()=>{
 const f=await fixture();try{await f.link();const restaurants=f.db.prepare('SELECT COUNT(*) n FROM restaurants').get().n;let response=await f.json('/api/admin/business/accounts/sync-calai',{method:'POST',cookie:f.cookie,body:{}});assert.equal(response.status,200,response.text);assert.equal(response.body.data.imported,1);assert.equal(response.body.data.nativeCalaiUnchanged,true);const association=f.db.prepare("SELECT * FROM business_native_references WHERE product='calai' AND source_account_id=?").get(tenantId);assert.ok(association);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM business_product_links WHERE business_id=?").get(association.business_id).n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM restaurants').get().n,restaurants);const permissions=f.db.prepare('SELECT product,allowed FROM business_product_permissions WHERE business_id=? ORDER BY product').all(association.business_id);assert.deepEqual(permissions.map(row=>[row.product,row.allowed]),[['cal-eats',0],['calai',0]]);response=await f.json('/api/admin/business/accounts/sync-calai',{method:'POST',cookie:f.cookie,body:{}});assert.equal(response.status,200,response.text);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM business_native_references WHERE product='calai' AND source_account_id=?").get(tenantId).n,1);assert.equal(f.db.prepare("SELECT business_id FROM business_native_references WHERE product='calai' AND source_account_id=?").get(tenantId).business_id,association.business_id);assert.ok(f.state.requests.every(row=>row.method==='GET'&&row.path==='/tenants'));}finally{await f.close();}
});
