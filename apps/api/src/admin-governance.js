import { randomUUID } from "node:crypto";
import { requireRole } from "./auth/authorization.js";
import { revokeUserSessions } from "./auth/session-management.js";
import { withTransaction } from "./db/index.js";
import { HttpError, exactObject, readJson, sendJson } from "./http.js";

const nowIso = (config) => config.now().toISOString();
const bounded = (value, min, max, label) => { if (!Number.isSafeInteger(value) || value < min || value > max) throw new HttpError(400,"VALIDATION_ERROR",`${label} is invalid`); return value; };
const note = (value) => { if (typeof value !== "string" || !value.trim() || value.trim().length > 500) throw new HttpError(400,"VALIDATION_ERROR","Reason is invalid"); return value.trim(); };
const userDto = (row) => ({id:row.id,name:row.name,email:row.email,role:row.role,enabled:Boolean(row.account_enabled),createdAt:row.created_at});
const membershipDto = (row) => ({restaurantId:row.restaurant_id,userId:row.user_id,name:row.name,email:row.email,permission:row.permission,createdAt:row.created_at});
function audit(db,actor,action,type,id,details,now){db.prepare("INSERT INTO governance_audit VALUES(?,?,?,?,?,?,?)").run(randomUUID(),actor,action,type,id,JSON.stringify(details),now);}

