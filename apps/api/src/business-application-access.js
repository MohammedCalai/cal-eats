import {randomUUID} from "node:crypto";
import {VALIDATION} from "../../../packages/contracts/src/index.js";
import {hashPassword,verifyPassword} from "./auth/passwords.js";
import {revokeUserSessions} from "./auth/session-management.js";
import {requireRole} from "./auth/authorization.js";
import {withTransaction} from "./db/index.js";
import {HttpError,exactObject,readJson,sendJson} from "./http.js";

// Deliberately no backfill: existing restaurant credentials stay unchanged.
export const businessApplicationAccessMigration59={version:59,name:"administrator_prepared_business_application_access",sql:`
CREATE TABLE business_application_access (
  restaurant_id TEXT PRIMARY KEY REFERENCES business_application_submissions(restaurant_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  password_set_by TEXT REFERENCES users(id),
  password_set_at TEXT,
  created_at TEXT NOT NULL,
  CHECK((password_set_at IS NULL AND password_set_by IS NULL) OR (password_set_at IS NOT NULL AND password_set_by IS NOT NULL))
);
`};

export function businessInitialPasswordPending(db,userId){
  return Boolean(db.prepare("SELECT 1 FROM business_application_access WHERE user_id=? AND password_set_at IS NULL").get(userId));
}

function applicationOwner(db,restaurantId){
  return db.prepare(`SELECT a.*,u.name,u.email,u.role,u.account_enabled,u.password_hash,r.status,r.suspended,r.archived_at,
    EXISTS(SELECT 1 FROM restaurant_memberships m WHERE m.restaurant_id=a.restaurant_id AND m.user_id=a.user_id AND m.permission='owner') owner_member
    FROM business_application_access a JOIN business_application_submissions s ON s.restaurant_id=a.restaurant_id AND s.user_id=a.user_id
    JOIN users u ON u.id=a.user_id JOIN restaurants r ON r.id=a.restaurant_id WHERE a.restaurant_id=?`).get(restaurantId);
}

export function businessApplicationAccessStatus(db,restaurantId){
  const row=applicationOwner(db,restaurantId);
  return row?{userId:row.user_id,name:row.name,email:row.email,passwordSetupRequired:!row.password_set_at,passwordSetAt:row.password_set_at,
    loginEnabled:Boolean(row.account_enabled),canSetInitialPassword:!row.password_set_at&&row.role==="restaurant"&&Boolean(row.owner_member)&&!row.suspended&&!row.archived_at&&["pending","approved"].includes(row.status)}:null;
}

export async function setBusinessApplicationPassword({req,res,db,config,session,checkRate,restaurantId}){
  const admin=requireRole(session,"admin"),body=await readJson(req,config.bodyLimit);
  exactObject(body,["password","passwordConfirmation","reason"]);
  const password=body.password,reason=typeof body.reason==="string"?body.reason.trim():"",key=req.headers["idempotency-key"];
  if(typeof key!=="string"||!/^[A-Za-z0-9_-]{16,120}$/.test(key))throw new HttpError(400,"VALIDATION_ERROR","A valid request reference is required");
  if(typeof password!=="string"||password.length<VALIDATION.passwordMin||password.length>VALIDATION.passwordMax||password!==body.passwordConfirmation||!/[A-Za-z]/.test(password)||!/[0-9]/.test(password)||/[\u0000-\u001f\u007f]/.test(password)||/^(?:password|qwerty|letmein|welcome|123456)/i.test(password))throw new HttpError(400,"VALIDATION_ERROR","Choose matching passwords of 12–200 characters with letters and numbers; avoid common passwords.");
  if(reason.length<3||reason.length>500||reason.includes("\0"))throw new HttpError(400,"VALIDATION_ERROR","Enter an administrator reason of 3–500 characters");
  if(reason.includes(password))throw new HttpError(400,"VALIDATION_ERROR","Keep the password out of the administrator reason");
  checkRate(req,`business-initial-password:${admin.id}:${restaurantId}`);
  const row=applicationOwner(db,restaurantId);
  if(!row||row.role!=="restaurant"||!row.owner_member)throw new HttpError(404,"NOT_FOUND","An eligible business application was not found");
  if(row.suspended||row.archived_at||!["pending","approved"].includes(row.status))throw new HttpError(409,"APPLICATION_ACCESS_UNAVAILABLE","Review this restaurant’s marketplace access before preparing its login");
  const prior=db.prepare("SELECT details FROM audit_events WHERE actor_user_id=? AND entity_type='restaurant' AND entity_id=? AND action='business_initial_password_set' AND json_valid(details) AND json_extract(details,'$.requestKey')=? LIMIT 1").get(admin.id,restaurantId,key);
  if(prior){
    const details=JSON.parse(prior.details);
    if(!row.password_set_at||!row.account_enabled||details.userId!==row.user_id||details.reason!==reason||!await verifyPassword(password,row.password_hash))throw new HttpError(409,"APPLICATION_ACCESS_CONFLICT","This request reference has already been used. Refresh the application’s access status.");
    return sendJson(res,200,{data:{configured:true,changed:false,...businessApplicationAccessStatus(db,restaurantId)}});
  }
  if(row.password_set_at)throw new HttpError(409,"BUSINESS_PASSWORD_ALREADY_SET","This business already has login credentials. Its owner can change or recover its password normally.");
  const passwordHash=await hashPassword(password),now=config.now().toISOString();
  withTransaction(db,()=>{
    const fresh=applicationOwner(db,restaurantId);
    if(!fresh||fresh.user_id!==row.user_id||fresh.password_hash!==row.password_hash||fresh.password_set_at||fresh.role!=="restaurant"||!fresh.owner_member||fresh.suspended||fresh.archived_at||!["pending","approved"].includes(fresh.status))throw new HttpError(409,"APPLICATION_ACCESS_CONFLICT","This application changed. Refresh its access status before continuing.");
    const marked=db.prepare("UPDATE business_application_access SET password_set_by=?,password_set_at=? WHERE restaurant_id=? AND user_id=? AND password_set_at IS NULL").run(admin.id,now,restaurantId,row.user_id);
    if(marked.changes!==1)throw new HttpError(409,"APPLICATION_ACCESS_CONFLICT","This application’s login has already been prepared");
    db.prepare("UPDATE users SET password_hash=?,account_enabled=1 WHERE id=? AND role='restaurant'").run(passwordHash,row.user_id);
    revokeUserSessions(db,row.user_id,now);
    db.prepare("UPDATE account_access_tokens SET consumed_at=COALESCE(consumed_at,?) WHERE user_id=? AND purpose='password_reset'").run(now,row.user_id);
    db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(),admin.id,"restaurant",restaurantId,"business_initial_password_set",JSON.stringify({userId:row.user_id,reason,requestKey:key,loginEnabled:true,approvalChanged:false}),now);
  });
  // Owner-initiated banking credential checks remain unchanged. This is not an
  // assertion that the owner personally changed their initial password.
  return sendJson(res,200,{data:{configured:true,changed:true,...businessApplicationAccessStatus(db,restaurantId)}});
}
