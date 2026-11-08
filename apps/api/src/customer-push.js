import {createCipheriv,createDecipheriv,createHash,createHmac,randomBytes,randomUUID} from "node:crypto";
import {requireRole} from "./auth/authorization.js";
import {withTransaction} from "./db/index.js";
import {HttpError,exactObject,readJson,sendJson} from "./http.js";
import {messageEncryptionKey} from "./message-encryption.js";

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const expoToken=/^(?:Expo|Exponent)PushToken\[[A-Za-z0-9_-]{10,200}\]$/;
const hash=value=>createHash("sha256").update(value).digest("hex");
const tokenKey=config=>{const {key,version}=messageEncryptionKey(config);return {key:createHmac("sha256",key).update("cal-eats:customer-push:v1").digest(),version};};
const aad=row=>Buffer.from(["cal-eats-customer-push-v1",row.id,row.installation_id,row.user_id,row.session_id,row.token_hash,row.platform,row.project_id,row.generation,row.key_version].join("|"));

export function loadCustomerPushConfig(env=process.env){
  const enabled=env.CALAI_CUSTOMER_PUSH_ENABLED==="true";
  if(env.CALAI_CUSTOMER_PUSH_ENABLED&&!['true','false'].includes(env.CALAI_CUSTOMER_PUSH_ENABLED))throw new Error("CALAI_CUSTOMER_PUSH_ENABLED must be true or false");
  const projects=name=>{const ids=(env[name]||"").split(",").map(v=>v.trim()).filter(Boolean);if(ids.length>10||ids.some(id=>!uuid.test(id)))throw new Error(`${name} must contain project UUIDs`);return [...new Set(ids.map(id=>id.toLowerCase()))];};
  const iosProjectIds=projects("CALAI_EXPO_PUSH_IOS_PROJECT_IDS"),androidProjectIds=projects("CALAI_EXPO_PUSH_ANDROID_PROJECT_IDS"),accessToken=env.CALAI_EXPO_PUSH_ACCESS_TOKEN||"";
  if(accessToken&&(accessToken.length>4096||/[\r\n\0]/.test(accessToken)))throw new Error("Expo push access token is invalid");
  if(enabled&&(!accessToken||!iosProjectIds.length&&!androidProjectIds.length))throw new Error("Customer push requires approved project IDs and the private Expo access token");
  return {enabled,accessToken,iosProjectIds,androidProjectIds};
}

function access(db,session,config){
  const user=requireRole(session,"customer");
  if(!session.native||session.nativeAudience!=="customer")throw new HttpError(403,"NATIVE_CUSTOMER_REQUIRED","Use the signed-in customer app to manage phone notifications");
  const row=db.prepare("SELECT s.expires_at FROM native_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.role='customer' AND u.account_enabled=1").get(session.sessionId,user.id,config.now().toISOString());
  if(!row)throw new HttpError(401,"AUTH_REQUIRED","Sign in again to manage phone notifications");return {user,expiresAt:row.expires_at};
}

export function revokeCustomerPushDevice(db,deviceId,stamp,generation=null){
  return db.prepare(`UPDATE customer_push_devices SET revoked_at=?,ciphertext=NULL,nonce=NULL,auth_tag=NULL,updated_at=? WHERE id=? AND revoked_at IS NULL${generation===null?"":" AND generation=?"}`).run(stamp,stamp,deviceId,...(generation===null?[]:[generation])).changes;
}

