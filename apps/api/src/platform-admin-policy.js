import {HttpError,exactObject} from './http.js';
const UUID='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
const uuid=new RegExp('^'+UUID+'$');
export const isCalaiUserId=value=>typeof value==='string'&&uuid.test(value);
const invalid=()=>{throw new HttpError(400,'CALAI_FILTER_INVALID','Calai request fields are invalid.');};
function field(value,max=200,min=0){if(typeof value!=='string'||value.length>max||value.trim().length<min||/[\u0000-\u001f\u007f]/.test(value))invalid();return value;}
const queries={
 operations:{start:'date',end:'date'},agent:{businessId:'uuid'},audit:{page:'page',limit:'limit',searchTerm:'text',action:'text',userEmail:'text',startDate:'date',endDate:'date'}
};
export function calaiRoutePolicy(method,path,searchParams){
 if(typeof path!=='string'||path.includes('//')||/[\\%#\r\n]/.test(path)||path.includes('..'))throw new HttpError(404,'CALAI_ROUTE_NOT_ALLOWED','This Calai operation is unavailable.');
 // PostgreSQL UUID identity is case-insensitive. Canonicalize before both
 // upstream dispatch and the durable method/path ambiguity guard.
 path=path.replace(/\/$/,'').split('/').map(segment=>uuid.test(segment)?segment.toLowerCase():segment).join('/');let kind=null,query={};
 if(method==='GET'){
  if(['/dashboard','/dashboard/operations/live','/tenants','/subscription-billing/plans','/subscription-billing/billings','/telephony','/agent','/settings/logo'].includes(path))kind='read';
  if(path==='/dashboard/operations'){kind='read';query=queries.operations;}
  if(path==='/agent')query=queries.agent;
  if(new RegExp('^/(?:tenants|telephony)/'+UUID+'$').test(path)||new RegExp('^/telephony/unconnected-agents/'+UUID+'$').test(path)||new RegExp('^/individual-tenant/'+UUID+'/(?:agents|calls|orders|billing)$').test(path))kind='read';
  if(path==='/audit-logs'||new RegExp('^/audit-logs/'+UUID+'$').test(path)){kind='read';if(path==='/audit-logs')query=queries.audit;}
 }else{
  if(method==='POST'&&path==='/tenants')kind='createTenant';
  if(method==='PATCH'&&new RegExp('^/tenants/'+UUID+'$').test(path))kind='updateTenant';
  if(method==='DELETE'&&new RegExp('^/(?:tenants|telephony|agent|audit-logs)/'+UUID+'$').test(path))kind='delete';
  if(method==='DELETE'&&path==='/audit-logs')kind='delete';
  if(method==='POST'&&path==='/telephony')kind='createTelephony';
  if(method==='PATCH'&&new RegExp('^/telephony/'+UUID+'$').test(path))kind='updateTelephony';
  if(method==='PATCH'&&new RegExp('^/agent/'+UUID+'/special-offers$').test(path))kind='specialOffers';
  if(method==='POST'&&path==='/agent/create')kind='createAgentUpload';
  if(method==='POST'&&path==='/agent/upload-special-offers')kind='specialOffersUpload';
  if(method==='PATCH'&&path==='/settings/logo')kind='logoUpload';
 }
 if(!kind)throw new HttpError(404,'CALAI_ROUTE_NOT_ALLOWED','This Calai operation is unavailable.');
 for(const key of searchParams.keys()){
  if(!Object.hasOwn(query,key)||searchParams.getAll(key).length!==1)invalid();const value=searchParams.get(key);field(value,160);
  if(query[key]==='date'&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value))invalid();
  if(query[key]==='uuid'&&!isCalaiUserId(value))invalid();
  if(['page','limit'].includes(query[key])&&(!/^\d+$/.test(value)||Number(value)<1||Number(value)>(query[key]==='page'?10000:100)))invalid();
 }
 if(path==='/dashboard/operations'&&(!searchParams.has('start')||!searchParams.has('end')||searchParams.get('start')>searchParams.get('end')||Date.parse(searchParams.get('end'))-Date.parse(searchParams.get('start'))>366*86400000))invalid();
 if(searchParams.has('startDate')&&searchParams.has('endDate')&&searchParams.get('startDate')>searchParams.get('endDate'))invalid();
 const canonical=new URLSearchParams([...searchParams].map(([key,value])=>[key,query[key]==='uuid'?value.toLowerCase():value]).sort(([a],[b])=>a.localeCompare(b))).toString();
 return {kind,path,target:path+(canonical?'?'+canonical:'')};
}
export function validateCalaiMutation(kind,body){
 if(!body||typeof body!=='object'||Array.isArray(body))invalid();
 if(kind==='delete'){exactObject(body,[]);return {};}
 if(kind==='createTenant'){
  exactObject(body,['first_name','last_name','email','password','business_name','phone','business_type']);
  for(const key of ['first_name','last_name','business_name'])field(body[key],200,1);field(body.email,254,3);if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email))invalid();field(body.password,200,12);if(!/[A-Za-z]/.test(body.password)||!/[0-9]/.test(body.password))invalid();
  if(body.phone!==undefined)field(body.phone,40);if(body.business_type!==undefined&&!['restaurent','take_way'].includes(body.business_type))invalid();
 }else if(kind==='updateTenant'){
  exactObject(body,['name','status']);if(!Object.keys(body).length)invalid();if(body.name!==undefined)field(body.name,200,1);if(body.status!==undefined&&!['active','suspended','trial','expired'].includes(body.status))invalid();
 }else if(kind==='createTelephony'){
  exactObject(body,['assistant_id','twilio_number','manager_number','businessId']);for(const key of ['assistant_id','twilio_number','manager_number'])field(body[key],100,1);if(!isCalaiUserId(body.businessId))invalid();
 }else if(kind==='updateTelephony'){
  exactObject(body,['twilioNumber','managerNumber']);if(!Object.keys(body).length)invalid();for(const value of Object.values(body))field(value,100);
 }else if(kind==='specialOffers'){exactObject(body,['enabled']);if(typeof body.enabled!=='boolean')invalid();}
 else invalid();return body;
}
export function sanitizeCalaiData(value,depth=0){
 if(depth>30)throw new HttpError(502,'CALAI_RESPONSE_INVALID','Calai returned an unsupported response.');
 if(Array.isArray(value))return value.map(item=>sanitizeCalaiData(item,depth+1));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/(?:password|secret|token|api.?key|authorization|credential|__proto__|constructor|prototype)/i.test(key)).map(([key,item])=>[key,sanitizeCalaiData(item,depth+1)]));
 return value;
}
export function canonicalPlatformBody(value){if(Array.isArray(value))return '['+value.map(canonicalPlatformBody).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalPlatformBody(value[key])).join(',')+'}';return JSON.stringify(value);}
