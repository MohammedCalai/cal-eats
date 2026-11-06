import {createHash,randomUUID} from "node:crypto";
import {VALIDATION} from "../../../../packages/contracts/src/index.js";
import {requireUser} from "./authorization.js";
import {hashPassword,verifyPassword} from "./passwords.js";
import {revokeUserSessions} from "./session-management.js";
import {withTransaction} from "../db/index.js";
import {HttpError,exactObject,readJson,sendJson} from "../http.js";

const policy="live-banking-v1";
const fingerprint=value=>createHash("sha256").update(value).digest("hex");

export function hasLiveBankingCredential(db,userId){
  const user=db.prepare("SELECT password_hash,account_enabled FROM users WHERE id=?").get(userId);
  if(!user?.account_enabled)return false;
  return Boolean(db.prepare("SELECT 1 FROM audit_events WHERE entity_type='user' AND entity_id=? AND action='password_changed' AND json_valid(details) AND json_extract(details,'$.policy')=? AND json_extract(details,'$.credentialFingerprint')=? LIMIT 1").get(userId,policy,fingerprint(user.password_hash)));
}
export function requireLiveBankingCredential(db,userId){
  if(!hasLiveBankingCredential(db,userId))throw new HttpError(403,"LIVE_BANKING_PASSWORD_CHANGE_REQUIRED","Choose a new secure password before setting up real bank payouts.");
  const administrators=db.prepare("SELECT id FROM users WHERE role='admin' AND account_enabled=1").all();
  if(!administrators.length||administrators.some(row=>!hasLiveBankingCredential(db,row.id)))throw new HttpError(403,"PLATFORM_BANKING_PASSWORD_CHANGE_REQUIRED","The platform administrator must secure their account before real bank setup can continue.");
}

export async function routePasswordChange({req,res,url,db,config,session,checkRate}){
  if(url.pathname!=="/api/auth/password"&&url.pathname!=="/api/auth/password-security")return false;
  const user=requireUser(session);
  if(url.pathname==="/api/auth/password-security"){
    if(req.method!=="GET")throw new HttpError(405,"METHOD_NOT_ALLOWED","Password security checks are read-only");
    return sendJson(res,200,{data:{passwordChangeRequired:!hasLiveBankingCredential(db,user.id)}});
  }
  if(req.method!=="POST")throw new HttpError(405,"METHOD_NOT_ALLOWED","Use POST to change your password");
  const body=await readJson(req,config.bodyLimit);exactObject(body,["currentPassword","newPassword"]);
  const {currentPassword,newPassword}=body;
  if(typeof currentPassword!=="string"||!currentPassword.length||currentPassword.length>VALIDATION.passwordMax||typeof newPassword!=="string"||newPassword.length<VALIDATION.passwordMin||newPassword.length>VALIDATION.passwordMax||!/[A-Za-z]/.test(newPassword)||!/[0-9]/.test(newPassword)||/[\u0000-\u001f\u007f]/.test(newPassword)||newPassword===currentPassword||/^(?:password|qwerty|letmein|welcome|123456)/i.test(newPassword))throw new HttpError(400,"VALIDATION_ERROR","Choose a new password of 12–200 characters with letters and numbers; avoid common passwords.");
  checkRate(req,`password-change:${user.email}`);
  const row=db.prepare("SELECT password_hash,account_enabled FROM users WHERE id=?").get(user.id);
  if(!row?.account_enabled||!await verifyPassword(currentPassword,row.password_hash))throw new HttpError(403,"CURRENT_PASSWORD_INCORRECT","Your current password is incorrect.");
  const nextHash=await hashPassword(newPassword),now=config.now().toISOString();
  const revokedSessions=withTransaction(db,()=>{
    const fresh=db.prepare("SELECT password_hash,account_enabled FROM users WHERE id=?").get(user.id);
    if(!fresh?.account_enabled||fresh.password_hash!==row.password_hash)throw new HttpError(409,"CREDENTIALS_CHANGED","Your account changed. Sign in again before changing its password.");
    db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(nextHash,user.id);
    const revoked=revokeUserSessions(db,user.id,now,{exceptSessionId:session.sessionId});
    db.prepare("UPDATE account_access_tokens SET consumed_at=COALESCE(consumed_at,?) WHERE user_id=? AND purpose='password_reset'").run(now,user.id);
    db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(),user.id,"user",user.id,"password_changed",JSON.stringify({policy,credentialFingerprint:fingerprint(nextHash),otherSessionsRevoked:true}),now);
    return revoked;
  });
  return sendJson(res,200,{data:{changed:true,revokedSessions}});
}
