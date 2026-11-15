import {createCipheriv,createDecipheriv,createHash,createHmac,randomBytes,randomUUID} from "node:crypto";
import {requireRole} from "./auth/authorization.js";
import {withTransaction} from "./db/index.js";
import {HttpError,exactObject,readJson,sendJson} from "./http.js";
import {messageEncryptionKey} from "./message-encryption.js";
import {createExpoPushAdapter} from "./expo-push-adapter.js";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,EXPO=/^(?:Expo|Exponent)PushToken\[[A-Za-z0-9_-]{10,200}\]$/;
const project="6282b87e-36ae-43bb-80b7-12d69108a411",workers=new WeakMap(),adapters=new WeakMap();
const hash=value=>createHash('sha256').update(value).digest('hex');
const secret=config=>{const {key,version}=messageEncryptionKey(config);return {key:createHmac('sha256',key).update('cal-eats:business-push:v1').digest(),version};};
const aad=row=>Buffer.from(['cal-eats-business-push-v1',row.id,row.installation_id,row.user_id,row.session_id,row.token_hash,row.platform,row.project_id,row.generation,row.key_version].join('|'));
export function loadBusinessPushConfig(input={},env=process.env){
  const enabled=input.enabled??env.CALAI_BUSINESS_PUSH_ENABLED==='true';if(typeof enabled!=='boolean')throw Error('Business push enablement must be a boolean');
  const list=(value)=>{const ids=Array.isArray(value)?value:String(value??project).split(',').filter(Boolean);if(ids.length>10||ids.some(id=>!UUID.test(id)))throw Error('Business push project IDs must be UUIDs');return [...new Set(ids.map(v=>v.toLowerCase()))];};
  const accessToken=input.accessToken??env.CALAI_BUSINESS_EXPO_PUSH_ACCESS_TOKEN??'';if(typeof accessToken!=='string'||accessToken.length>4096||/[\r\n\0]/.test(accessToken))throw Error('Business push sender credential is invalid');
  const result={enabled,accessToken,iosProjectIds:list(input.iosProjectIds??env.CALAI_BUSINESS_PUSH_IOS_PROJECT_IDS),androidProjectIds:list(input.androidProjectIds??env.CALAI_BUSINESS_PUSH_ANDROID_PROJECT_IDS)};
  if(enabled&&(!accessToken||!result.iosProjectIds.length&&!result.androidProjectIds.length))throw Error('Business push requires its approved app projects and private sender connection');return result;
}
function sessionAccess(db,config,session){
  const user=requireRole(session,'restaurant');if(!session.native||session.nativeAudience!=='business')throw new HttpError(403,'NATIVE_BUSINESS_REQUIRED','Use Cal Eats Admin to register phone notifications');
  const row=db.prepare("SELECT s.expires_at FROM native_business_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.role='restaurant' AND u.account_enabled=1").get(session.sessionId,user.id,config.now().toISOString());
  if(!row)throw new HttpError(401,'AUTH_REQUIRED','Sign in again');return {user,expiresAt:row.expires_at};
}
function retire(db,id,stamp,generation=null){
  const changed=db.prepare(`UPDATE business_push_devices SET revoked_at=?,ciphertext=NULL,nonce=NULL,auth_tag=NULL,updated_at=? WHERE id=?${generation===null?'':' AND generation=?'}`).run(stamp,stamp,id,...(generation===null?[]:[generation]));
  db.prepare(`UPDATE business_incident_push_outbox SET status='cancelled',available_at=NULL,last_error='BUSINESS_DEVICE_RETIRED',updated_at=? WHERE device_id=? AND status IN ('pending','failed')${generation===null?'':' AND generation=?'}`).run(stamp,id,...(generation===null?[]:[generation]));return changed.changes;
}
export async function routeBusinessDevicePush({req,res,url,db,config,session,checkRate}){
  if(url.pathname==='/api/native/business/push/settings'&&req.method==='GET'){
    sessionAccess(db,config,session);const c=config.businessPush??loadBusinessPushConfig();return sendJson(res,200,{data:{enabled:c.enabled,configured:Boolean(c.enabled&&c.accessToken),iosProjectIds:c.iosProjectIds,androidProjectIds:c.androidProjectIds}});
  }
  const match=/^\/api\/native\/business\/push\/devices(?:\/([^/]+))?$/.exec(url.pathname);if(!match)return false;
  const {user,expiresAt}=sessionAccess(db,config,session);checkRate?.(req,`business-push:${user.id}`);const stamp=config.now().toISOString();
  if(req.method==='DELETE'&&match[1]){
    if(!UUID.test(match[1]))throw new HttpError(400,'VALIDATION_ERROR','Installation ID is invalid');
    const row=db.prepare("SELECT id FROM business_push_devices WHERE installation_id=? AND user_id=? AND session_id=?").get(match[1],user.id,session.sessionId);if(row)retire(db,row.id,stamp);return sendJson(res,200,{data:{registered:false}});
  }
  if(req.method!=='POST'||match[1])throw new HttpError(405,'METHOD_NOT_ALLOWED','Use POST or DELETE');
  const b=await readJson(req,config.bodyLimit);exactObject(b,['installationId','expoPushToken','platform','projectId']);
  if(!UUID.test(b.installationId??'')||!EXPO.test(b.expoPushToken??'')||!['ios','android'].includes(b.platform)||!UUID.test(b.projectId??''))throw new HttpError(400,'VALIDATION_ERROR','Phone registration is invalid');
  b.installationId=b.installationId.toLowerCase();b.projectId=b.projectId.toLowerCase();
  const c=config.businessPush??loadBusinessPushConfig(),ids=b.platform==='ios'?c.iosProjectIds:c.androidProjectIds;
  if(!ids.includes(b.projectId.toLowerCase()))throw new HttpError(403,'PUSH_PROJECT_NOT_ALLOWED','This business app project is not approved for notifications');
  let k;try{k=secret(config);}catch{throw new HttpError(503,'PUSH_UNAVAILABLE','Secure phone notification registration is unavailable');}
  withTransaction(db,()=>{
    sessionAccess(db,config,session);const tokenHash=hash(b.expoPushToken),old=db.prepare('SELECT * FROM business_push_devices WHERE token_hash=? OR installation_id=? ORDER BY CASE WHEN token_hash=? THEN 0 ELSE 1 END LIMIT 1').get(tokenHash,b.installationId,tokenHash);
    if(!old&&db.prepare('SELECT COUNT(*) n FROM business_push_devices WHERE user_id=? AND revoked_at IS NULL AND expires_at>?').get(user.id,stamp).n>=10)throw new HttpError(429,'PUSH_DEVICE_LIMIT','Remove an old business-app session first');
    const conflict=db.prepare('SELECT * FROM business_push_devices WHERE installation_id=? AND id<>?').get(b.installationId,old?.id??'');if(conflict){retire(db,conflict.id,stamp);db.prepare('UPDATE business_push_devices SET installation_id=NULL WHERE id=?').run(conflict.id);}
    if(old&&!old.revoked_at&&old.ciphertext&&old.token_hash===tokenHash&&old.installation_id===b.installationId.toLowerCase()&&old.user_id===user.id&&old.session_id===session.sessionId&&old.platform===b.platform&&old.project_id===b.projectId.toLowerCase()&&old.key_version===k.version){db.prepare('UPDATE business_push_devices SET expires_at=?,updated_at=? WHERE id=?').run(expiresAt,stamp,old.id);return;}
    if(old)retire(db,old.id,stamp);
    const row={id:old?.id??randomUUID(),installation_id:b.installationId.toLowerCase(),user_id:user.id,session_id:session.sessionId,token_hash:tokenHash,platform:b.platform,project_id:b.projectId.toLowerCase(),generation:(old?.generation??0)+1,key_version:k.version};
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',k.key,nonce);cipher.setAAD(aad(row));const ciphertext=Buffer.concat([cipher.update(b.expoPushToken,'utf8'),cipher.final()]);
    db.prepare("INSERT INTO business_push_devices(id,installation_id,user_id,session_id,token_hash,ciphertext,nonce,auth_tag,key_version,platform,project_id,generation,expires_at,revoked_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?) ON CONFLICT(id) DO UPDATE SET installation_id=excluded.installation_id,user_id=excluded.user_id,session_id=excluded.session_id,token_hash=excluded.token_hash,ciphertext=excluded.ciphertext,nonce=excluded.nonce,auth_tag=excluded.auth_tag,key_version=excluded.key_version,platform=excluded.platform,project_id=excluded.project_id,generation=excluded.generation,expires_at=excluded.expires_at,revoked_at=NULL,updated_at=excluded.updated_at").run(row.id,row.installation_id,user.id,session.sessionId,tokenHash,ciphertext.toString('base64'),nonce.toString('base64'),cipher.getAuthTag().toString('base64'),k.version,row.platform,row.project_id,row.generation,expiresAt,stamp,stamp);
  });return sendJson(res,200,{data:{registered:true,installationId:b.installationId,pushEnabled:Boolean(c.enabled)}});
}
function decodeToken(config,row){const k=secret(config);if(k.version!==row.key_version)throw Error('Business push key changed');const d=createDecipheriv('aes-256-gcm',k.key,Buffer.from(row.nonce,'base64'));d.setAAD(aad(row));d.setAuthTag(Buffer.from(row.auth_tag,'base64'));const token=Buffer.concat([d.update(Buffer.from(row.ciphertext,'base64')),d.final()]).toString('utf8');if(!EXPO.test(token)||hash(token)!==row.token_hash)throw Error('Business push device binding failed');return token;}
function source(db,config,row){
  const stamp=config.now().toISOString(),device=db.prepare("SELECT d.* FROM business_push_devices d JOIN native_business_sessions s ON s.id=d.session_id AND s.user_id=d.user_id JOIN users u ON u.id=d.user_id WHERE d.id=? AND d.generation=? AND d.user_id=? AND d.revoked_at IS NULL AND d.expires_at>? AND s.revoked_at IS NULL AND s.expires_at>? AND u.account_enabled=1 AND u.role='restaurant'").get(row.device_id,row.generation,row.user_id,stamp,stamp),incident=db.prepare('SELECT i.*,r.name restaurant_name,r.archived_at FROM business_device_incidents i JOIN restaurants r ON r.id=i.restaurant_id WHERE i.id=?').get(row.incident_id);
  if(!device||!incident||incident.archived_at||row.expires_at<=stamp||row.phase==='opened'&&incident.status!=='active'||row.phase==='resolved'&&incident.status!=='resolved')return null;
  if(!db.prepare("SELECT 1 FROM restaurant_memberships WHERE restaurant_id=? AND user_id=? AND (permission='owner' OR COALESCE(can_view_devices,0)=1)").get(incident.restaurant_id,row.user_id))return null;
  if(incident.fault_code!=='tablet_offline'&&row.phase==='opened'&&db.prepare("SELECT 1 FROM business_device_incidents WHERE restaurant_id=? AND fault_code='tablet_offline' AND status='active'").get(incident.restaurant_id))return null;
  const c=config.businessPush,ids=device.platform==='ios'?c.iosProjectIds:c.androidProjectIds;if(!ids.includes(device.project_id))return null;
  return {device,incident,payload:{to:decodeToken(config,device),title:row.phase==='resolved'?`Connection restored — ${incident.restaurant_name}`:incident.title,body:row.phase==='resolved'?'The connection has recovered after consecutive healthy checks. Open Cal Eats Admin for details.':incident.message,data:{kind:'device_incident',incidentId:incident.id,restaurantId:incident.restaurant_id},channelId:device.platform==='android'?'cal-eats-admin-updates':undefined,priority:'high',ttl:3600}};
}
async function run(db,config,{limit=10,workerId=randomUUID(),adapter,beforeDispatch}={}){
  if(!config.businessPush?.enabled)return {disabled:true,accepted:0,failed:0,unknown:0};
  const result={accepted:0,receiptConfirmed:0,failed:0,unknown:0,cancelled:0},stamp=config.now().toISOString();
  db.prepare("UPDATE business_incident_push_outbox SET status=CASE WHEN dispatch_started_at IS NULL THEN 'pending' ELSE 'unknown' END,available_at=CASE WHEN dispatch_started_at IS NULL THEN ? ELSE NULL END,last_error='BUSINESS_PUSH_LEASE_EXPIRED',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE status='claimed' AND lease_expires_at<=?").run(stamp,stamp,stamp);
  if(!adapters.has(config))adapters.set(config,adapter??createExpoPushAdapter(config.businessPush));const transport=adapter??adapters.get(config);
  for(const row of db.prepare("SELECT * FROM business_incident_push_outbox WHERE status='accepted' AND receipt_due_at<=? AND receipt_attempts<8 ORDER BY receipt_due_at LIMIT ?").all(stamp,limit)){
    let receipt;try{receipt=await transport.receipt(row.ticket_id);}catch{receipt={status:'pending'};}
    if(receipt.status==='invalid_device')retire(db,row.device_id,stamp,row.generation);
    const status=receipt.status==='receipt_confirmed'?'receipt_confirmed':['invalid_device','failed'].includes(receipt.status)?'failed':'accepted';
    db.prepare('UPDATE business_incident_push_outbox SET status=?,receipt_attempts=receipt_attempts+1,receipt_due_at=?,last_error=?,updated_at=? WHERE id=? AND status=\'accepted\'').run(status,status==='accepted'?new Date(Date.parse(stamp)+15*60000).toISOString():null,status==='receipt_confirmed'?null:'BUSINESS_PUSH_RECEIPT_PENDING',stamp,row.id);if(status==='receipt_confirmed')result.receiptConfirmed++;
  }
  for(let i=0;i<Math.min(limit,25);i++){
    const row=withTransaction(db,()=>{const x=db.prepare("SELECT * FROM business_incident_push_outbox WHERE status IN ('pending','failed') AND attempts<5 AND available_at<=? ORDER BY available_at,id LIMIT 1").get(config.now().toISOString());if(!x)return null;return db.prepare("UPDATE business_incident_push_outbox SET status='claimed',attempts=attempts+1,lease_owner=?,lease_expires_at=?,dispatch_started_at=NULL,updated_at=? WHERE id=? AND status IN ('pending','failed')").run(workerId,new Date(config.now().getTime()+30000).toISOString(),config.now().toISOString(),x.id).changes?{...x,attempts:x.attempts+1}:null;});if(!row)break;
    const owned=()=>db.prepare("SELECT 1 FROM business_incident_push_outbox WHERE id=? AND status='claimed' AND lease_owner=? AND lease_expires_at>?").get(row.id,workerId,config.now().toISOString());
    const beforeSend=()=>{if(!owned()||!source(db,config,row))return false;return db.prepare("UPDATE business_incident_push_outbox SET dispatch_started_at=?,updated_at=? WHERE id=? AND status='claimed' AND lease_owner=? AND dispatch_started_at IS NULL").run(config.now().toISOString(),config.now().toISOString(),row.id,workerId).changes===1;};
    let outcome;try{await beforeDispatch?.(row);if(!owned())continue;const current=source(db,config,row);outcome=current?await transport.send(current.payload,{beforeSend}):{status:'cancelled',errorCode:'BUSINESS_PUSH_SOURCE_UNAVAILABLE'};}catch{outcome={status:'unknown',errorCode:'BUSINESS_PUSH_DISPATCH_UNCERTAIN'};}
    const now=config.now().toISOString();if(outcome?.status==='invalid_device')retire(db,row.device_id,now,row.generation);
    const dispatched=db.prepare('SELECT dispatch_started_at FROM business_incident_push_outbox WHERE id=?').get(row.id)?.dispatch_started_at;
    const status=outcome?.status==='accepted'&&dispatched&&/^[A-Za-z0-9_-]{8,150}$/.test(outcome.ticketId??'')?'accepted':outcome?.status==='cancelled'?'cancelled':outcome?.status==='retry'&&dispatched&&outcome.errorCode!=='PUSH_RATE_LIMITED'?'unknown':['retry','failed','invalid_device'].includes(outcome?.status)?'failed':'unknown';
    // An explicit rate-limit rejection is safe to retry. A lost HTTP response
    // after dispatch may already have delivered and must remain uncertain.
    const retry=outcome?.status==='retry'&&row.attempts<5&&(!dispatched||outcome.errorCode==='PUSH_RATE_LIMITED'),code=/^[A-Z0-9_]{1,80}$/.test(outcome?.errorCode??'')?outcome.errorCode:null;
    const changed=db.prepare("UPDATE business_incident_push_outbox SET status=?,available_at=?,ticket_id=?,accepted_at=?,receipt_due_at=?,last_error=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='claimed' AND lease_owner=?").run(status,retry?new Date(Date.parse(now)+Math.min(3600000,15000*2**row.attempts)).toISOString():null,status==='accepted'?outcome.ticketId:null,status==='accepted'?now:null,status==='accepted'?new Date(Date.parse(now)+15*60000).toISOString():null,code,now,row.id,workerId);if(changed.changes)result[status]++;
  }return result;
}
export function runBusinessDevicePush(db,config,options){if(workers.has(db))return workers.get(db);const p=run(db,config,options).finally(()=>workers.delete(db));workers.set(db,p);return p;}
