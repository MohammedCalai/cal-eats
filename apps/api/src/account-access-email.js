import {createCipheriv,createDecipheriv,createHash,createHmac,randomBytes,randomUUID} from "node:crypto";
import {withTransaction} from "./db/index.js";
import {messageEncryptionKey,messageEncryptionReadiness} from "./message-encryption.js";
import {createOrderAlertEmailAdapter,orderAlertEmailTransportReadiness} from "./order-alert-email.js";

const workers=new WeakMap(),adapters=new WeakMap(),LEASE_MS=120000,RETRY_MS=[60000,300000,900000,3600000],MAX_ATTEMPTS=5;
const hash=token=>createHash("sha256").update(token).digest("hex");
const aad=row=>Buffer.from(["cal-eats-account-access-v1",row.id,row.token_id,row.user_id,row.recipient,row.purpose,row.origin,row.expires_at,row.key_version].join("|"));
const key=config=>{const source=messageEncryptionKey(config);return {version:source.version,value:createHmac("sha256",source.key).update("cal-eats:account-access-email:v1").digest()};};
const safeCode=value=>typeof value==="string"&&/^[A-Z0-9_]{1,80}$/.test(value)?value:"ACCOUNT_EMAIL_DELIVERY_UNKNOWN";

export function accountAccessEmailDelivery(config){
  if(config.runMode==="local")return "local_simulation";
  return ["graph","smtp"].includes(config.orderAlertEmail.mode)&&orderAlertEmailTransportReadiness(config.orderAlertEmail).realDeliveryEnabled&&messageEncryptionReadiness(config).configured?"email":"unavailable";
}

/** The token and outbox are committed together by the caller; only ciphertext is stored. */
export function enqueueAccountAccessEmail(db,config,{id:tokenId,user,purpose,token,expiresAt,now}){
  const id=randomUUID(),secret=key(config),row={id,token_id:tokenId,user_id:user.id,recipient:user.email,purpose,origin:config.origin,expires_at:expiresAt,key_version:secret.version},nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",secret.value,nonce);
  cipher.setAAD(aad(row));const ciphertext=Buffer.concat([cipher.update(token,"utf8"),cipher.final()]);
  db.prepare("UPDATE account_access_email_outbox SET status='cancelled',last_error='ACCOUNT_TOKEN_SUPERSEDED',next_attempt_at=NULL,ciphertext=NULL,nonce=NULL,auth_tag=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE user_id=? AND purpose=? AND (status IN ('pending','failed') OR (status='claimed' AND dispatch_started_at IS NULL))").run(now,user.id,purpose);
  db.prepare("INSERT INTO account_access_email_outbox(id,token_id,user_id,recipient,purpose,origin,ciphertext,nonce,auth_tag,key_version,mode,status,next_attempt_at,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)").run(id,tokenId,user.id,user.email,purpose,config.origin,ciphertext.toString("base64"),nonce.toString("base64"),cipher.getAuthTag().toString("base64"),secret.version,config.orderAlertEmail.mode,now,expiresAt,now,now);
}

function sourceFailure(db,config,row,now){
  if(row.origin!==config.origin||row.mode!==config.orderAlertEmail.mode)return "ACCOUNT_EMAIL_CONFIGURATION_CHANGED";
  const source=db.prepare("SELECT t.*,u.email,u.account_enabled,u.email_verified_at FROM account_access_tokens t JOIN users u ON u.id=t.user_id WHERE t.id=? AND t.user_id=?").get(row.token_id,row.user_id);
  if(!source||!source.account_enabled||source.email.toLowerCase()!==row.recipient.toLowerCase()||source.issued_email?.toLowerCase()!==row.recipient.toLowerCase())return "ACCOUNT_EMAIL_SOURCE_CHANGED";
  if(source.purpose!==row.purpose||source.consumed_at||source.expires_at!==row.expires_at||source.expires_at<=now)return "ACCOUNT_TOKEN_EXPIRED_OR_CONSUMED";
  if(row.purpose==="email_verification"&&source.email_verified_at)return "ACCOUNT_ALREADY_VERIFIED";
  if(/(?:@[^@]*\.(?:local|invalid|test)$|@example\.(?:com|net|org)$)/i.test(row.recipient))return "ACCOUNT_EMAIL_TEST_RECIPIENT";
  return null;
}

