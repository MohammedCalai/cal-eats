import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {HttpError} from './http.js';

export const CALAI_BUSINESS_ORIGIN='https://api.calai.info';
const failure=(status=503,code='CALAI_UNAVAILABLE')=>new HttpError(status,code,
  status===503?'Calai is temporarily unavailable. Cal-Eats remains available.':'Reconnect the authorised Calai business account.');
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isSourceId=value=>typeof value==='string'&&ID.test(value);
export function unifiedBusinessIntegrationConfig(config){
  const input=config.businessIntegration??{},encoded=input.encryptionKey??process.env.CALAI_BUSINESS_ENCRYPTION_KEY??config.platformAdmin?.encryptionKey??null;
  if(encoded!==null&&(typeof encoded!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(encoded)||Buffer.from(encoded,'base64url').length!==32))throw Error('Business integration requires a private 32-byte encryption key');
  if(input.adapter&&config.runMode!=='local')throw Error('Injected business adapters are local-test only');
  return{encryptionKey:encoded,adapter:input.adapter??null};
}
const aad=row=>`CAL-EATS-BUSINESS-LINK-V1\n${row.id}\n${row.business_id}\n${row.provider_origin}\n${row.upstream_user_id}\n${row.source_account_id}`;
export function encryptCalaiBusinessCredentials(config,row,value){
  const encoded=unifiedBusinessIntegrationConfig(config).encryptionKey;if(!encoded)throw failure(503,'CALAI_BUSINESS_NOT_CONFIGURED');
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(encoded,'base64url'),iv);cipher.setAAD(Buffer.from(aad(row)));
  return ['v1',iv.toString('base64url'),Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]).toString('base64url'),cipher.getAuthTag().toString('base64url')].join('.');
}
export function decryptCalaiBusinessCredentials(config,row){
  try{const encoded=unifiedBusinessIntegrationConfig(config).encryptionKey;if(!encoded)throw Error();const[version,iv,data,tag,...extra]=String(row.encrypted_credentials).split('.');if(version!=='v1'||extra.length)throw Error();const decipher=createDecipheriv('aes-256-gcm',Buffer.from(encoded,'base64url'),Buffer.from(iv,'base64url'));decipher.setAAD(Buffer.from(aad(row)));decipher.setAuthTag(Buffer.from(tag,'base64url'));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data,'base64url')),decipher.final()]).toString('utf8'));}
  catch{throw failure(403,'CALAI_RECONNECT_REQUIRED');}
}
export function calaiTokenMetadata(token,expectedUserId,config){
  try{if(typeof token!=='string'||token.length>10000||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))throw Error();const value=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));if(value.id!==expectedUserId||value.role!=='BUSINESS_OWNER'||!Number.isSafeInteger(value.exp)||value.exp*1000<=config.now().getTime()||value.isImpersonated)throw Error();return value;}
  catch{throw failure(403,'CALAI_IDENTITY_INVALID');}
}
// Native call-summary GETs self-heal persisted call data; they must stay native.
// The stats/my-subscription GETs can also write and are deliberately excluded.
const paths={orders:'/order/',analytics:'/dashboard/insights',insights:'/dashboard/insights',live:'/dashboard/live',hours:'/business-hour',agents:'/agent/',profile:'/settings/my-profile','contact-info':'/settings/contact-info','business-info':'/settings/business-info',menu:'/item-management/',plans:'/subscription/plans','billing-history':'/subscription/billing-history'};
export function calaiBusinessReadPath(section,id=null,detail=null){
  if(id!==null&&!isSourceId(id))throw new HttpError(400,'CALAI_RESOURCE_INVALID','The Calai resource identifier is invalid.');
  if(id===null&&Object.hasOwn(paths,section)&&detail===null)return paths[section];
  if(section==='orders'&&id&&detail===null)return '/order/'+id;
  throw new HttpError(404,'CALAI_RESOURCE_UNAVAILABLE','This Calai feature needs an additional source capability.');
}
export function createCalaiBusinessAdapter({fetchImpl=globalThis.fetch,timeoutMs=8000,responseLimitBytes=8*1024*1024}={}){
  async function call(method,path,{body,accessToken,refreshToken,signal}={}){
    if(!/^\/api\/(?:auth\/(?:login|refresh-token)$|business-owner\/)/.test(path)||/[\\\r\n?#]/.test(path))throw new HttpError(400,'CALAI_ROUTE_NOT_ALLOWED','Calai route is not permitted.');
    const url=new URL(path,CALAI_BUSINESS_ORIGIN);if(url.origin!==CALAI_BUSINESS_ORIGIN)throw failure(403,'CALAI_ROUTE_NOT_ALLOWED');
    const timeout=AbortSignal.timeout(timeoutMs);
    let response;try{response=await fetchImpl(url,{method,redirect:'error',signal:signal?AbortSignal.any([timeout,signal]):timeout,headers:{accept:'application/json','content-type':'application/json',...(accessToken?{authorization:'Bearer '+accessToken}:{}),...(refreshToken?{cookie:'refreshToken='+refreshToken}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});}catch{throw failure();}
    const limit=path.startsWith('/api/auth/')?128*1024:responseLimitBytes;
    if(Number(response.headers.get('content-length')??0)>limit){await response.body?.cancel();throw failure(502,'CALAI_RESPONSE_INVALID');}
    const chunks=[];let length=0;try{for await(const chunk of response.body??[]){length+=chunk.length;if(length>limit)throw Error();chunks.push(chunk);}}catch{await response.body?.cancel().catch(()=>{});throw failure(502,'CALAI_RESPONSE_INVALID');}
    let payload;try{payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw failure(502,'CALAI_RESPONSE_INVALID');}
    if(response.status!==200||payload?.success!==true)throw failure([401,403,404].includes(response.status)?403:503,[401,403,404].includes(response.status)?'CALAI_RECONNECT_REQUIRED':'CALAI_UNAVAILABLE');
    return{data:payload.data,refreshCookie:response.headers.getSetCookie?.().find(value=>value.startsWith('refreshToken='))??response.headers.get('set-cookie')};
  }
  return{
    async login(email,password){const r=await call('POST','/api/auth/login',{body:{email,password}}),match=/^refreshToken=([A-Za-z0-9_.-]{20,10000})(?:;|$)/.exec(r.refreshCookie??'');if(!match)throw failure(502,'CALAI_RESPONSE_INVALID');return{user:r.data?.user,accessToken:r.data?.accessToken,refreshToken:match[1]};},
    async refresh(refreshToken){return(await call('POST','/api/auth/refresh-token',{refreshToken,body:{}})).data?.accessToken;},
    async identity(accessToken){const[profile,business]=await Promise.all([call('GET','/api/business-owner/settings/my-profile',{accessToken}),call('GET','/api/business-owner/business-hour',{accessToken})]);return{user:profile.data,business:business.data};},
    async read(section,accessToken,{id=null,detail=null,signal}={}){return(await call('GET','/api/business-owner'+calaiBusinessReadPath(section,id,detail),{accessToken,signal})).data;}
  };
}
export function calaiBusinessAdapter(config){const settings=unifiedBusinessIntegrationConfig(config);if(!settings.encryptionKey)throw failure(503,'CALAI_BUSINESS_NOT_CONFIGURED');return settings.adapter??createCalaiBusinessAdapter();}
export function assertCalaiBusinessIdentity(proof,{userId,businessId}){
  if(proof?.user?.id!==userId||proof.user.role!=='BUSINESS_OWNER'||proof?.business?.businessId!==businessId||!isSourceId(userId)||!isSourceId(businessId))throw failure(403,'CALAI_BUSINESS_CHANGED');
  return proof;
}
export async function authenticateCalaiBusiness(config,email,password){
  const adapter=calaiBusinessAdapter(config),login=await adapter.login(email,password),person=login?.user;
  if(!isSourceId(person?.id)||person.role!=='BUSINESS_OWNER'||!isSourceId(person.businessId)||typeof person.email!=='string'||person.email.length>254)throw failure(403,'CALAI_BUSINESS_OWNER_REQUIRED');
  calaiTokenMetadata(login.accessToken,person.id,config);const refresh=calaiTokenMetadata(login.refreshToken,person.id,config),accessToken=await adapter.refresh(login.refreshToken);calaiTokenMetadata(accessToken,person.id,config);
  const proof=assertCalaiBusinessIdentity(await adapter.identity(accessToken),{userId:person.id,businessId:person.businessId});
  return{person:{id:person.id,businessId:person.businessId,email:person.email,name:[person.firstName,person.lastName].filter(x=>typeof x==='string').join(' ').trim().slice(0,160)||'Calai business owner'},business:{id:person.businessId,name:typeof proof.business.businessName==='string'?proof.business.businessName.slice(0,160):'Calai business'},tokens:{refreshToken:login.refreshToken},authExpiresAt:new Date(refresh.exp*1000).toISOString()};
}
export function redactCalaiBusinessData(value,depth=0){
  if(depth>24)throw failure(502,'CALAI_RESPONSE_INVALID');
  if(value===null||['string','number','boolean'].includes(typeof value))return value;
  if(Array.isArray(value))return value.map(item=>redactCalaiBusinessData(item,depth+1));
  if(!value||typeof value!=='object')return null;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!/password|token|secret|credential|api.?key|cookie|authorization|private.?key/i.test(key)&&!['__proto__','prototype','constructor'].includes(key)).map(([key,item])=>[key,redactCalaiBusinessData(item,depth+1)]));
}
