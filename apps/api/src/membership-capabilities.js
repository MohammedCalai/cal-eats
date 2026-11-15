import {requireRole,requireRestaurantOwner} from "./auth/authorization.js";
import {HttpError,exactObject,readJson,sendJson} from "./http.js";
import {randomUUID} from "node:crypto";
import {scopedCapabilitySession} from "./auth/membership-capability-scope.js";
import {withTransaction} from "./db/index.js";
const columns={canProcessOrders:"can_process_orders",canViewFinance:"can_view_finance",canViewDevices:"can_view_devices",canManageMenu:"can_manage_menu",canManageMarketing:"can_manage_marketing",canManageCustomers:"can_manage_customers",canManageSettings:"can_manage_settings",canManageStaff:"can_manage_staff"};
export function membershipCapabilitiesFromRow(row){const capabilities=Object.fromEntries(Object.entries(columns).map(([key,column])=>[key,row?.permission==="owner"||row?.[column]===1]));return {...capabilities,canPrint:capabilities.canProcessOrders};}
export function restaurantUserCapabilities(db,userId,restaurantId){
  const row=db.prepare("SELECT m.* FROM restaurant_memberships m JOIN users u ON u.id=m.user_id WHERE m.restaurant_id=? AND m.user_id=? AND u.role='restaurant' AND u.account_enabled=1").get(restaurantId,userId);
  if(!row)throw new HttpError(403,"RESTAURANT_CAPABILITY_REQUIRED","Restaurant access is required.");return membershipCapabilitiesFromRow(row);
}
export function requireRestaurantCapability(db,session,restaurantId,capability){
  const user=requireRole(session,"restaurant");if(!Object.hasOwn(columns,capability)||!restaurantUserCapabilities(db,user.id,restaurantId)[capability])throw new HttpError(403,"RESTAURANT_CAPABILITY_REQUIRED","Your business account does not have permission for this action.");return user;
}
export function scopeRestaurantCapabilities({req,url,db,session}){
  if(session?.user?.role!=="restaurant")return session;
  const match=/^\/api\/restaurant\/restaurants\/([^/]+)\/(.+)$/.exec(url.pathname);if(!match)return session;
  const [,restaurantId,path]=match,method=req.method;let capability;
  if((path==="menu"&&["GET","POST"].includes(method))||(/^menu\/[^/]+$/.test(path)&&method==="PATCH")||(path==="menu/order"&&method==="PUT")||(path==="menu/import"&&method==="POST")||(/^(?:cover|menu\/[^/]+\/photo)$/.test(path)&&["POST","DELETE"].includes(method)))capability="canManageMenu";
  else if(["profile","delivery"].includes(path)&&["GET","PATCH"].includes(method))capability="canManageSettings";
  else if(/^loyalty\/promotions(?:\/[^/]+(?:\/end)?)?$/.test(path)&&["GET","POST","PATCH"].includes(method))capability="canManageMarketing";
  else if(/^loyalty(?:\/(?:settings|suggestions))?$/.test(path)&&method==="GET")capability="canManageMarketing";
  else if(/^(?:customers|inbox)(?:\/[^/]+\/(?:profile|conversation)(?:\/read)?)?$/.test(path)&&["GET","POST","PATCH"].includes(method))capability="canManageCustomers";
  else if(/^printers\/[^/]+\/(?:test-receipt|reprints|jobs\/[^/]+\/check)$/.test(path)&&method==="POST")capability="canProcessOrders";
  else if((path==="printers"||/^printers\/[^/]+\/jobs$/.test(path))&&method==="GET")capability=["canViewDevices","canProcessOrders"];
  else if(method==="GET"&&/^finance\/(?:summary|orders(?:\/[^/]+\/breakdown)?|payouts(?:\/[^/]+)?|commission-policy|stripe(?:\/payouts)?)$/.test(path))capability="canViewFinance";
  if(!capability)return session;
  const row=db.prepare("SELECT m.* FROM restaurant_memberships m JOIN users u ON u.id=m.user_id WHERE m.restaurant_id=? AND m.user_id=? AND u.account_enabled=1 AND u.role='restaurant'").get(restaurantId,session.user.id);
  const granted=row&&membershipCapabilitiesFromRow(row),chosen=(Array.isArray(capability)?capability:[capability]).find(value=>granted?.[value]);
  return chosen?scopedCapabilitySession(session,restaurantId,chosen,columns[chosen]):session;
}
export async function routeMembershipCapabilities({req,res,url,db,config,session}){
  const m=/^\/api\/restaurant\/restaurants\/([^/]+)\/staff\/([^/]+)\/capabilities$/.exec(url.pathname);if(!m||!["GET","PATCH"].includes(req.method))return false;
  const user=requireRole(session,"restaurant");requireRestaurantOwner(db,session,m[1]);
  const member=db.prepare("SELECT * FROM restaurant_memberships WHERE restaurant_id=? AND user_id=? AND permission='staff'").get(m[1],m[2]);if(!member)throw new HttpError(404,"NOT_FOUND","Staff account not found.");
  if(req.method==="PATCH"){
    const body=await readJson(req,config.bodyLimit);exactObject(body,Object.keys(columns));if(!Object.keys(body).length||Object.values(body).some(value=>typeof value!=="boolean"))throw new HttpError(400,"VALIDATION_ERROR","Choose explicit staff permissions.");
    const entries=Object.entries(body);withTransaction(db,()=>{
      requireRestaurantOwner(db,session,m[1]);
      if(!db.prepare("SELECT 1 FROM users WHERE id=? AND role='restaurant' AND account_enabled=1").get(user.id))throw new HttpError(403,"FORBIDDEN","An active restaurant owner is required.");
      db.prepare(`UPDATE restaurant_memberships SET ${entries.map(([key])=>`${columns[key]}=?`).join(",")} WHERE restaurant_id=? AND user_id=? AND permission='staff'`).run(...entries.map(([,value])=>Number(value)),m[1],m[2]);
      db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(),user.id,"restaurant_membership",m[2],"staff_capabilities_changed",JSON.stringify({restaurantId:m[1],capabilities:body}),config.now().toISOString());
    });
  }
  return sendJson(res,200,{data:{userId:m[2],restaurantId:m[1],capabilities:restaurantUserCapabilities(db,m[2],m[1])}});
}
export function nativeBusinessCapabilities(db,userId){return {orderingAuthority:"paired_terminal_required",canProcessOrders:false,canPrint:false,restaurants:db.prepare("SELECT restaurant_id,permission FROM restaurant_memberships WHERE user_id=?").all(userId).map(row=>({restaurantId:row.restaurant_id,permission:row.permission,capabilities:{...restaurantUserCapabilities(db,userId,row.restaurant_id),canProcessOrders:false,canPrint:false}}))};}