export async function routeCustomerPush({req,res,url,db,config,session,checkRate}){
  const match=url.pathname.match(/^\/api\/native\/push\/devices(?:\/([^/]+))?$/);if(!match)return false;
  const {user,expiresAt}=access(db,session,config);checkRate?.(req,`push-devices:${user.id}`);
  const stamp=config.now().toISOString();
  if(req.method==="DELETE"&&match[1]){
    if(!uuid.test(match[1]))throw new HttpError(400,"VALIDATION_ERROR","Installation ID is invalid");
    const row=db.prepare("SELECT id FROM customer_push_devices WHERE installation_id=? AND user_id=? AND session_id=?").get(match[1].toLowerCase(),user.id,session.sessionId);
    if(row)revokeCustomerPushDevice(db,row.id,stamp);
    return sendJson(res,200,{data:{registered:false,installationId:match[1].toLowerCase()}});
  }
  if(req.method!=="POST"||match[1])throw new HttpError(405,"METHOD_NOT_ALLOWED","Use POST to register or DELETE to remove phone notifications");
  const body=await readJson(req,config.bodyLimit);exactObject(body,["installationId","expoPushToken","platform","projectId","soundEnabled"]);
  if(!["installationId","expoPushToken","platform","projectId"].every(field=>typeof body[field]==="string")||!uuid.test(body.installationId)||!expoToken.test(body.expoPushToken)||!["ios","android"].includes(body.platform)||!uuid.test(body.projectId)||body.soundEnabled!==undefined&&typeof body.soundEnabled!=="boolean")throw new HttpError(400,"VALIDATION_ERROR","Phone notification registration is invalid");
  const settings=config.customerPush??{},allowed=body.platform==="ios"?settings.iosProjectIds:settings.androidProjectIds,projectId=body.projectId.toLowerCase(),installationId=body.installationId.toLowerCase();
  if(!allowed?.includes(projectId))throw new HttpError(403,"PUSH_PROJECT_NOT_ALLOWED","This app version is not enabled for phone notifications");
  let secret;try{secret=tokenKey(config);}catch{throw new HttpError(503,"PUSH_UNAVAILABLE","Phone notifications are temporarily unavailable");}
  withTransaction(db,()=>{
    access(db,session,config);
    const tokenHash=hash(body.expoPushToken),installation=db.prepare("SELECT * FROM customer_push_devices WHERE installation_id=?").get(installationId),tokenOwner=db.prepare("SELECT * FROM customer_push_devices WHERE token_hash=?").get(tokenHash),existing=tokenOwner??installation;
    if(installation&&tokenOwner&&installation.id!==tokenOwner.id){revokeCustomerPushDevice(db,installation.id,stamp);db.prepare("UPDATE customer_push_devices SET installation_id=NULL WHERE id=?").run(installation.id);}
    const unchanged=existing&&!existing.revoked_at&&existing.user_id===user.id&&existing.session_id===session.sessionId&&existing.token_hash===tokenHash&&existing.installation_id===installationId&&existing.platform===body.platform&&existing.project_id===projectId;
    const newActiveDevice=!existing||existing.revoked_at||existing.expires_at<=stamp||existing.user_id!==user.id;
    if(!unchanged&&newActiveDevice&&db.prepare("SELECT COUNT(*) n FROM customer_push_devices WHERE user_id=? AND revoked_at IS NULL AND expires_at>?").get(user.id,stamp).n>=10)throw new HttpError(429,"PUSH_DEVICE_LIMIT","Remove an old app session before adding another phone");
    const row={id:existing?.id??randomUUID(),installation_id:installationId,user_id:user.id,session_id:session.sessionId,token_hash:tokenHash,platform:body.platform,project_id:projectId,generation:unchanged?existing.generation:(existing?.generation??0)+1,key_version:secret.version};
    const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",secret.key,nonce);cipher.setAAD(aad(row));const ciphertext=Buffer.concat([cipher.update(body.expoPushToken,"utf8"),cipher.final()]);
    // Accept older clients' soundEnabled field for compatibility, but customer
    // alerts are always silent. Business device alerts have their own settings.
    db.prepare("INSERT INTO customer_push_devices(id,installation_id,user_id,session_id,token_hash,ciphertext,nonce,auth_tag,key_version,platform,project_id,generation,sound_enabled,expires_at,revoked_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?) ON CONFLICT(id) DO UPDATE SET installation_id=excluded.installation_id,user_id=excluded.user_id,session_id=excluded.session_id,token_hash=excluded.token_hash,ciphertext=excluded.ciphertext,nonce=excluded.nonce,auth_tag=excluded.auth_tag,key_version=excluded.key_version,platform=excluded.platform,project_id=excluded.project_id,generation=excluded.generation,sound_enabled=excluded.sound_enabled,expires_at=excluded.expires_at,revoked_at=NULL,updated_at=excluded.updated_at").run(row.id,installationId,user.id,session.sessionId,tokenHash,ciphertext.toString("base64"),nonce.toString("base64"),cipher.getAuthTag().toString("base64"),secret.version,body.platform,projectId,row.generation,0,expiresAt,stamp,stamp);
  });
  return sendJson(res,200,{data:{registered:true,installationId,expiresAt,pushEnabled:Boolean(settings.enabled)}});
}

export function decryptCustomerPushToken(config,row){
  const secret=tokenKey(config);if(secret.version!==row.key_version)throw new Error("Push key version unavailable");
  const decipher=createDecipheriv("aes-256-gcm",secret.key,Buffer.from(row.nonce,"base64"));decipher.setAAD(aad(row));decipher.setAuthTag(Buffer.from(row.auth_tag,"base64"));const token=Buffer.concat([decipher.update(Buffer.from(row.ciphertext,"base64")),decipher.final()]).toString("utf8");
  if(!expoToken.test(token)||hash(token)!==row.token_hash)throw new Error("Push device binding failed");return token;
}

export async function runCustomerPush(db,config,options){
  if(!config.customerPush?.enabled)return {accepted:0,receiptConfirmed:0,failed:0,unknown:0,cancelled:0,disabled:true};
  return (await import("./customer-push-worker.js")).runCustomerPushWorker(db,config,options);
}

export {customerPushMigration44} from "./customer-push-migration.js";
