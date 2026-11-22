import fs from 'node:fs';
import {createHash} from 'node:crypto';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha=/^[0-9a-f]{64}$/i;
const fail=(code,retry=false)=>Object.assign(new Error(code),{code,retry});
async function deadline(work,milliseconds,code,controller){
 let timer;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{const error=fail(code,true);controller?.abort(error);reject(error);},milliseconds);});
 try{return await Promise.race([Promise.resolve().then(work),timeout]);}finally{clearTimeout(timer);}
}
async function readMicrosoftJson(response,signal){
 if(!/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type')??''))throw fail('GRAPH_RESPONSE_CONTENT_TYPE');
 const maximum=2*1024*1024;if(Number(response.headers?.get('content-length'))>maximum)throw fail('GRAPH_RESPONSE_TOO_LARGE');
 const reader=response.body?.getReader?.();if(!reader)throw fail('GRAPH_RESPONSE_INVALID');const chunks=[];let length=0;
 const cancel=()=>{void reader.cancel().catch(()=>{});};signal?.addEventListener('abort',cancel,{once:true});
 try{for(;;){signal?.throwIfAborted();const {done,value}=await reader.read();signal?.throwIfAborted();if(done)break;length+=value.byteLength;if(length>maximum){await reader.cancel().catch(()=>{});throw fail('GRAPH_RESPONSE_TOO_LARGE');}chunks.push(Buffer.from(value));}}
 catch(error){if(error.code?.startsWith?.('GRAPH_'))throw error;throw fail('GRAPH_NETWORK_ERROR',true);}
 finally{signal?.removeEventListener('abort',cancel);reader.releaseLock();}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail('GRAPH_RESPONSE_INVALID');}
}
export function createBoundedMicrosoftIdentityNetwork({fetchImpl=fetch,timeoutMs=12000}={}){
 async function send(method,url,options={}){
  const target=new URL(url);if(target.origin!=='https://login.microsoftonline.com'||target.username||target.password||target.hash)throw fail('GRAPH_IDENTITY_URL_REJECTED');
  const controller=new AbortController();return deadline(async()=>{
   try{const response=await fetchImpl(url,{method,headers:options.headers,body:method==='POST'?options.body:undefined,redirect:'error',signal:controller.signal});return{headers:Object.fromEntries(response.headers),body:await readMicrosoftJson(response,controller.signal),status:response.status};}
   catch(error){if(error.code?.startsWith?.('GRAPH_'))throw error;throw fail('GRAPH_AUTH_NETWORK_ERROR',true);}
  },timeoutMs,'GRAPH_AUTH_TIMEOUT',controller);
 }
 return{sendGetRequestAsync:(url,options)=>send('GET',url,options),sendPostRequestAsync:(url,options)=>send('POST',url,options)};
}
const date=(value,now)=>{const time=typeof value==='string'?Date.parse(value):NaN;if(!Number.isFinite(time)||time>now+60000)throw fail('GRAPH_EVIDENCE_TIME_INVALID');return new Date(time).toISOString();};
export function loadTabletManagementConfig(input={},env=process.env){
 const enabled=input.enabled??env.CAL_EATS_INTUNE_READ_ENABLED==='true';
 let approvedScripts=input.approvedScripts??[];
 if(input.approvedScripts===undefined&&env.CAL_EATS_INTUNE_APPROVED_SCRIPTS_JSON){try{approvedScripts=JSON.parse(env.CAL_EATS_INTUNE_APPROVED_SCRIPTS_JSON);}catch{throw new Error('Intune approved script manifest is invalid');}}
 if(!Array.isArray(approvedScripts)||approvedScripts.length>100||approvedScripts.some(s=>!s||!uuid.test(s.id)||!sha.test(s.sha256)||s.parser!=='startup_pilot_v3'))throw new Error('Intune approved script manifest is invalid');
 const settings={enabled,tenantId:input.tenantId??env.CAL_EATS_INTUNE_TENANT_ID??null,clientId:input.clientId??env.CAL_EATS_INTUNE_CLIENT_ID??null,certificateThumbprint:input.certificateThumbprint??env.CAL_EATS_INTUNE_CERTIFICATE_THUMBPRINT_SHA256??null,privateKeyFile:input.privateKeyFile??env.CAL_EATS_INTUNE_PRIVATE_KEY_FILE??null,privateKey:input.privateKey??null,approvedScripts:approvedScripts.map(s=>({id:s.id.toLowerCase(),sha256:s.sha256.toLowerCase(),parser:s.parser})),maxPages:input.maxPages??10};
 if(typeof enabled!=='boolean'||!Number.isInteger(settings.maxPages)||settings.maxPages<1||settings.maxPages>20)throw new Error('Intune read-only configuration is invalid');
 if(enabled&&(!uuid.test(settings.tenantId??'')||!uuid.test(settings.clientId??'')||!sha.test(settings.certificateThumbprint??'')||!(settings.privateKeyFile||settings.privateKey)))throw new Error('Intune read-only collector requires its approved certificate identity');
 return settings;
}
export function tabletManagementReadiness(settings,row){
 if(!settings?.enabled)return{ready:false,reason:'The read-only Microsoft management connection is not configured.'};
 if(!uuid.test(row.intune_managed_device_id??'')||!uuid.test(row.entra_device_id??'')||typeof row.serial_number!=='string'||! /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,119}$/.test(row.serial_number))return{ready:false,reason:'Record the exact Intune ID, Entra device ID and serial before collecting management evidence.'};
 if(row.startup_profile_id&&!uuid.test(row.startup_profile_id))return{ready:false,reason:'The recorded startup script identifier is invalid.'};
 if(row.startup_profile_id&&!settings.approvedScripts.some(s=>s.id===row.startup_profile_id.toLowerCase()))return{ready:false,reason:'The recorded startup script has no approved payload-hash manifest.'};
 return{ready:true,reason:null};
}
export async function createTabletGraphClient(settings){
 const {ConfidentialClientApplication}=await import('@azure/msal-node');
 const privateKey=settings.privateKey??fs.readFileSync(settings.privateKeyFile,'utf8');
 return new ConfidentialClientApplication({auth:{clientId:settings.clientId,authority:`https://login.microsoftonline.com/${settings.tenantId}`,clientCertificate:{thumbprintSha256:settings.certificateThumbprint,privateKey}},system:{disableInternalRetries:true,networkClient:createBoundedMicrosoftIdentityNetwork(),loggerOptions:{piiLoggingEnabled:false,loggerCallback:()=>{}}}});
}
export function parseTabletStartupExecution(result,{script,run,now,expectedSerial}){
 if(run.runState!=='success')return null;
 if(typeof result!=='string'||Buffer.byteLength(result)>8192)throw fail('GRAPH_SCRIPT_RESULT_UNSUPPORTED');
 let body;try{body=JSON.parse(result.trim());}catch{throw fail('GRAPH_SCRIPT_RESULT_UNSUPPORTED');}
 if(!body||typeof body!=='object'||Array.isArray(body))throw fail('GRAPH_SCRIPT_RESULT_UNSUPPORTED');
 const observedAt=date(run.lastStateUpdateDateTime,now);
 if(Date.parse(observedAt)<Date.parse(date(script.lastModifiedDateTime,now)))throw fail('GRAPH_SCRIPT_VERSION_UNCERTAIN');
 if(body.Status==='AlreadyCorrect'&&body.Changed===false){if(typeof body.Serial!=='string'||body.Serial.trim().toLowerCase()!==expectedSerial.trim().toLowerCase())throw fail('GRAPH_RESULT_SERIAL_MISMATCH');return{status:'AlreadyCorrect',changed:false,observedAt,source:'microsoft_graph',configurationChecked:true};}
 if(body.Status==='StartupRepairApplied'&&body.Changed===true&&body.PrinterTouched===false&&body.TasksChanged===false&&body.PowerChanged===false&&body.RestartRequested===false&&sha.test(body.WatchdogSha256Before??'')&&body.WatchdogSha256Before===body.WatchdogSha256After)return{status:'StartupRepairApplied',changed:true,observedAt,source:'microsoft_graph',configurationChecked:true};
 if(body.Status==='StoppedFailClosed'&&body.PossiblePartialStartupChanges===false)return{status:'StoppedFailClosed',changed:false,observedAt,source:'microsoft_graph',configurationChecked:false};
 throw fail('GRAPH_SCRIPT_RESULT_UNSUPPORTED');
}
export function createTabletManagementGraphAdapter(settings,{fetchImpl=fetch,clientFactory=createTabletGraphClient,now=()=>Date.now(),authTimeoutMs=15000,collectionTimeoutMs=60000}={}){
 if(!Number.isInteger(authTimeoutMs)||authTimeoutMs<1||authTimeoutMs>30000||!Number.isInteger(collectionTimeoutMs)||collectionTimeoutMs<1||collectionTimeoutMs>180000)throw new TypeError('Tablet management deadlines are invalid');
 let client;
 async function get(url,token,signal){
  const parsed=new URL(url);if(parsed.origin!=='https://graph.microsoft.com'||!/^\/(?:v1\.0|beta)\/deviceManagement\//.test(parsed.pathname)||parsed.username||parsed.password||parsed.hash)throw fail('GRAPH_URL_REJECTED');
  const requestSignal=AbortSignal.any([signal,AbortSignal.timeout(12000)]);
  let response;try{response=await fetchImpl(url,{method:'GET',headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},redirect:'error',signal:requestSignal});}catch{throw fail('GRAPH_NETWORK_ERROR',true);}
  if(response.status===429||response.status>=500)throw fail('GRAPH_PROVIDER_RETRY',true);
  if(response.status===401||response.status===403)throw fail('GRAPH_PERMISSION_REQUIRED');
  if(response.status!==200)throw fail('GRAPH_RESPONSE_UNAVAILABLE');
  return readMicrosoftJson(response,requestSignal);
 }
 return{collect(row,{cachedRunStateId=null}={}){const controller=new AbortController();return deadline(async()=>{
  const readiness=tabletManagementReadiness(settings,row);if(!readiness.ready)throw fail('GRAPH_NOT_CONFIGURED');
  let token;try{const auth=await deadline(async()=>{client??=clientFactory(settings);return(await client).acquireTokenByClientCredential({scopes:['https://graph.microsoft.com/.default']});},authTimeoutMs,'GRAPH_AUTH_TIMEOUT');if(!auth?.accessToken)throw Error();token=auth.accessToken;}
  catch(error){client=undefined;if(error.retry||/network|timeout|temporarily_unavailable|server_error/i.test(error.errorCode??''))throw fail(error.code?.startsWith?.('GRAPH_')?error.code:'GRAPH_AUTH_NETWORK_ERROR',true);throw fail('GRAPH_IDENTITY_REQUIRED');}
  controller.signal.throwIfAborted();
  const id=row.intune_managed_device_id,device=await get(`https://graph.microsoft.com/v1.0/deviceManagement/managedDevices/${id}?$select=id,azureADDeviceId,serialNumber,lastSyncDateTime`,token,controller.signal);
  if(device.id?.toLowerCase()!==id.toLowerCase()||device.azureADDeviceId?.toLowerCase()!==row.entra_device_id.toLowerCase()||typeof device.serialNumber!=='string'||device.serialNumber.trim().toLowerCase()!==row.serial_number.trim().toLowerCase())throw fail('GRAPH_DEVICE_IDENTITY_MISMATCH');
  const collectedAt=new Date(now()).toISOString(),contactAt=device.lastSyncDateTime?date(device.lastSyncDateTime,now()):null;
  const evidence={identityMatched:true,collectedAt,contactAt,scriptRef:null,scriptSha256:null,runStateId:null,execution:null,physicalStartupVerified:false,applicationPresenceVerified:false,payloadVersionCorrelation:'current_script_hash_and_run_time_only',source:'microsoft_graph'};
  if(!row.startup_profile_id)return evidence;
  const manifest=settings.approvedScripts.find(s=>s.id===row.startup_profile_id.toLowerCase()),scriptBase=`https://graph.microsoft.com/beta/deviceManagement/deviceManagementScripts/${manifest.id}`;
  const script=await get(scriptBase+'?$select=id,scriptContent,lastModifiedDateTime',token,controller.signal);
  if(script.id?.toLowerCase()!==manifest.id||typeof script.scriptContent!=='string'||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(script.scriptContent))throw fail('GRAPH_SCRIPT_PAYLOAD_INVALID');
  const bytes=Buffer.from(script.scriptContent,'base64');if(createHash('sha256').update(bytes).digest('hex')!==manifest.sha256)throw fail('GRAPH_SCRIPT_PAYLOAD_MISMATCH');
  let run;
  if(cachedRunStateId){const found=await get(scriptBase+'/deviceRunStates/'+encodeURIComponent(cachedRunStateId)+'?$expand=managedDevice($select=id)',token,controller.signal);if(found.managedDevice?.id?.toLowerCase()===id.toLowerCase())run=found;else throw fail('GRAPH_RUN_IDENTITY_MISMATCH');}
  else{
   let url=scriptBase+'/deviceRunStates?$expand=managedDevice($select=id)&$top=100';
   for(let page=0;url&&page<settings.maxPages;page++){
    const list=await get(url,token,controller.signal);if(!Array.isArray(list.value)||list.value.length>100)throw fail('GRAPH_RESPONSE_INVALID');
    const matched=list.value.filter(r=>r.managedDevice?.id?.toLowerCase()===id.toLowerCase());if(matched.length>1||run&&matched.length)throw fail('GRAPH_RUN_IDENTITY_AMBIGUOUS');if(matched.length)run=matched[0];
    url=list['@odata.nextLink']??null;
    if(url){let next;try{next=new URL(url);}catch{throw fail('GRAPH_URL_REJECTED');}const path=new URL(scriptBase).pathname+'/deviceRunStates';if(next.origin!=='https://graph.microsoft.com'||next.pathname!==path||next.username||next.password||next.hash||next.href.length>8192||[...next.searchParams].some(([key,value])=>!['$skiptoken','$skip','$top','$expand','$select'].includes(key)||/[\r\n\u0000]/.test(value)||key==='$top'&&!/^(?:[1-9]\d?|100)$/.test(value)||key==='$expand'&&value!=='managedDevice($select=id)'||key==='$select'&&value!=='id,runState,resultMessage,lastStateUpdateDateTime'))throw fail('GRAPH_URL_REJECTED');}
    if(run)break;
    if(url&&page+1===settings.maxPages)throw fail('GRAPH_RESULT_LIMIT');
   }
  }
  evidence.scriptRef=manifest.id;evidence.scriptSha256=manifest.sha256;
  if(!run)return evidence;
  if(typeof run.id!=='string'||run.id.length>200||/[\u0000-\u001f]/.test(run.id))throw fail('GRAPH_RESPONSE_INVALID');
  evidence.runStateId=run.id;
  if(run.runState==='success'){
   evidence.execution=parseTabletStartupExecution(run.resultMessage,{script,run,now:now(),expectedSerial:row.serial_number});
   let body;try{body=JSON.parse(run.resultMessage.trim());}catch{}
   if(body?.Serial!==undefined&&String(body.Serial).trim().toLowerCase()!==row.serial_number.trim().toLowerCase())throw fail('GRAPH_RESULT_SERIAL_MISMATCH');
  }
  return evidence;
 },collectionTimeoutMs,'GRAPH_COLLECTION_TIMEOUT',controller);}};
}
