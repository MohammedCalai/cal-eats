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

export const customerPushMigration44={version:44,name:"customer_native_push",sql:`
CREATE TABLE customer_push_devices (
 id TEXT PRIMARY KEY,installation_id TEXT UNIQUE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,session_id TEXT NOT NULL REFERENCES native_sessions(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,ciphertext TEXT,nonce TEXT,auth_tag TEXT,key_version TEXT NOT NULL,platform TEXT NOT NULL CHECK(platform IN ('ios','android')),project_id TEXT NOT NULL,generation INTEGER NOT NULL,sound_enabled INTEGER NOT NULL DEFAULT 1 CHECK(sound_enabled IN (0,1)),expires_at TEXT NOT NULL,revoked_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE INDEX customer_push_device_user_idx ON customer_push_devices(user_id,revoked_at,expires_at);
CREATE TABLE customer_push_outbox (
 id TEXT PRIMARY KEY,notification_id TEXT NOT NULL REFERENCES user_notifications(id) ON DELETE CASCADE,device_id TEXT NOT NULL REFERENCES customer_push_devices(id) ON DELETE CASCADE,generation INTEGER NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('pending','claimed','accepted','receipt_confirmed','failed','unknown','cancelled')),attempts INTEGER NOT NULL DEFAULT 0,available_at TEXT,lease_owner TEXT,lease_expires_at TEXT,dispatch_started_at TEXT,ticket_id TEXT UNIQUE,receipt_due_at TEXT,receipt_attempts INTEGER NOT NULL DEFAULT 0,accepted_at TEXT,last_error TEXT,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(notification_id,device_id,generation)
);
CREATE INDEX customer_push_outbox_due_idx ON customer_push_outbox(status,available_at);
CREATE INDEX customer_push_receipts_due_idx ON customer_push_outbox(status,receipt_due_at);
CREATE TRIGGER customer_push_notification_insert AFTER INSERT ON user_notifications
 WHEN NEW.read_at IS NULL AND NEW.type IN ('order_status','order_eta','order_expired','order_refund','order_message','customer_message','support_request','support_receipt','support_reply','support_status','offer','platform_voucher','shop_rating')
 BEGIN
 INSERT OR IGNORE INTO customer_push_outbox(id,notification_id,device_id,generation,user_id,status,available_at,expires_at,created_at,updated_at)
 SELECT lower(hex(randomblob(16))),NEW.id,d.id,d.generation,NEW.user_id,'pending',
 CASE WHEN NEW.type='offer' THEN MAX(NEW.created_at,COALESCE(c.starts_at,c.created_at,NEW.created_at)) ELSE NEW.created_at END,
 CASE WHEN NEW.type='offer' THEN MIN(COALESCE(c.expires_at,strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at,'+24 hours')),strftime('%Y-%m-%dT%H:%M:%fZ',MAX(NEW.created_at,COALESCE(c.starts_at,c.created_at,NEW.created_at)),'+24 hours')) ELSE strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at,'+24 hours') END,NEW.created_at,NEW.created_at
 FROM customer_push_devices d JOIN native_sessions s ON s.id=d.session_id JOIN users u ON u.id=d.user_id
 LEFT JOIN offer_grants g ON g.id=NEW.offer_id AND g.customer_id=NEW.user_id LEFT JOIN offer_campaigns c ON c.id=g.campaign_id
 WHERE d.user_id=NEW.user_id AND d.revoked_at IS NULL AND d.expires_at>NEW.created_at AND s.revoked_at IS NULL AND s.expires_at>NEW.created_at AND u.role='customer' AND u.account_enabled=1;
 END;
CREATE TRIGGER customer_push_device_retired AFTER UPDATE OF generation,revoked_at ON customer_push_devices
 WHEN NEW.generation<>OLD.generation OR NEW.revoked_at IS NOT NULL
 BEGIN
 UPDATE customer_push_outbox SET status='cancelled',available_at=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error='PUSH_DEVICE_RETIRED',updated_at=NEW.updated_at
 WHERE device_id=NEW.id AND (generation<>NEW.generation OR NEW.revoked_at IS NOT NULL) AND (status IN ('pending','failed') OR (status='claimed' AND dispatch_started_at IS NULL));
 END;
CREATE TRIGGER customer_push_native_logout AFTER UPDATE OF revoked_at ON native_sessions WHEN NEW.revoked_at IS NOT NULL
 BEGIN UPDATE customer_push_devices SET revoked_at=NEW.revoked_at,ciphertext=NULL,nonce=NULL,auth_tag=NULL,updated_at=NEW.revoked_at WHERE session_id=NEW.id AND revoked_at IS NULL; END;
CREATE TRIGGER customer_push_offer_rescheduled AFTER UPDATE OF starts_at,expires_at ON offer_campaigns
 BEGIN
 UPDATE customer_push_outbox SET
 available_at=(SELECT MAX(n.created_at,COALESCE(NEW.starts_at,NEW.created_at)) FROM user_notifications n WHERE n.id=customer_push_outbox.notification_id),
 expires_at=MIN(NEW.expires_at,(SELECT strftime('%Y-%m-%dT%H:%M:%fZ',MAX(n.created_at,COALESCE(NEW.starts_at,NEW.created_at)),'+24 hours') FROM user_notifications n WHERE n.id=customer_push_outbox.notification_id))
 WHERE (status='pending' OR (status='failed' AND available_at IS NOT NULL)) AND notification_id IN (SELECT n.id FROM user_notifications n JOIN offer_grants g ON g.id=n.offer_id WHERE n.type='offer' AND g.campaign_id=NEW.id);
 END;
`};
