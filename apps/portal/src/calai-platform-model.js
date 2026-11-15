export const calaiNavigation=[
  ["Dashboard","/admin/calai/dashboard"],["AI Training","/admin/calai/ai-training"],["Tenant Management","/admin/calai/tenants"],
  ["Telephony","/admin/calai/telephony"],["Subscriptions & Billing","/admin/calai/billing"],["Settings","/admin/calai/settings"],
];
export function adminProduct(path){return path.startsWith("/admin/calai/")||path==="/admin/connection"?"calai":"cal-eats";}
export function platformReturnPath(raw){
  if(typeof raw!=="string"||!raw.startsWith("/admin/")||raw.startsWith("//")||/[\\\r\n]/.test(raw))return "/admin/calai/dashboard";
  const url=new URL(raw,"https://platform.invalid");
  return url.origin==="https://platform.invalid"&&url.pathname.startsWith("/admin/")&&url.pathname!=="/admin/login"?url.pathname+url.search:"/admin/calai/dashboard";
}
export function platformLoginMode(current,{loading=false,loginAvailable=false}={}){
  if(current==="local"||current==="calai")return current;
  return loading?null:loginAvailable===true?"calai":"local";
}
export function platformLoginRequest(mode,email,password,returnTo){
  if(mode!=="local"&&mode!=="calai")throw Error("Choose an administrator sign-in method.");
  return {path:mode==="local"?"/api/platform-auth/local-login":"/api/platform-auth/login",body:{email:String(email||"").trim(),password:String(password||"")},destination:mode==="local"?"/admin/connection":platformReturnPath(returnTo)};
}
export function calaiReady(connection){return connection?.enabled===true&&connection?.configured===true&&connection?.linked===true&&connection?.session?.federated===true&&connection?.capabilities?.read===true;}
export const calaiItems=value=>Array.isArray(value)?value:Array.isArray(value?.items)?value.items:[];
export const calaiText=value=>value===null||value===undefined||value===""?"Not available":typeof value==="object"?"Not available":String(value);
export function calaiMoney(value,currency=""){
  if(!["number","string"].includes(typeof value)||String(value).trim()===""||!Number.isFinite(Number(value)))return "Not available";
  if(!/^[A-Z]{3}$/.test(currency))return `${Number(value).toLocaleString("en-GB")} (currency not confirmed)`;
  try{return new Intl.NumberFormat("en-GB",{style:"currency",currency}).format(Number(value));}catch{return `${value} ${currency}`;}
}
export function calaiPage(items,search,page=1){
  const q=String(search||"").trim().toLocaleLowerCase("en-GB");
  const filtered=q?items.filter(item=>[item.name,item.agentName,item.email,item.plan,item.status,item.business?.name,item.twilioNumber].some(value=>typeof value==="string"&&value.toLocaleLowerCase("en-GB").includes(q))):items;
  const totalPages=Math.max(1,Math.ceil(filtered.length/25)),current=Math.min(Math.max(1,page),totalPages);
  return {items:filtered.slice((current-1)*25,current*25),page:current,total:filtered.length,totalPages};
}
export function tenantEditPayload(draft,original){
  const name=String(draft.name||"").trim();if(!name||name.length>200)throw Error("Enter a tenant name of up to 200 characters.");
  if(!["active","suspended","trial","expired"].includes(draft.status))throw Error("Choose a valid tenant status.");
  return {...(name!==original.name?{name}:{}),...(draft.status!==original.status?{status:draft.status}:{})};
}
export function telephonyPayload(draft,create=false){
  const twilio=String(draft.twilioNumber||"").trim(),manager=String(draft.managerNumber||"").trim();
  if(!/^\+[1-9]\d{6,14}$/.test(twilio)||!/^\+[1-9]\d{6,14}$/.test(manager))throw Error("Use complete international phone numbers, starting with + and the country code.");
  if(!create)return {twilioNumber:twilio,managerNumber:manager};
  if(!draft.businessId||!draft.assistant_id)throw Error("Choose a tenant and its available agent.");
  return {businessId:draft.businessId,assistant_id:draft.assistant_id,twilio_number:twilio,manager_number:manager};
}
export function mutationMayRetry(error){return !["CALAI_MUTATION_UNCERTAIN","CALAI_MUTATION_IN_PROGRESS","CALAI_MUTATION_REVIEWED"].includes(error?.code);}
export function calaiRequestPresentation(value,now=Date.now()){
 const confirmed=value?.status==="confirmed"&&value?.providerConfirmed===true;
 const reported=value?.status==="operator_reported_applied"||value?.status==="operator_reported_not_applied";
 const allowNewIntent=value?.status==="operator_reported_not_applied"&&value?.review?.result==="not_applied"&&value?.canSubmitNewIntent===true;
 const canReview=value?.status==="unknown"||value?.status==="dispatching"&&Number.isFinite(Date.parse(value?.updatedAt))&&Date.parse(value.updatedAt)<=now-120000;
 return {confirmed,allowNewIntent,canReview,notice:confirmed?"Calai confirmed this change.":reported?`An administrator reported this action ${value.review?.result==="applied"?"was applied":"was not applied"}. This is an operator report, not provider confirmation.`:"",error:confirmed||reported?"":`Current request status: ${value?.status||"not confirmed"}. Do not send a new copy.`};
}
export function calaiRequestStatusPath(requestId,requestKey){
 if(typeof requestId==="string"&&/^[0-9a-f-]{36}$/i.test(requestId))return `/api/admin/platform-connection/requests/${requestId}`;
 if(typeof requestKey==="string"&&/^[A-Za-z0-9_.:-]{8,100}$/.test(requestKey))return `/api/admin/platform-connection/requests/lookup?${new URLSearchParams({key:requestKey})}`;
 throw Error("This request has no usable reference. Contact support before submitting another copy.");
}
