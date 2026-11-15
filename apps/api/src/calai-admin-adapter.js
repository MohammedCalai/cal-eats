import {HttpError} from './http.js';
import {CALAI_ORIGIN} from './platform-admin-config.js';
import {calaiRoutePolicy} from './platform-admin-policy.js';
import {validateCalaiLogoUrl,validateCalaiLogoBytes} from './platform-admin-logo.js';
const fault=(status=503,code='CALAI_UNAVAILABLE')=>new HttpError(status,code,status===401?'Calai did not accept this administrator sign-in.':'Calai is unavailable. Your administrator access has not been confirmed.');
export function createCalaiAdminAdapter({fetchImpl=globalThis.fetch,timeoutMs=8000,maxResponseBytes=8*1024*1024}={}){
 if(!Number.isSafeInteger(maxResponseBytes)||maxResponseBytes<1024*1024||maxResponseBytes>32*1024*1024)throw Error('Calai response limit is invalid');
 async function call(method,path,{accessToken,refreshToken,body}={}){
  if(!/^\/api\/(?:auth\/(?:login|refresh-token)|system-owner\/)/.test(path)||/[\\\r\n#]/.test(path))throw fault(400,'CALAI_ROUTE_NOT_ALLOWED');
  const url=new URL(path,CALAI_ORIGIN);if(url.origin!==CALAI_ORIGIN)throw fault(400,'CALAI_ROUTE_NOT_ALLOWED');
  let response;
  const multipart=body&&Array.isArray(body.files)&&body.fields&&typeof body.fields==='object';
  let requestBody;
  if(multipart){requestBody=new FormData();for(const [name,value]of Object.entries(body.fields))requestBody.append(name,value);for(const file of body.files)requestBody.append(file.field,new Blob([file.bytes],{type:file.mimeType}),file.name);}
  else if(body!==undefined)requestBody=JSON.stringify(body);
  try{response=await fetchImpl(url,{method,redirect:'error',signal:AbortSignal.timeout(multipart?60000:timeoutMs),headers:{accept:'application/json',...(!multipart?{'content-type':'application/json'}:{}),...(accessToken?{authorization:'Bearer '+accessToken}:{}),...(refreshToken?{cookie:'refreshToken='+refreshToken}:{})},...(requestBody!==undefined?{body:requestBody}:{})});}catch{throw fault();}
  const limit=path.startsWith('/api/auth/')?128*1024:maxResponseBytes;
  if(Number(response.headers.get('content-length')??0)>limit){await response.body?.cancel();throw fault(502,'CALAI_RESPONSE_INVALID');}
  const chunks=[];let size=0;try{for await(const chunk of response.body??[]){size+=chunk.length;if(size>limit)throw fault(502,'CALAI_RESPONSE_INVALID');chunks.push(chunk);}}catch(error){if(error instanceof HttpError)throw error;throw fault();}
  let payload;try{payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fault(502,'CALAI_RESPONSE_INVALID');}
  return {status:response.status,success:payload?.success===true,data:payload?.data,refreshCookie:response.headers.getSetCookie?.().find(value=>value.startsWith('refreshToken='))??response.headers.get('set-cookie')};
 }
 return {
  async login(email,password){const r=await call('POST','/api/auth/login',{body:{email,password}});if(r.status!==200||!r.success)throw fault([401,403,404].includes(r.status)?401:503,'CALAI_SIGN_IN_FAILED');const match=/^refreshToken=([A-Za-z0-9_.-]{20,10000})(?:;|$)/.exec(r.refreshCookie??'');if(!match)throw fault(502,'CALAI_RESPONSE_INVALID');return {user:r.data?.user,accessToken:r.data?.accessToken,refreshToken:match[1]};},
  async refresh(refreshToken){const r=await call('POST','/api/auth/refresh-token',{refreshToken,body:{}});if(r.status!==200||!r.success)throw fault([401,403,404].includes(r.status)?401:503,'CALAI_AUTHORITY_UNAVAILABLE');return r.data?.accessToken;},
  async probe(accessToken){const r=await call('GET','/api/system-owner/settings/logo',{accessToken});if(r.status!==200||!r.success)throw fault([401,403,404].includes(r.status)?403:503,'CALAI_ADMIN_REQUIRED');return true;},
  async image(sourceUrl){
   const url=validateCalaiLogoUrl(sourceUrl);let response;
   try{response=await fetchImpl(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(timeoutMs),headers:{accept:'image/png, image/jpeg, image/webp'}});}catch{throw fault();}
   if(response.status!==200||Number(response.headers.get('content-length')??0)>2*1024*1024){await response.body?.cancel();throw fault(502,'CALAI_LOGO_INVALID');}
   const chunks=[];let size=0;try{for await(const chunk of response.body??[]){size+=chunk.length;if(size>2*1024*1024)throw fault(502,'CALAI_LOGO_INVALID');chunks.push(chunk);}}catch(error){if(error instanceof HttpError)throw error;throw fault();}
   return validateCalaiLogoBytes(Buffer.concat(chunks));
  },
  request:(method,path,body,accessToken)=>{const split=path.indexOf('?'),policy=calaiRoutePolicy(method,split<0?path:path.slice(0,split),new URLSearchParams(split<0?'':path.slice(split+1)));return call(method,'/api/system-owner'+policy.target,{accessToken,body});}
 };
}
