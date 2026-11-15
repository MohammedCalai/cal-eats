import {createHash,createPublicKey,randomBytes,randomUUID,verify} from "node:crypto";
import {publicUser} from "../../../packages/contracts/src/index.js";
import {HttpError,exactObject,readJson,readRequestBody,cachedRequestBody,sendJson} from "./http.js";
import {requireRole,requireRestaurantOwner,requireRestaurantMembership} from "./auth/authorization.js";
import {requireRestaurantCapability} from "./membership-capabilities.js";

export const TERMINAL_SIGNATURE_MAX_AGE_MS=60000,TERMINAL_CONTACT_MAX_AGE_MS=60000,TERMINAL_SCREEN_MAX_AGE_MS=60000;
const signatureProof=Symbol("verified-ordering-terminal"),hash=value=>createHash("sha256").update(value).digest("hex"),secret=()=>randomBytes(32).toString("base64url");
const error=(code,message,status=403)=>new HttpError(status,code,message);
const text=(value,max=100)=>typeof value==="string"&&value.trim().length>0&&value.length<=max&&!/[\r\n\0]/.test(value)?value.trim():null;
const stamp=config=>config.now().toISOString();
function atomic(db,work){const name=`terminal_${randomBytes(8).toString("hex")}`;db.exec(`SAVEPOINT ${name}`);try{const result=work();db.exec(`RELEASE SAVEPOINT ${name}`);return result;}catch(cause){db.exec(`ROLLBACK TO SAVEPOINT ${name}`);db.exec(`RELEASE SAVEPOINT ${name}`);throw cause;}}
function audit(db,userId,restaurantId,action,details,now){db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(),userId,"ordering_terminal",restaurantId,action,JSON.stringify(details),now);}
function active(db,id){return db.prepare("SELECT t.* FROM ordering_terminals t JOIN restaurants r ON r.id=t.restaurant_id WHERE t.id=? AND t.revoked_at IS NULL AND r.archived_at IS NULL").get(id);}
function activeForRestaurant(db,id){return db.prepare("SELECT t.* FROM ordering_terminals t JOIN restaurants r ON r.id=t.restaurant_id WHERE t.restaurant_id=? AND t.revoked_at IS NULL AND r.archived_at IS NULL").get(id);}
function keyFromSpki(value){
  try{if(typeof value!=="string"||value.length>500)throw Error();const bytes=Buffer.from(value,"base64");if(bytes.toString("base64")!==value)throw Error();const key=createPublicKey({key:bytes,format:"der",type:"spki"});if(key.asymmetricKeyType!=="ec"||key.asymmetricKeyDetails?.namedCurve!=="prime256v1")throw Error();return {key,bytes,sha256:hash(bytes)};}catch{throw error("TERMINAL_KEY_INVALID","A valid P-256 terminal public key is required.",400);}
}
export function terminalCanonicalRequest({terminalId,timestamp,nonce,method,path,body=Buffer.alloc(0)}){return ["CAL-EATS-TERMINAL-V1",terminalId,timestamp,nonce,method.toUpperCase(),path,hash(body)].join("\n");}
export function terminalPairingProof({terminalId,challenge,publicKeySpki}){return ["CAL-EATS-PAIR-V1",terminalId,challenge,keyFromSpki(publicKeySpki).sha256].join("\n");}
function signatureBytes(value){if(typeof value!=="string"||!/^[A-Za-z0-9_-]{86}$/.test(value))throw error("TERMINAL_SIGNATURE_INVALID","The terminal signature is invalid.",401);const bytes=Buffer.from(value,"base64url");if(bytes.length!==64||bytes.toString("base64url")!==value)throw error("TERMINAL_SIGNATURE_INVALID","The terminal signature is invalid.",401);return bytes;}

