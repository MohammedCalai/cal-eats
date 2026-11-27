import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {journeyFixture} from './helpers.js';
import {HttpError} from '../src/http.js';
import {createSession,readSession} from '../src/auth/sessions.js';
import {ensureBusinessForRestaurant,routeUnifiedBusiness} from '../src/unified-business.js';
import {ensureBusinessProductPermissions} from '../src/business-product-policy.js';
export const SOURCE_USER='b25f9f46-efb5-41b9-9a53-226b861df2fe',SOURCE_BUSINESS='b2222222-2222-4222-8222-222222222222',SOURCE_PASSWORD='Synthetic Calai Password! ',EATS_PASSWORD='LocalRestaurant!4310';
export async function businessFixture({allowEats=true,nativeBothTabletId}={}){
 let time=Date.parse('2031-01-01T12:00:00Z');
 const state={id:SOURCE_USER,businessId:SOURCE_BUSINESS,email:'restaurant@calai.local',role:'BUSINESS_OWNER',available:true,active:true,reads:[],identities:0,logins:0,hook:null,readHook:null};
 const jwt=days=>['e30',Buffer.from(JSON.stringify({id:state.id,role:state.role,exp:Math.floor(time/1000)+days*86400})).toString('base64url'),'synthetic_signature'].join('.');
 const check=()=>{if(!state.available)throw new HttpError(503,'CALAI_UNAVAILABLE','Synthetic source unavailable');if(!state.active)throw new HttpError(403,'CALAI_RECONNECT_REQUIRED','Synthetic source inactive');};
 const adapter={
  async login(email,password){check();state.logins++;assert.equal(password,SOURCE_PASSWORD,'Preserve password whitespace');return{user:{id:state.id,businessId:state.businessId,email:state.email,firstName:'Calai',lastName:'Owner',role:state.role},accessToken:jwt(1),refreshToken:jwt(7)};},
  async refresh(){check();return jwt(1);},
  async identity(){check();state.identities++;await state.hook?.(state.identities);return{user:{id:state.id,role:state.role},business:{businessId:state.businessId,businessName:'Calai Business'}};},
  async read(section){check();state.reads.push(section);await state.readHook?.(section);if(section==='orders')return[{id:'c3333333-3333-4333-8333-333333333333',createdAt:new Date(time).toISOString(),customerName:'Synthetic phone customer',confirmationStatus:true,totalPrice:12.5,orderType:'delivery',password:'redacted',nested:{accessToken:'redacted'}}];return{section,apiKey:'redacted',nested:{password:'redacted',safe:true}};},
 };
 const integration={encryptionKey:randomBytes(32).toString('base64url'),adapter};
 const f=await journeyFixture({configureSeedBusinesses:false,nativeBothTabletId,now:()=>new Date(time),rateLimit:{attempts:500,windowMs:60000},businessIntegration:integration}),config={...f.config,businessIntegration:integration};
 const user=email=>f.db.prepare('SELECT id,name,email,role FROM users WHERE email=?').get(email),owner=user('restaurant@calai.local'),admin=user('admin@calai.local'),otherOwner=user('restaurant2@calai.local');
 const restaurant=f.db.prepare('SELECT r.* FROM restaurants r JOIN restaurant_memberships m ON m.restaurant_id=r.id WHERE m.user_id=? LIMIT 1').get(owner.id),business=ensureBusinessForRestaurant(f.db,restaurant.id,config);
 const sessionFor=user=>{const created=createSession(f.db,user.id,config);return readSession(f.db,created.token,config);},session=sessionFor(owner),adminSession=sessionFor(admin),otherSession=sessionFor(otherOwner);
 async function call(path,{method='GET',body,session:current=session}={}){
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(req,{method,url:path,session:current,headers:{host:config.expectedHost,origin:config.origin,...(body===undefined?{}:{'content-type':'application/json'})},socket:{remoteAddress:'127.0.0.1'}});
  let result;const res={writeHead(status,headers){result={status,headers};},end(value){result={...result,text:String(value??'')};}};
  try{const handled=await routeUnifiedBusiness({req,res,url:new URL(path,config.origin),db:f.db,config,session:current,checkRate:()=>{}});if(!handled&&!result)result={status:404,text:'{}'};}catch(error){result={status:error.status??500,text:JSON.stringify({error:{code:error.code??'INTERNAL',message:error.message}})};}
  return{...result,body:JSON.parse(result.text)};
 }
 const allow=(product,allowed=true,id=business.id)=>call(`/api/admin/business/accounts/${id}/products/${product}`,{method:'PATCH',session:adminSession,body:{allowed}});
 const prepare=(product='calai',{id=business.id,session:current=session,...extra}={})=>call(`/api/business/accounts/${id}/${product}/prepare-link`,{method:'POST',session:current,body:{email:product==='calai'?state.email:owner.email,password:product==='calai'?SOURCE_PASSWORD:EATS_PASSWORD,...extra}});
 const confirmCalai=(proof,{id=business.id,session:current=session,...extra}={})=>call(`/api/business/accounts/${id}/calai/link`,{method:'POST',session:current,body:{connectionToken:proof.body.data.connectionToken,expectedBusinessId:proof.body.data.sourceAccount.id,confirmLocation:true,...extra}});
 async function link({id=business.id,session:current=session,...extra}={}){const proof=await prepare('calai',{id,session:current});return proof.status===200?confirmCalai(proof,{id,session:current,...extra}):proof;}
 const sourceLogin=()=>call('/api/business/auth/calai/login',{method:'POST',session:null,body:{email:state.email,password:SOURCE_PASSWORD}}),responseSession=response=>readSession(f.db,response.headers['Set-Cookie'].split(';')[0].split('=')[1],config);
 async function registerSource({id=randomUUID(),allowed=false}={}){const now=config.now().toISOString();f.db.prepare('INSERT INTO business_accounts(id,name,created_at,updated_at) VALUES(?,?,?,?)').run(id,'Administratively discovered Calai restaurant',now,now);ensureBusinessProductPermissions(f.db,id,now);f.db.prepare("INSERT INTO business_native_references VALUES(?,'calai',?,?,?,?)").run(id,state.businessId,'Calai Business','active',now);if(allowed)assert.equal((await allow('calai',true,id)).status,200);return{id};}
 if(allowEats){const enabled=await allow('cal-eats');assert.equal(enabled.status,200,enabled.text);}
 return{...f,state,adapter,config,owner,admin,otherOwner,restaurant,business,session,adminSession,otherSession,call,allow,prepare,confirmCalai,link,sourceLogin,responseSession,sessionFor,registerSource,advance:ms=>{time+=ms;}};
}
