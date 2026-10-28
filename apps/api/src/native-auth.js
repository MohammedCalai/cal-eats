import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hashPassword, verifyPassword } from "./auth/passwords.js";
import { withTransaction } from "./db/index.js";
import { HttpError, exactObject, readJson, sendJson } from "./http.js";
import { publicUser, VALIDATION } from "../../../packages/contracts/src/index.js";
import { isDemoEmail } from "./seed.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const rawBearer = (req) => typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";

export function readNativeSession(db, req, config) {
  const token = rawBearer(req); if (!token) return null;
  const row = db.prepare("SELECT s.id session_id,s.created_at session_created_at,s.expires_at session_expires_at,u.* FROM native_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.account_enabled=1").get(hash(token),config.now().toISOString());
  if (row?.role === "customer") return { sessionId:row.session_id, native:true, nativeAudience:"customer", user:publicUser(row), createdAt:row.session_created_at, expiresAt:row.session_expires_at };
  const business = db.prepare("SELECT s.id session_id,s.created_at session_created_at,s.expires_at session_expires_at,u.* FROM native_business_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.account_enabled=1 AND u.role='restaurant' AND EXISTS(SELECT 1 FROM restaurant_memberships m WHERE m.user_id=u.id)").get(hash(token),config.now().toISOString());
  return business ? { sessionId:business.session_id, native:true, nativeAudience:"business", user:publicUser(business), createdAt:business.session_created_at, expiresAt:business.session_expires_at } : null;
}
function create(db,userId,config,audience="customer"){const token=randomBytes(32).toString("base64url"),now=config.now(),expires=new Date(now.getTime()+30*86400000);const id=randomUUID(),table=audience==="business"?"native_business_sessions":"native_sessions";db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?,?,NULL)`).run(id,userId,hash(token),now.toISOString(),expires.toISOString());return{id,token,expiresAt:expires.toISOString(),createdAt:now.toISOString()};}
function identity(body){const name=typeof body.name==="string"?body.name.trim():"",email=typeof body.email==="string"?body.email.trim().toLowerCase():"",password=typeof body.password==="string"?body.password:"";if(name.length<VALIDATION.nameMin||name.length>VALIDATION.nameMax||email.length>VALIDATION.emailMax||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<VALIDATION.passwordMin||password.length>VALIDATION.passwordMax)throw new HttpError(400,"VALIDATION_ERROR","Name, email or password is invalid");return{name,email,password};}
export async function routeNativeAuth({req,res,url,db,config,session,checkRate}){
  if(req.method==="POST"&&url.pathname==="/api/native/auth/register"){const b=await readJson(req,config.bodyLimit);exactObject(b,["name","email","password"]);const x=identity(b);if(config.runMode==="hosted-preview"&&isDemoEmail(x.email))throw new HttpError(400,"RESERVED_EMAIL","Email is reserved");checkRate(req,x.email);const ph=await hashPassword(x.password),u={id:randomUUID(),name:x.name,email:x.email,role:"customer"};let s;try{s=withTransaction(db,()=>{db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)").run(u.id,u.name,u.email,ph,u.role,config.now().toISOString());return create(db,u.id,config);});}catch(e){if(String(e.message).includes("UNIQUE"))throw new HttpError(409,"EMAIL_EXISTS","An account with this email already exists");throw e;}return sendJson(res,201,{data:{user:u,token:s.token,expiresAt:s.expiresAt}});}
  if(req.method==="POST"&&["/api/native/auth/login","/api/native/business/auth/login"].includes(url.pathname)){
    const business = url.pathname === "/api/native/business/auth/login", role = business ? "restaurant" : "customer";
    const b=await readJson(req,config.bodyLimit);exactObject(b,["email","password"]);const email=typeof b.email==="string"?b.email.trim().toLowerCase():"",password=typeof b.password==="string"?b.password:"";checkRate(req,email);
    for(let attempt=0;attempt<2;attempt++){
      const user=db.prepare("SELECT * FROM users WHERE email=? AND account_enabled=1").get(email),verifiedHash=user?.password_hash;
      if(!(await verifyPassword(password,verifiedHash))||!user||user.role!==role||(business&&!db.prepare("SELECT 1 FROM restaurant_memberships WHERE user_id=?").get(user.id)))throw new HttpError(401,"INVALID_CREDENTIALS","Email or password is incorrect");
      const created=withTransaction(db,()=>{const current=db.prepare("SELECT password_hash,role,account_enabled FROM users WHERE id=?").get(user.id);if(!current||current.password_hash!==verifiedHash||current.role!==role||!current.account_enabled||(business&&!db.prepare("SELECT 1 FROM restaurant_memberships WHERE user_id=?").get(user.id)))return null;return create(db,user.id,config,business?"business":"customer");});
      if(created)return sendJson(res,200,{data:{user:publicUser(user),token:created.token,expiresAt:created.expiresAt}});
    }
    throw new HttpError(401,"INVALID_CREDENTIALS","Email or password is incorrect");
  }
  if(req.method==="GET"&&url.pathname==="/api/native/auth/me"){if(!session?.native)throw new HttpError(401,"AUTH_REQUIRED","Native authentication required");return sendJson(res,200,{data:{user:session.user,session:{id:session.sessionId,createdAt:session.createdAt,expiresAt:session.expiresAt}}});}
  if(req.method==="POST"&&url.pathname==="/api/native/auth/logout"){if(!session?.native)throw new HttpError(401,"AUTH_REQUIRED","Native authentication required");const b=await readJson(req,config.bodyLimit);exactObject(b,[]);const table=session.nativeAudience==="business"?"native_business_sessions":"native_sessions";db.prepare(`UPDATE ${table} SET revoked_at=? WHERE id=? AND revoked_at IS NULL`).run(config.now().toISOString(),session.sessionId);return sendJson(res,200,{data:{loggedOut:true}});}
  return false;
}