export async function routeAdminGovernance({req,res,url,db,config,session}) {
  if (!url.pathname.startsWith("/api/admin/governance/")) return false;
  const admin=requireRole(session,"admin");
  if(req.method==="GET"&&url.pathname==="/api/admin/governance/accounts"){
    const rows=db.prepare("SELECT id,name,email,role,account_enabled,created_at FROM users ORDER BY created_at").all();
    return sendJson(res,200,{data:{items:rows.map(userDto),nextCursor:null}});
  }
  let match=url.pathname.match(/^\/api\/admin\/governance\/accounts\/([^/]+)$/);
  if(match&&req.method==="PATCH"){
    const body=await readJson(req,config.bodyLimit);exactObject(body,["enabled","reason"]);
    if(typeof body.enabled!=="boolean")throw new HttpError(400,"VALIDATION_ERROR","Enabled is invalid");
    const reason=note(body.reason),now=nowIso(config),target=withTransaction(db,()=>{
      const row=db.prepare("SELECT * FROM users WHERE id=?").get(match[1]);if(!row)throw new HttpError(404,"NOT_FOUND","Resource not found");
      if(!body.enabled&&row.id===admin.id)throw new HttpError(409,"SELF_LOCKOUT","You cannot disable your own account");
      if(!body.enabled&&row.role==="admin"&&db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND account_enabled=1 AND id<>?").get(row.id).n===0)throw new HttpError(409,"LAST_ADMIN","The last enabled administrator cannot be disabled");
      db.prepare("UPDATE users SET account_enabled=? WHERE id=?").run(Number(body.enabled),row.id);
      if(!body.enabled)revokeUserSessions(db,row.id,now);
      audit(db,admin.id,body.enabled?"account_enabled":"account_disabled","user",row.id,{reason},now);
      return db.prepare("SELECT * FROM users WHERE id=?").get(row.id);
    });
    return sendJson(res,200,{data:userDto(target)});
  }
  match=url.pathname.match(/^\/api\/admin\/governance\/restaurants\/([^/]+)\/memberships(?:\/([^/]+))?$/);
  if(match&&req.method==="GET"&&!match[2]){
    if(!db.prepare("SELECT 1 FROM restaurants WHERE id=?").get(match[1]))throw new HttpError(404,"NOT_FOUND","Resource not found");
    const rows=db.prepare("SELECT m.*,u.name,u.email FROM restaurant_memberships m JOIN users u ON u.id=m.user_id WHERE m.restaurant_id=? ORDER BY m.created_at").all(match[1]);
    return sendJson(res,200,{data:{items:rows.map(membershipDto),nextCursor:null}});
  }
  if(match&&req.method==="POST"&&!match[2]){
    const body=await readJson(req,config.bodyLimit);exactObject(body,["userId","permission","reason"]);const reason=note(body.reason);
    if(!["owner","staff"].includes(body.permission))throw new HttpError(400,"VALIDATION_ERROR","Permission is invalid");
    const now=nowIso(config),created=withTransaction(db,()=>{if(!db.prepare("SELECT 1 FROM restaurants WHERE id=?").get(match[1]))throw new HttpError(404,"NOT_FOUND","Resource not found");const user=db.prepare("SELECT * FROM users WHERE id=? AND role='restaurant' AND account_enabled=1").get(body.userId);if(!user)throw new HttpError(404,"NOT_FOUND","Eligible restaurant user not found");try{db.prepare("INSERT INTO restaurant_memberships(restaurant_id,user_id,created_at,permission) VALUES(?,?,?,?)").run(match[1],user.id,now,body.permission);}catch(error){if(String(error.message).includes("UNIQUE"))throw new HttpError(409,"MEMBERSHIP_EXISTS","Membership already exists");throw error;}audit(db,admin.id,"membership_added","restaurant_membership",`${match[1]}:${user.id}`,{permission:body.permission,reason},now);return db.prepare("SELECT m.*,u.name,u.email FROM restaurant_memberships m JOIN users u ON u.id=m.user_id WHERE m.restaurant_id=? AND m.user_id=?").get(match[1],user.id);});
    return sendJson(res,201,{data:membershipDto(created)});
  }
  if(match&&match[2]&&["PATCH","DELETE"].includes(req.method)){
    const body=await readJson(req,config.bodyLimit);exactObject(body,req.method==="PATCH"?["permission","reason"]:["reason"]);const reason=note(body.reason),permission=req.method==="PATCH"?body.permission:null;
    if(req.method==="PATCH"&&!["owner","staff"].includes(permission))throw new HttpError(400,"VALIDATION_ERROR","Permission is invalid");
    const now=nowIso(config);withTransaction(db,()=>{const row=db.prepare("SELECT * FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?").get(match[1],match[2]);if(!row)throw new HttpError(404,"NOT_FOUND","Resource not found");const removesOwner=row.permission==="owner"&&(req.method==="DELETE"||permission!=="owner");if(removesOwner&&db.prepare("SELECT COUNT(*) n FROM restaurant_memberships WHERE restaurant_id=? AND permission='owner' AND user_id<>?").get(match[1],match[2]).n===0)throw new HttpError(409,"LAST_OWNER","A restaurant must retain an owner");if(req.method==="DELETE")db.prepare("DELETE FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?").run(match[1],match[2]);else db.prepare("UPDATE restaurant_memberships SET permission=? WHERE restaurant_id=? AND user_id=?").run(permission,match[1],match[2]);audit(db,admin.id,req.method==="DELETE"?"membership_removed":"membership_permission_changed","restaurant_membership",`${match[1]}:${match[2]}`,{permission,reason},now);});
    return req.method==="DELETE"?sendJson(res,200,{data:{removed:true}}):sendJson(res,200,{data:{restaurantId:match[1],userId:match[2],permission}});
  }
  if(url.pathname==="/api/admin/governance/refund-policy"&&req.method==="GET")return sendJson(res,200,{data:policyDto(db.prepare("SELECT * FROM refund_response_policy WHERE id=1").get())});
  if(url.pathname==="/api/admin/governance/refund-policy"&&req.method==="PATCH"){
    const body=await readJson(req,config.bodyLimit);exactObject(body,["customerResponseHours","restaurantResponseHours","reminderLeadHours"]);const values=[bounded(body.customerResponseHours,1,720,"Customer response hours"),bounded(body.restaurantResponseHours,1,720,"Restaurant response hours"),bounded(body.reminderLeadHours,1,168,"Reminder lead hours")],now=nowIso(config);
    withTransaction(db,()=>{db.prepare("UPDATE refund_response_policy SET customer_response_hours=?,restaurant_response_hours=?,reminder_lead_hours=?,updated_by_user_id=?,updated_at=? WHERE id=1").run(...values,admin.id,now);audit(db,admin.id,"refund_response_policy_updated","refund_response_policy","1",{customerResponseHours:values[0],restaurantResponseHours:values[1],reminderLeadHours:values[2]},now);});
    return sendJson(res,200,{data:policyDto(db.prepare("SELECT * FROM refund_response_policy WHERE id=1").get())});
  }
  return false;
}

function policyDto(row){return{customerResponseHours:row.customer_response_hours,restaurantResponseHours:row.restaurant_response_hours,reminderLeadHours:row.reminder_lead_hours,updatedAt:row.updated_at};}
function notify(db,{userId,type,title,message,caseId,restaurantId,eventKey,now}){db.prepare("INSERT OR IGNORE INTO user_notifications(id,user_id,type,title,message,order_id,offer_id,restaurant_id,event_key,created_at,read_at) VALUES(?,?,?,?,?,NULL,NULL,?,?,?,NULL)").run(randomUUID(),userId,type,title,message,restaurantId,eventKey,now);}
export function runGovernanceReminders(db,config){
  const now=nowIso(config),nowMs=config.now().getTime(),policy=db.prepare("SELECT * FROM refund_response_policy WHERE id=1").get();let reminders=0,escalations=0;
  withTransaction(db,()=>{
    const waiting=db.prepare("SELECT * FROM refund_cases WHERE resolved_at IS NULL AND status IN ('awaiting_customer','awaiting_restaurant')").all();
    for(const item of waiting){const eventKinds=item.status==="awaiting_customer"?["request_information","restaurant_remedy_proposed","remedy_fulfilment_claimed"]:["ask_restaurant","restaurant_remedy_accepted"],episode=db.prepare(`SELECT id,created_at FROM refund_case_events WHERE case_id=? AND kind IN (${eventKinds.map(()=>"?").join(",")}) ORDER BY created_at DESC,id DESC LIMIT 1`).get(item.id,...eventKinds),episodeKey=episode?.id??`${item.status}:${item.updated_at}`,episodeAt=episode?.created_at??item.updated_at;let deadline=db.prepare("SELECT * FROM refund_response_deadlines WHERE case_id=?").get(item.id);if(!deadline||deadline.awaiting_status!==item.status||deadline.episode_key!==episodeKey){const hours=item.status==="awaiting_customer"?policy.customer_response_hours:policy.restaurant_response_hours,due=new Date(Date.parse(episodeAt)+hours*3600000).toISOString();db.prepare("INSERT INTO refund_response_deadlines(case_id,awaiting_status,due_at,reminder_sent_at,escalated_at,created_at,updated_at,episode_key) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(case_id) DO UPDATE SET awaiting_status=excluded.awaiting_status,due_at=excluded.due_at,reminder_sent_at=NULL,escalated_at=NULL,created_at=excluded.created_at,updated_at=excluded.updated_at,episode_key=excluded.episode_key").run(item.id,item.status,due,null,null,episodeAt,now,episodeKey);deadline=db.prepare("SELECT * FROM refund_response_deadlines WHERE case_id=?").get(item.id);}
      const dueMs=Date.parse(deadline.due_at),reminderAt=dueMs-policy.reminder_lead_hours*3600000;
      if(!deadline.reminder_sent_at&&nowMs>=reminderAt&&nowMs<dueMs){const recipients=item.status==="awaiting_customer"?[item.customer_id]:db.prepare("SELECT user_id FROM restaurant_memberships WHERE restaurant_id=? AND permission='owner'").all(item.restaurant_id).map(x=>x.user_id);for(const userId of recipients)notify(db,{userId,type:"refund_response_reminder",title:"Refund case response due",message:`Case ${item.reference} needs a response before its deadline.`,caseId:item.id,restaurantId:item.restaurant_id,eventKey:`refund:${item.id}:${deadline.episode_key}:reminder`,now});db.prepare("UPDATE refund_response_deadlines SET reminder_sent_at=?,updated_at=? WHERE case_id=? AND reminder_sent_at IS NULL").run(now,now,item.id);reminders++;}
      if(!deadline.escalated_at&&nowMs>=dueMs){for(const row of db.prepare("SELECT id FROM users WHERE role='admin' AND account_enabled=1").all())notify(db,{userId:row.id,type:"refund_response_escalation",title:"Refund response overdue",message:`Case ${item.reference} passed its response deadline and needs review.`,caseId:item.id,restaurantId:item.restaurant_id,eventKey:`refund:${item.id}:${deadline.episode_key}:escalated`,now});db.prepare("UPDATE refund_response_deadlines SET escalated_at=?,updated_at=? WHERE case_id=? AND escalated_at IS NULL").run(now,now,item.id);db.prepare("UPDATE refund_cases SET escalated_at=COALESCE(escalated_at,?),escalation_reason=COALESCE(escalation_reason,'response_deadline_passed'),updated_at=? WHERE id=?").run(now,now,item.id);audit(db,null,"refund_response_escalated","refund_case",item.id,{awaitingStatus:item.status,dueAt:deadline.due_at,episodeKey:deadline.episode_key},now);escalations++;}
    }
    db.prepare("DELETE FROM refund_response_deadlines WHERE case_id IN (SELECT id FROM refund_cases WHERE resolved_at IS NOT NULL OR status NOT IN ('awaiting_customer','awaiting_restaurant'))").run();
  });
  return{reminders,escalations};
}