function message(db,config,row){
  const secret=key(config);if(secret.version!==row.key_version)throw new Error("Account email encryption version unavailable");
  const decipher=createDecipheriv("aes-256-gcm",secret.value,Buffer.from(row.nonce,"base64"));decipher.setAAD(aad(row));decipher.setAuthTag(Buffer.from(row.auth_tag,"base64"));
  const token=Buffer.concat([decipher.update(Buffer.from(row.ciphertext,"base64")),decipher.final()]).toString("utf8");
  if(!/^[A-Za-z0-9_-]{40,100}$/.test(token)||db.prepare("SELECT token_hash FROM account_access_tokens WHERE id=?").get(row.token_id)?.token_hash!==hash(token))throw new Error("Account email token binding failed");
  const verify=row.purpose==="email_verification",title=verify?"Verify your Cal-Eats email":"Reset your Cal-Eats password",link=`${row.origin}/order/#${verify?"verify-email":"reset-password"}=${encodeURIComponent(token)}`;
  return {id:row.id,to:row.recipient,from:config.orderAlertEmail.from,messageId:`<cal-eats-account-email-${row.id}@calai.info>`,subject:title,text:`${title}\n\n${verify?"Confirm your email address":"Choose a new password"} using this secure link:\n${link}\n\nThis link expires ${verify?"in 24 hours":"in 30 minutes"} after it was requested and can be used once. If you did not request this, you can ignore this email.\n\nCal-Eats`};
}

async function run(db,config,{workerId=randomUUID(),limit=25,adapter,beforeDispatch}={}){
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new TypeError("Account email worker limit must be 1–100");
  const result={sent:0,failed:0,unknown:0,cancelled:0};if(config.runMode!=="hosted-preview")return result;
  const stamp=config.now().toISOString();
  withTransaction(db,()=>{
    db.prepare("UPDATE account_access_email_outbox SET status=CASE WHEN dispatch_started_at IS NULL THEN 'pending' ELSE 'unknown' END,last_error=CASE WHEN dispatch_started_at IS NULL THEN 'EMAIL_LEASE_RECOVERED_BEFORE_DISPATCH' ELSE 'EMAIL_LEASE_EXPIRED_AFTER_DISPATCH' END,next_attempt_at=CASE WHEN dispatch_started_at IS NULL THEN ? ELSE NULL END,ciphertext=CASE WHEN dispatch_started_at IS NULL THEN ciphertext ELSE NULL END,nonce=CASE WHEN dispatch_started_at IS NULL THEN nonce ELSE NULL END,auth_tag=CASE WHEN dispatch_started_at IS NULL THEN auth_tag ELSE NULL END,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE status='claimed' AND lease_expires_at<=?").run(stamp,stamp,stamp);
    result.cancelled+=db.prepare("UPDATE account_access_email_outbox SET status='cancelled',last_error='ACCOUNT_TOKEN_EXPIRED',next_attempt_at=NULL,ciphertext=NULL,nonce=NULL,auth_tag=NULL,updated_at=? WHERE status IN ('pending','failed') AND expires_at<=?").run(stamp,stamp).changes;
  });
  if(accountAccessEmailDelivery(config)!=="email")return result;
  if(!adapters.has(config))adapters.set(config,createOrderAlertEmailAdapter(config.orderAlertEmail));
  const sender=adapter??adapters.get(config);
  for(let i=0;i<limit;i++){
    const row=withTransaction(db,()=>{
      const now=config.now().toISOString(),candidate=db.prepare("SELECT * FROM account_access_email_outbox WHERE status IN ('pending','failed') AND next_attempt_at IS NOT NULL AND next_attempt_at<=? ORDER BY created_at,rowid LIMIT 1").get(now);if(!candidate)return null;
      const saved=db.prepare("UPDATE account_access_email_outbox SET status='claimed',attempts=attempts+1,lease_owner=?,lease_expires_at=?,dispatch_started_at=NULL,updated_at=? WHERE id=? AND status IN ('pending','failed') AND next_attempt_at<=?").run(workerId,new Date(Date.parse(now)+LEASE_MS).toISOString(),now,candidate.id,now);return saved.changes?{...candidate,attempts:candidate.attempts+1}:null;
    });if(!row)break;
    const owned=()=>Boolean(db.prepare("SELECT 1 FROM account_access_email_outbox WHERE id=? AND status='claimed' AND lease_owner=? AND lease_expires_at>?").get(row.id,workerId,config.now().toISOString()));
    const cancel=code=>db.prepare("UPDATE account_access_email_outbox SET status='cancelled',last_error=?,next_attempt_at=NULL,ciphertext=NULL,nonce=NULL,auth_tag=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='claimed' AND lease_owner=? AND dispatch_started_at IS NULL").run(code,config.now().toISOString(),row.id,workerId);
    const beforeSend=()=>withTransaction(db,()=>{
      if(!owned())return false;const now=config.now().toISOString(),failure=sourceFailure(db,config,row,now);if(failure){cancel(failure);return false;}
      return db.prepare("UPDATE account_access_email_outbox SET dispatch_started_at=?,updated_at=? WHERE id=? AND status='claimed' AND lease_owner=? AND dispatch_started_at IS NULL AND lease_expires_at>?").run(now,now,row.id,workerId,now).changes===1;
    });
    let outcome;
    try{await beforeDispatch?.(row);if(!owned())continue;const failure=sourceFailure(db,config,row,config.now().toISOString());if(failure){cancel(failure);result.cancelled++;continue;}outcome=await sender(message(db,config,row),{beforeSend});}
    catch{outcome={status:db.prepare("SELECT dispatch_started_at FROM account_access_email_outbox WHERE id=?").get(row.id)?.dispatch_started_at?"unknown":"failed",errorCode:"ACCOUNT_EMAIL_ADAPTER_ERROR"};}
    let status=["sent","failed","unknown","cancelled"].includes(outcome?.status)?outcome.status:"unknown";
    if(status==="sent"&&!db.prepare("SELECT dispatch_started_at FROM account_access_email_outbox WHERE id=?").get(row.id)?.dispatch_started_at)status="unknown";
    const now=config.now().toISOString(),retryAt=status==="failed"&&row.attempts<MAX_ATTEMPTS?new Date(Date.parse(now)+RETRY_MS[row.attempts-1]).toISOString():null,keep=status==="failed"&&retryAt!==null;
    const saved=db.prepare("UPDATE account_access_email_outbox SET status=?,last_error=?,next_attempt_at=?,sent_at=?,ciphertext=CASE WHEN ? THEN ciphertext ELSE NULL END,nonce=CASE WHEN ? THEN nonce ELSE NULL END,auth_tag=CASE WHEN ? THEN auth_tag ELSE NULL END,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='claimed' AND lease_owner=? AND lease_expires_at>?").run(status,status==="sent"?null:safeCode(outcome?.errorCode),retryAt,status==="sent"?now:null,keep?1:0,keep?1:0,keep?1:0,now,row.id,workerId,now);
    if(saved.changes)result[status]++;
  }
  return result;
}