export function verifyOrderingTerminalRequest({req,db,config,restaurantId}){
  let terminal=req[signatureProof]&&active(db,req[signatureProof].id);
  if(req[signatureProof]&&!terminal)throw error("TERMINAL_REVOKED","This ordering terminal has been revoked.");
  if(!terminal){
    const id=req.headers["x-cal-eats-terminal-id"],time=req.headers["x-cal-eats-terminal-timestamp"],nonce=req.headers["x-cal-eats-terminal-nonce"];
    if(typeof id!=="string"||!/^[-A-Za-z0-9_]{8,100}$/.test(id)||typeof time!=="string"||!/^\d{13}$/.test(time)||typeof nonce!=="string"||!/^[A-Za-z0-9_-]{22,86}$/.test(nonce))throw error("PAIRED_TERMINAL_REQUIRED","Use the restaurant's registered ordering tablet for this action.");
    if(Math.abs(config.now().getTime()-Number(time))>TERMINAL_SIGNATURE_MAX_AGE_MS)throw error("TERMINAL_SIGNATURE_EXPIRED","The terminal request expired. Please try again.",401);
    terminal=active(db,id);if(!terminal)throw error("TERMINAL_REVOKED","This ordering terminal is not active.");
    const body=cachedRequestBody(req);if(!body)throw error("TERMINAL_BODY_REQUIRED","The signed request body could not be verified.",400);
    const url=new URL(req.url,config.origin),canonical=terminalCanonicalRequest({terminalId:id,timestamp:time,nonce,method:req.method,path:url.pathname+url.search,body});
    const publicKey=keyFromSpki(terminal.public_key_spki);
    if(!verify("sha256",Buffer.from(canonical),{key:publicKey.key,dsaEncoding:"ieee-p1363"},signatureBytes(req.headers["x-cal-eats-terminal-signature"])))throw error("TERMINAL_SIGNATURE_INVALID","The terminal signature is invalid.",401);
    atomic(db,()=>{db.prepare("DELETE FROM ordering_terminal_nonces WHERE expires_at<=?").run(stamp(config));try{db.prepare("INSERT INTO ordering_terminal_nonces VALUES(?,?,?)").run(id,nonce,new Date(config.now().getTime()+120000).toISOString());}catch(cause){if(String(cause.message).includes("UNIQUE"))throw error("TERMINAL_REQUEST_REPLAYED","This terminal request has already been used.",409);throw cause;}});
    req[signatureProof]={id};
  }
  if(restaurantId&&terminal.restaurant_id!==restaurantId)throw error("TERMINAL_RESTAURANT_MISMATCH","This terminal belongs to a different restaurant.");
  req.terminal={...terminal,deviceId:terminal.id,terminalId:terminal.id,restaurantId:terminal.restaurant_id};return req.terminal;
}
function webSession(db,session,config){
  if(!session||session.native||session.terminalDelegation)throw error("BROWSER_SESSION_REQUIRED","Open the ordering screen in the registered tablet browser.");
  const user=requireRole(session,"restaurant"),row=db.prepare("SELECT s.id,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.account_enabled=1 AND u.role='restaurant'").get(session.sessionId,user.id,stamp(config));
  if(!row)throw error("AUTH_REQUIRED","Sign in again to the business platform.",401);return row;
}
function sessionStillValid(db,session,restaurantId,config){
  const user=requireRole(session,"restaurant");requireRestaurantCapability(db,session,restaurantId,"canProcessOrders");
  if(session.native)throw error("PAIRED_TERMINAL_REQUIRED","The mobile business account cannot process orders or print.");
  if(session.terminalDelegation){
    const row=db.prepare("SELECT 1 FROM ordering_terminal_sessions g JOIN sessions s ON s.id=g.session_id JOIN users u ON u.id=g.user_id WHERE g.token_hash=? AND g.user_id=? AND g.restaurant_id=? AND g.revoked_at IS NULL AND g.expires_at>? AND s.revoked_at IS NULL AND s.expires_at>? AND u.account_enabled=1 AND u.role='restaurant'").get(session.terminalGrantHash,user.id,restaurantId,stamp(config),stamp(config));
    if(!row)throw error("TERMINAL_USER_SESSION_EXPIRED","Sign in on the ordering tablet again.",401);
  }else webSession(db,session,config);
  return user;
}
export function orderingTerminalStatus(db,config,restaurantId){
  const row=activeForRestaurant(db,restaurantId),now=config.now().getTime();
  if(!row)return {registered:false,deviceId:null,name:null,status:"not_registered",lastContactAt:null,screenLastSeenAt:null,registeredAt:null,isReady:false,graceExceeded:true};
  const session=row.screen_session_id&&db.prepare("SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id JOIN restaurant_memberships m ON m.user_id=u.id WHERE s.id=? AND m.restaurant_id=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.account_enabled=1 AND u.role='restaurant' AND (m.permission='owner' OR m.can_process_orders=1)").get(row.screen_session_id,restaurantId,stamp(config));
  const freshnessMs=(config.businessDevices?.staleAfterSeconds??60)*1000;
  const contact=Date.parse(row.last_contact_at),screen=Date.parse(row.screen_last_seen_at),isReady=Boolean(session&&Number.isFinite(contact)&&now-contact>=0&&now-contact<=freshnessMs&&Number.isFinite(screen)&&now-screen>=0&&now-screen<=freshnessMs);
  return {registered:true,deviceId:row.id,name:row.name,status:isReady?"online":row.last_contact_at||row.screen_last_seen_at?"offline":"unknown",lastContactAt:row.last_contact_at,screenLastSeenAt:row.screen_last_seen_at,registeredAt:row.registered_at,revoked:false,isReady,graceExceeded:!isReady};
}
export const getTerminalReadiness=orderingTerminalStatus;
export function requireOrderingTerminal({req,db,config,session,restaurantId,action="orders"}){
  const terminal=verifyOrderingTerminalRequest({req,db,config,restaurantId});
  if(!["device","health"].includes(action)){
    sessionStillValid(db,session,terminal.restaurant_id,config);
    if(session.terminalDelegation&&session.terminalId!==terminal.id)throw error("TERMINAL_USER_SESSION_MISMATCH","This user session belongs to a different ordering terminal.");
    if(!orderingTerminalStatus(db,config,terminal.restaurant_id).isReady)throw error("ORDERING_SCREEN_OFFLINE","The registered tablet ordering screen is not connected. Open it before processing orders.",409);
  }
  return terminal;
}
export async function readOrderingTerminalSession({req,db,config}){
  const token=req.headers["x-cal-eats-terminal-session"];if(token===undefined)return null;
  if(typeof token!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(token))throw error("TERMINAL_USER_SESSION_EXPIRED","Sign in on the ordering tablet again.",401);
  await readRequestBody(req,config.bodyLimit);const terminal=verifyOrderingTerminalRequest({req,db,config}),tokenHash=hash(token),now=stamp(config);
  const row=db.prepare("SELECT g.*,u.name,u.email,u.role,s.expires_at original_expires_at FROM ordering_terminal_sessions g JOIN sessions s ON s.id=g.session_id AND s.user_id=g.user_id JOIN users u ON u.id=g.user_id WHERE g.token_hash=? AND g.terminal_id=? AND g.revoked_at IS NULL AND g.expires_at>? AND s.revoked_at IS NULL AND s.expires_at>? AND u.account_enabled=1 AND u.role='restaurant'").get(tokenHash,terminal.id,now,now);
  if(!row)throw error("TERMINAL_USER_SESSION_EXPIRED","Sign in on the ordering tablet again.",401);
  const session={sessionId:row.session_id,user:publicUser({id:row.user_id,name:row.name,email:row.email,role:row.role}),terminalDelegation:true,terminalGrantHash:tokenHash,terminalId:terminal.id,screenId:row.screen_id,expiresAt:row.expires_at};
  requireRestaurantMembership(db,session,row.restaurant_id);return session;
}
function controller(db,session,restaurantId){
  const user=requireRole(session,"admin","restaurant");if(!db.prepare("SELECT 1 FROM users WHERE id=? AND account_enabled=1 AND role=?").get(user.id,user.role))throw error("FORBIDDEN","An active account is required.");
  if(!db.prepare("SELECT 1 FROM restaurants WHERE id=? AND archived_at IS NULL").get(restaurantId))throw error("NOT_FOUND","Restaurant not found.",404);
  if(user.role!=="admin")requireRestaurantOwner(db,session,restaurantId);return user;
}
function issuerStillAllowed(db,userId,restaurantId){const user=db.prepare("SELECT role FROM users WHERE id=? AND account_enabled=1").get(userId);return user?.role==="admin"||user?.role==="restaurant"&&Boolean(db.prepare("SELECT 1 FROM restaurant_memberships WHERE user_id=? AND restaurant_id=? AND permission='owner'").get(userId,restaurantId));}
function retire(db,terminalId,userId,now){
  db.prepare("UPDATE ordering_terminals SET revoked_at=?,revoked_by=?,screen_last_seen_at=NULL,screen_session_id=NULL WHERE id=? AND revoked_at IS NULL").run(now,userId,terminalId);
  db.prepare("UPDATE ordering_terminal_sessions SET revoked_at=? WHERE terminal_id=? AND revoked_at IS NULL").run(now,terminalId);
}
export async function routeOrderingTerminals({req,res,url,db,config,session}){
  let match=/^\/api\/restaurant\/restaurants\/([^/]+)\/terminal(?:\/(pairing-code|revoke|session-handoff|screen-challenge))?$/.exec(url.pathname);
  if(match){
    const restaurantId=match[1],action=match[2];
    if(req.method==="GET"&&!action){if(session?.user.role==="admin")controller(db,session,restaurantId);else requireRestaurantMembership(db,session,restaurantId);return sendJson(res,200,{data:orderingTerminalStatus(db,config,restaurantId)});}
    if(req.method!=="POST")return false;
    const body=await readJson(req,config.bodyLimit),now=stamp(config);
    if(action==="pairing-code"){
      const user=controller(db,session,restaurantId);exactObject(body,["replace"]);if(body.replace!==undefined&&typeof body.replace!=="boolean")throw error("VALIDATION_ERROR","Choose whether to replace the current terminal.",400);
      const current=activeForRestaurant(db,restaurantId);if(current&&!body.replace)throw error("ACTIVE_TERMINAL_EXISTS","This restaurant already has a registered tablet. Choose replacement explicitly.",409);
      if(db.prepare("SELECT COUNT(*) n FROM ordering_terminal_pair_codes WHERE issued_by=? AND created_at>?").get(user.id,new Date(config.now().getTime()-600000).toISOString()).n>=5)throw error("TERMINAL_PAIRING_RATE_LIMITED","Please wait before creating another pairing code.",429);
      const terminalId=randomUUID(),code=randomBytes(12).toString("base64url"),challenge=secret(),expiresAt=new Date(config.now().getTime()+600000).toISOString();
      atomic(db,()=>{db.prepare("UPDATE ordering_terminal_pair_codes SET consumed_at=? WHERE restaurant_id=? AND consumed_at IS NULL").run(now,restaurantId);db.prepare("INSERT INTO ordering_terminal_pair_codes VALUES(?,?,?,?,?,?,?,?,NULL)").run(terminalId,restaurantId,hash(code),challenge,user.id,current?.id??null,now,expiresAt);audit(db,user.id,restaurantId,"terminal_pairing_issued",{terminalId,replaces:current?.id??null,expiresAt},now);});
      return sendJson(res,201,{data:{terminalId,code,challenge,expiresAt}});
    }
    if(action==="revoke"){
      const user=controller(db,session,restaurantId);exactObject(body,[]);atomic(db,()=>{const current=activeForRestaurant(db,restaurantId);if(current)retire(db,current.id,user.id,now);db.prepare("UPDATE ordering_terminal_pair_codes SET consumed_at=? WHERE restaurant_id=? AND consumed_at IS NULL").run(now,restaurantId);audit(db,user.id,restaurantId,"terminal_revoked",{deviceId:current?.id??null},now);});return sendJson(res,200,{data:orderingTerminalStatus(db,config,restaurantId)});
    }
    if(action==="session-handoff"||action==="screen-challenge"){
      exactObject(body,["screenId"]);if(!text(body.screenId,100)||!/^[A-Za-z0-9_-]{16,100}$/.test(body.screenId))throw error("VALIDATION_ERROR","A valid ordering screen identifier is required.",400);
      const original=webSession(db,session,config);requireRestaurantCapability(db,session,restaurantId,"canProcessOrders");const terminal=activeForRestaurant(db,restaurantId);if(!terminal)throw error("PAIRED_TERMINAL_REQUIRED","Register the ordering tablet before opening its ordering screen.");
      const token=secret(),expiresAt=new Date(config.now().getTime()+(action==="session-handoff"?120000:40000)).toISOString(),table=action==="session-handoff"?"ordering_terminal_handoffs":"ordering_terminal_screen_challenges";
      atomic(db,()=>{db.prepare(`DELETE FROM ${table} WHERE expires_at<=?`).run(now);db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?,?,?,?,?,NULL)`).run(hash(token),terminal.id,restaurantId,original.id,session.user.id,body.screenId,now,expiresAt);});
      return sendJson(res,201,{data:{terminalId:terminal.id,...(action==="session-handoff"?{handoffToken:token}:{challenge:token}),expiresAt}});
    }
    return false;
  }
  if(req.method==="POST"&&url.pathname==="/api/terminal-devices/pair"){
    const body=await readJson(req,config.bodyLimit);exactObject(body,["terminalId","code","deviceName","publicKeySpki","challengeSignature"]);
    if(!text(body.terminalId)||typeof body.code!=="string"||!/^[A-Za-z0-9_-]{16}$/.test(body.code)||!text(body.deviceName,100))throw error("TERMINAL_PAIRING_INVALID","Terminal setup is invalid or expired.",401);
    const pairing=db.prepare("SELECT * FROM ordering_terminal_pair_codes WHERE terminal_id=? AND code_hash=?").get(body.terminalId,hash(body.code)),key=keyFromSpki(body.publicKeySpki),now=stamp(config);
    if(!pairing||!verify("sha256",Buffer.from(terminalPairingProof({terminalId:pairing.terminal_id,challenge:pairing.challenge,publicKeySpki:body.publicKeySpki})),{key:key.key,dsaEncoding:"ieee-p1363"},signatureBytes(body.challengeSignature)))throw error("TERMINAL_PAIRING_INVALID","Terminal setup is invalid or expired.",401);
    const enrolled=atomic(db,()=>{
      const fresh=db.prepare("SELECT * FROM ordering_terminal_pair_codes WHERE terminal_id=? AND code_hash=?").get(body.terminalId,hash(body.code)),existing=active(db,body.terminalId);
      if(!fresh)throw error("TERMINAL_PAIRING_INVALID","Terminal setup is no longer available.",401);
      if(fresh.consumed_at){if(existing?.public_key_sha256===key.sha256)return existing;throw error("TERMINAL_PAIRING_INVALID","Terminal setup is no longer available.",401);}
      if(fresh.expires_at<=now||!issuerStillAllowed(db,fresh.issued_by,fresh.restaurant_id))throw error("TERMINAL_PAIRING_INVALID","Terminal setup is invalid or expired.",401);
      const current=activeForRestaurant(db,fresh.restaurant_id);if((current?.id??null)!==(fresh.expected_terminal_id??null))throw error("TERMINAL_PAIRING_CHANGED","The registered tablet changed. Request fresh setup.",409);
      if(!db.prepare("SELECT 1 FROM restaurants WHERE id=? AND archived_at IS NULL").get(fresh.restaurant_id))throw error("TERMINAL_PAIRING_INVALID","Terminal setup is unavailable.",401);
      if(current)retire(db,current.id,fresh.issued_by,now);
      db.prepare("UPDATE ordering_terminal_pair_codes SET consumed_at=? WHERE terminal_id=? AND consumed_at IS NULL").run(now,fresh.terminal_id);
      db.prepare("INSERT INTO ordering_terminals(id,restaurant_id,name,public_key_spki,public_key_sha256,registered_by,registered_at) VALUES(?,?,?,?,?,?,?)").run(fresh.terminal_id,fresh.restaurant_id,body.deviceName.trim(),body.publicKeySpki,key.sha256,fresh.issued_by,now);audit(db,fresh.issued_by,fresh.restaurant_id,"terminal_enrolled",{terminalId:fresh.terminal_id,publicKeySha256:key.sha256,replaced:current?.id??null},now);return active(db,fresh.terminal_id);
    });return sendJson(res,201,{data:{terminalId:enrolled.id,restaurantId:enrolled.restaurant_id,registeredAt:enrolled.registered_at}});
  }
  match=/^\/api\/terminal-devices\/([^/]+)\/(session|heartbeat|screen-heartbeat)$/.exec(url.pathname);if(!match||req.method!=="POST")return false;
  const body=await readJson(req,config.bodyLimit),terminal=verifyOrderingTerminalRequest({req,db,config}),now=stamp(config);if(terminal.id!==match[1])throw error("TERMINAL_RESTAURANT_MISMATCH","Terminal identity does not match this request.");
  if(match[2]==="heartbeat"){exactObject(body,[]);db.prepare("UPDATE ordering_terminals SET last_contact_at=? WHERE id=? AND revoked_at IS NULL").run(now,terminal.id);return sendJson(res,200,{data:orderingTerminalStatus(db,config,terminal.restaurant_id)});}
  if(match[2]==="session"){
    exactObject(body,["handoffToken"]);if(typeof body.handoffToken!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(body.handoffToken))throw error("TERMINAL_HANDOFF_INVALID","The ordering screen sign-in link is invalid or expired.",401);
    const token=secret(),grant=atomic(db,()=>{
      const h=db.prepare("SELECT h.*,s.expires_at original_expires_at FROM ordering_terminal_handoffs h JOIN sessions s ON s.id=h.session_id AND s.user_id=h.user_id JOIN users u ON u.id=h.user_id WHERE h.token_hash=? AND h.terminal_id=? AND h.consumed_at IS NULL AND h.expires_at>? AND s.revoked_at IS NULL AND s.expires_at>? AND u.account_enabled=1 AND u.role='restaurant'").get(hash(body.handoffToken),terminal.id,now,now);
      if(!h)throw error("TERMINAL_HANDOFF_INVALID","The ordering screen sign-in link is invalid or expired.",401);
      const user=db.prepare("SELECT id,name,email,role FROM users WHERE id=?").get(h.user_id);requireRestaurantCapability(db,{user},h.restaurant_id,"canProcessOrders");
      // A successful user switch supersedes every earlier handoff for this
      // terminal, including one whose local signing/HTTP response was delayed.
      // Otherwise that stale handoff could later revoke the newly active user.
      db.prepare("UPDATE ordering_terminal_handoffs SET consumed_at=? WHERE terminal_id=? AND consumed_at IS NULL").run(now,terminal.id);
      db.prepare("UPDATE ordering_terminal_screen_challenges SET consumed_at=? WHERE terminal_id=? AND consumed_at IS NULL").run(now,terminal.id);
      db.prepare("UPDATE ordering_terminal_sessions SET revoked_at=? WHERE terminal_id=? AND revoked_at IS NULL").run(now,terminal.id);
      db.prepare("UPDATE ordering_terminals SET screen_last_seen_at=NULL,screen_id=NULL,screen_session_id=NULL WHERE id=?").run(terminal.id);
      const expiresAt=new Date(Math.min(Date.parse(h.original_expires_at),config.now().getTime()+8*3600000)).toISOString();
      db.prepare("INSERT INTO ordering_terminal_sessions VALUES(?,?,?,?,?,?,?,?,NULL)").run(hash(token),terminal.id,h.restaurant_id,h.session_id,h.user_id,h.screen_id,now,expiresAt);return {user,expiresAt};
    });return sendJson(res,201,{data:{sessionToken:token,expiresAt:grant.expiresAt,user:publicUser(grant.user)}});
  }
  exactObject(body,["screenId","challenge"]);sessionStillValid(db,session,terminal.restaurant_id,config);
  if(session.terminalDelegation&&(session.terminalId!==terminal.id||session.screenId!==body.screenId))throw error("TERMINAL_SCREEN_MISMATCH","This screen is not linked to the current terminal sign-in.");
  atomic(db,()=>{
    const challenge=db.prepare("SELECT * FROM ordering_terminal_screen_challenges WHERE token_hash=? AND terminal_id=? AND session_id=? AND user_id=? AND screen_id=? AND consumed_at IS NULL AND expires_at>?").get(hash(String(body.challenge??"")),terminal.id,session.sessionId,session.user.id,body.screenId,now);
    if(!challenge)throw error("TERMINAL_SCREEN_CHALLENGE_INVALID","Refresh the ordering tablet screen connection.",401);
    db.prepare("UPDATE ordering_terminal_screen_challenges SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL").run(now,challenge.token_hash);
    db.prepare("UPDATE ordering_terminals SET screen_last_seen_at=?,screen_id=?,screen_session_id=?,last_contact_at=? WHERE id=? AND revoked_at IS NULL").run(now,body.screenId,session.sessionId,now,terminal.id);
  });return sendJson(res,200,{data:orderingTerminalStatus(db,config,terminal.restaurant_id)});
}

export async function authorizeTerminalRequest({req,url,db,config,session}){
  const write=["POST","PATCH","PUT","DELETE"].includes(req.method);if(!write)return false;let m,restaurantId,deviceOnly=false,device=null;
  if((m=/^\/api\/restaurant\/orders\/([^/]+)\/(status|preparation)$/.exec(url.pathname))||(m=/^\/api\/orders\/([^/]+)\/print-jobs$/.exec(url.pathname))){restaurantId=db.prepare("SELECT restaurant_id FROM orders WHERE id=?").get(m[1])?.restaurant_id;}
  else if((m=/^\/api\/print-jobs\/([^/]+)$/.exec(url.pathname))){restaurantId=db.prepare("SELECT o.restaurant_id FROM print_jobs p JOIN orders o ON o.id=p.order_id WHERE p.id=?").get(m[1])?.restaurant_id;}
  else if((m=/^\/api\/restaurant\/restaurants\/([^/]+)\/printers\/[^/]+\/(?:test-receipt|reprints|jobs\/[^/]+\/check)$/.exec(url.pathname)))restaurantId=m[1];
  else if((m=/^\/api\/admin\/restaurants\/([^/]+)\/manage\/printers\/[^/]+\/(?:test-receipt|reprints|jobs\/[^/]+\/check)$/.exec(url.pathname)))restaurantId=m[1];
  else if(url.pathname==="/api/devices/pair"){
    const body=await readJson(req,config.bodyLimit);restaurantId=typeof body.code==="string"?db.prepare("SELECT p.restaurant_id FROM printer_pairing_codes c JOIN restaurant_printers p ON p.id=c.printer_id WHERE c.code_hash=?").get(hash(body.code.trim()))?.restaurant_id:null;deviceOnly=true;
  }else if(/^\/api\/devices\/(?:heartbeat|jobs\/claim|jobs\/[^/]+\/(?:ack|submitting))$/.test(url.pathname)){
    const bearer=typeof req.headers.authorization==="string"&&req.headers.authorization.startsWith("Bearer ")?req.headers.authorization.slice(7):"";
    device=bearer&&db.prepare("SELECT id,restaurant_id,ordering_terminal_id FROM printer_devices WHERE token_hash=? AND revoked_at IS NULL").get(hash(bearer));restaurantId=device?.restaurant_id;deviceOnly=true;
  }else return false;
  if(!restaurantId)throw error("NOT_FOUND","Restaurant resource not found.",404);
  await readRequestBody(req,config.bodyLimit);const terminal=requireOrderingTerminal({req,db,config,session,restaurantId,action:deviceOnly?"device":"orders"});
  if(device){
    if(device.ordering_terminal_id&&device.ordering_terminal_id!==terminal.id)throw error("PRINTER_TERMINAL_MISMATCH","Register this printer with the current ordering tablet.");
    if(!device.ordering_terminal_id)db.prepare("UPDATE printer_devices SET ordering_terminal_id=? WHERE id=? AND ordering_terminal_id IS NULL").run(terminal.id,device.id);
    db.prepare("UPDATE ordering_terminals SET last_contact_at=? WHERE id=? AND revoked_at IS NULL").run(stamp(config),terminal.id);
  }
  return true;
}
