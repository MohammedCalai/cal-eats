import crypto from "node:crypto";
export const API_ORIGIN="https://eats.calai.info", BROKER_PORT=17864, UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const zeroUuid="00000000-0000-0000-0000-000000000000",p256SpkiPrefix=Buffer.from("3059301306072a8648ce3d020106082a8648ce3d03010703420004","hex");
export const managedJobId=value=>typeof value==="string"&&UUID.test(value)&&value!==zeroUuid;
export const managedPublicKey=value=>typeof value==="string"&&/^[A-Za-z0-9+/]{122}==$/.test(value)&&
  Buffer.from(value,"base64").toString("base64")===value&&Buffer.from(value,"base64").subarray(0,27).equals(p256SpkiPrefix);
export function managedEvidenceCanonical({jobId,publicKeySpki}){
  if(!managedJobId(jobId)||!managedPublicKey(publicKeySpki))throw Error("Invalid managed tablet evidence");
  return ["Cal-Eats managed terminal evidence v1",jobId,publicKeySpki].join("\n");
}
export function managedActivationCanonical({jobId,challenge,publicKeySpki}){
  if(!managedJobId(jobId)||!managedPublicKey(publicKeySpki)||typeof challenge!=="string"||
      !/^[A-Za-z0-9_-]{43}$/.test(challenge))throw Error("Invalid managed tablet activation");
  return ["Cal-Eats managed terminal activation v1",jobId,challenge,publicKeySpki].join("\n");
}
export function encodeManagedEvidence({jobId,publicKeySpki,signature}){
  managedEvidenceCanonical({jobId,publicKeySpki});
  if(typeof signature!=="string"||!/^[A-Za-z0-9_-]{86}$/.test(signature))throw Error("Invalid managed tablet evidence signature");
  return "CAL_EATS_MANAGED_SETUP_V1:"+Buffer.from(JSON.stringify({jobId,publicKeySpki,signature}),"utf8").toString("base64url");
}
export const digest=value=>crypto.createHash("sha256").update(value).digest("hex");
export function pairingCanonical({terminalId,challenge,publicKeySpki}){
  if(!UUID.test(terminalId)||typeof challenge!=="string"||!/^[A-Za-z0-9_-]{20,300}$/.test(challenge))throw Error("Invalid tablet pairing proof");
  return ["CAL-EATS-PAIR-V1",terminalId,challenge,digest(Buffer.from(publicKeySpki,"base64"))].join("\n");
}
export function requestCanonical({terminalId,timestamp,nonce,method,target,body=""}){
  if(!UUID.test(terminalId)||!/^\d{13}$/.test(timestamp)||!/^[A-Za-z0-9_-]{22,100}$/.test(nonce)||!["GET","POST","PATCH"].includes(method)||!target.startsWith("/api/")||/[\r\n#\\]/.test(target))throw Error("Invalid tablet request proof");
  return ["CAL-EATS-TERMINAL-V1",terminalId,timestamp,nonce,method,target,digest(body)].join("\n");
}
export function failure(code,status=400){return Object.assign(new Error(code),{code,status});}
export function finiteJson(value,depth=0){
  if(depth>20)return false;
  if(value===null||typeof value==="boolean"||typeof value==="string")return true;
  if(typeof value==="number")return Number.isFinite(value);
  if(Array.isArray(value))return value.every(v=>finiteJson(v,depth+1));
  if(value&&typeof value==="object"&&Object.getPrototypeOf(value)===Object.prototype)return Object.values(value).every(v=>finiteJson(v,depth+1));
  return false;
}
export function exactObject(body,keys){
  if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).some(k=>!keys.includes(k))||!finiteJson(body))throw failure("TABLET_BODY_INVALID");
}
export function requestAllowed(method,target,restaurantId,businessId=null){
  if(typeof target!=="string"||target.length>2048||!target.startsWith("/api/")||/[\r\n\0#\\]/.test(target))return false;
  const url=new URL(target,API_ORIGIN);
  if(url.origin!==API_ORIGIN||url.pathname+url.search!==target||/%|\.\.|\/\//.test(url.pathname))return false;
  const p=url.pathname;
  const queries=new Set(["status","scope","page","pageSize","limit","cursor","search","dateFrom","dateTo","from","to","sort","order","range","period","restaurantId"]);
  if([...url.searchParams].some(([k,v])=>!queries.has(k)||v.length>256))return false;
  if(url.searchParams.has('restaurantId')&&url.searchParams.getAll('restaurantId').some(id=>id!==restaurantId))return false;
  if(method==="GET"){
    if(["/api/auth/me","/api/business/context","/api/business/dashboard"].includes(p))return !url.search;
    if(/^\/api\/business\/calai\/(?:orders|hours)$/.test(p))return true;
    if(p==="/api/restaurant/restaurants")return !url.search;
    if(p==="/api/restaurant/orders")return Boolean(restaurantId);
    if(p==='/api/restaurant/orders/pending-confirmation')return Boolean(restaurantId);
    if(/^\/api\/orders\/[A-Za-z0-9_-]{8,100}(?:\/(?:messages|conversation))?$/.test(p))return Boolean(restaurantId);
    if(p==='/api/notifications')return true;
    return Boolean(UUID.test(restaurantId||"")&&new RegExp("^/api/restaurant/restaurants/"+restaurantId+"/(?:dashboard|orders|printer-status|printers|operations-health|surface-status|device-incidents|message-attention)$").test(p));
  }
  if(url.search)return false;
  if(method==='POST'&&UUID.test(businessId||'')&&p===`/api/business/accounts/${businessId}/surface/heartbeat`)return true;
  if(method==='POST'&&restaurantId&&/^\/api\/orders\/[A-Za-z0-9_-]{8,100}\/messages$/.test(p))return true;
  if(method==="PATCH")return /^\/api\/restaurant\/orders\/[A-Za-z0-9_-]{8,100}\/(?:status|preparation)$/.test(p)&&Boolean(restaurantId);
  if(method==="POST"&&UUID.test(restaurantId||""))return new RegExp("^/api/restaurant/restaurants/"+restaurantId+"/printers/[A-Za-z0-9_-]{8,100}/(?:test-receipt|reprints|jobs/[A-Za-z0-9_-]{8,100}/check)$").test(p);
  return false;
}