export function runAccountAccessEmails(db,config,options){if(workers.has(db))return workers.get(db);const work=run(db,config,options).finally(()=>workers.delete(db));workers.set(db,work);return work;}

export const accountAccessEmailMigration43={version:43,name:"encrypted_account_access_email",sql:`
ALTER TABLE account_access_tokens ADD COLUMN issued_email TEXT;
UPDATE account_access_tokens SET consumed_at=COALESCE(consumed_at,created_at) WHERE issued_email IS NULL;
CREATE TABLE account_access_email_outbox (
 id TEXT PRIMARY KEY,token_id TEXT NOT NULL UNIQUE REFERENCES account_access_tokens(id),user_id TEXT NOT NULL REFERENCES users(id),recipient TEXT NOT NULL,purpose TEXT NOT NULL CHECK(purpose IN ('password_reset','email_verification')),origin TEXT NOT NULL,
 ciphertext TEXT,nonce TEXT,auth_tag TEXT,key_version TEXT NOT NULL,mode TEXT NOT NULL CHECK(mode IN ('graph','smtp')),
 status TEXT NOT NULL CHECK(status IN ('pending','claimed','sent','failed','unknown','cancelled')),attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TEXT,lease_owner TEXT,lease_expires_at TEXT,dispatch_started_at TEXT,sent_at TEXT,last_error TEXT,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE INDEX account_access_email_due_idx ON account_access_email_outbox(status,next_attempt_at);
CREATE INDEX account_access_email_user_idx ON account_access_email_outbox(user_id,purpose);
`};
