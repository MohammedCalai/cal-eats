const UUID="[0-9a-fA-F-]{36}";
const writePaths=new RegExp(`^/(?:tenants(?:/${UUID})?|telephony(?:/${UUID})?|agent/${UUID}(?:/special-offers)?)$`);
const uploads=new Map([["/agent/create","POST"],["/agent/upload-special-offers","POST"],["/settings/logo","PATCH"]]);
function error(message,detail={}){return Object.assign(new Error(message),detail);}

// A dialog keeps one intent key. Ambiguous delivery blocks every subsequent
// send, including a changed payload; checking status never resends the action.
export function createCalaiMutationClient({fetchImpl=globalThis.fetch,createKey=()=>`calai-${crypto.randomUUID()}`,beforeDispatch=()=>{}}={}){
 let intent=null,pending=null,blocked=null;
 async function send(path,method,body){
  if(blocked)throw blocked;
  if(pending)return pending;
  if(!(uploads.get(path)===method||writePaths.test(path)&&["POST","PATCH","DELETE"].includes(method)))throw error("This Calai operation is unavailable.",{status:400,code:"CALAI_ROUTE_NOT_ALLOWED"});
  const raw=JSON.stringify(body||{});
  const work=(async()=>{
   // Keep a digest, never the selected document or initial password, in the
   // reusable intent record after the bounded request has finished.
   const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(`${method}\n${path}\n${raw}`)),fingerprint=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("");
   if(intent?.fingerprint!==fingerprint)intent={fingerprint,key:createKey()};
   const key=intent.key;
   beforeDispatch({path,method,upload:uploads.has(path)});
   let result,response;
   try{
    response=await fetchImpl(`/api/admin/calai${path}`,{method,credentials:"include",redirect:"error",signal:AbortSignal.timeout(uploads.has(path)?120000:60000),headers:{Accept:"application/json","Content-Type":"application/json","Idempotency-Key":key},body:raw});
    result=await response.json();
   }catch{blocked=error("This change has not been confirmed. Do not send another copy. Check the affected record or contact support.",{code:"CALAI_MUTATION_UNCERTAIN",requestId:null,requestKey:key});throw blocked;}
   const requestId=result?.meta?.requestId||result?.error?.details?.requestId||null;
   if(!response.ok){
    const detail=result?.error||{},failure=error(detail.message||"Calai did not accept this change.",{status:response.status,code:detail.code||"CALAI_REQUEST_REJECTED",requestId,requestKey:key});
    if(["CALAI_MUTATION_UNCERTAIN","CALAI_MUTATION_IN_PROGRESS","CALAI_MUTATION_REVIEWED"].includes(failure.code))blocked=failure;
    throw failure;
   }
   if(result?.meta?.state!=="confirmed"){
    blocked=error("The change response could not be confirmed. Do not submit it again.",{code:"CALAI_MUTATION_UNCERTAIN",requestId,requestKey:key});throw blocked;
   }
   return result;
  })();
  pending=work;
  try{return await work;}finally{if(pending===work)pending=null;}
 }
 return {send};
}
