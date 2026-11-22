import {randomUUID} from 'node:crypto';
import {publicUser} from '../../../packages/contracts/src/index.js';
import {withTransaction} from './db/index.js';
import {HttpError,readJson,exactObject,sendJson} from './http.js';
import {requireRole} from './auth/authorization.js';
import {verifyPassword} from './auth/passwords.js';
import {hasLiveBankingCredential} from './auth/password-change.js';
import {createSession,cookieFor,tokenHash} from './auth/sessions.js';
import {CALAI_ORIGIN,PLATFORM_SESSION_MS,encryptPlatformTokens,decryptPlatformTokens,platformRequestHash} from './platform-admin-config.js';
import {createCalaiAdminAdapter} from './calai-admin-adapter.js';
import {isCalaiUserId,calaiRoutePolicy,validateCalaiMutation,sanitizeCalaiData,canonicalPlatformBody} from './platform-admin-policy.js';
import {validatePlatformUpload,PLATFORM_UPLOAD_BODY_BYTES} from './platform-admin-uploads.js';
import {validateCalaiLogoUrl,validateCalaiLogoBytes} from './platform-admin-logo.js';

const adapters=new WeakMap(),flights=new WeakMap();
function adapter(config){let value=adapters.get(config);if(!value){value=config.platformAdmin?.adapter??createCalaiAdminAdapter({maxResponseBytes:config.platformAdmin?.responseLimitBytes});adapters.set(config,value);}return value;}
function requireEnabled(config){if(!config.platformAdmin?.enabled||!config.platformAdmin.encryptionKey)throw new HttpError(503,'PLATFORM_LOGIN_UNAVAILABLE','Combined platform login has not been activated. Use the separate Cal-Eats administrator sign-in.');}
function admin(db,session,config){const user=requireRole(session,'admin');if(session.native||session.terminalDelegation)throw new HttpError(403,'PLATFORM_BROWSER_REQUIRED','Use the platform administrator website.');const row=db.prepare("SELECT u.*,s.id session_id,s.expires_at FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=? AND u.role='admin' AND u.account_enabled=1 AND s.id=? AND s.revoked_at IS NULL AND s.expires_at>?").get(user.id,session.sessionId,config.now().toISOString());if(!row)throw new HttpError(401,'AUTH_REQUIRED','Sign in again to the administrator website.');return row;}
function audit(db,userId,action,entityId,details,now){db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)').run(randomUUID(),userId,'platform_admin',entityId,action,JSON.stringify(details),now);}
function tokenMetadata(value,expectedId,config){
 try{if(typeof value!=='string'||value.length>10000||! /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value))throw Error();const payload=JSON.parse(Buffer.from(value.split('.')[1],'base64url').toString('utf8'));if(payload.id!==expectedId||payload.role!=='SYSTEM_OWNER'||!Number.isSafeInteger(payload.exp)||payload.exp*1000<=config.now().getTime()||payload.isImpersonated)throw Error();return payload;}
 catch{throw new HttpError(403,'CALAI_IDENTITY_INVALID','The Calai administrator identity could not be confirmed.');}
}
function identity(value){if(!value||!isCalaiUserId(value.id)||value.role!=='SYSTEM_OWNER'||typeof value.email!=='string'||value.email.length>254||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email))throw new HttpError(403,'CALAI_ADMIN_REQUIRED','A verified Calai platform administrator account is required.');return {id:value.id,email:value.email,name:[value.firstName,value.lastName].filter(part=>typeof part==='string').join(' ').slice(0,200),role:'SYSTEM_OWNER'};}
async function authenticate(config,email,password){
 const upstream=adapter(config),result=await upstream.login(email,password),person=identity(result?.user);
 const accessToken=await upstream.refresh(result.refreshToken);await upstream.probe(accessToken);
 tokenMetadata(result.accessToken,person.id,config);const refresh=tokenMetadata(result.refreshToken,person.id,config);tokenMetadata(accessToken,person.id,config);
 return {person,tokens:{accessToken,refreshToken:result.refreshToken},refreshExpiresAt:refresh.exp*1000};
}
const aad=row=>['cal-eats-platform-v1',row.session_id,row.user_id,row.link_id,CALAI_ORIGIN].join('|');
function record(db,sessionId){return db.prepare("SELECT p.*,l.upstream_user_id,l.provider_origin,l.revoked_at link_revoked_at,u.role,u.account_enabled,u.password_hash,s.revoked_at session_revoked_at,s.expires_at FROM platform_admin_sessions p JOIN platform_admin_links l ON l.id=p.link_id AND l.user_id=p.user_id JOIN users u ON u.id=p.user_id JOIN sessions s ON s.id=p.session_id AND s.user_id=p.user_id WHERE p.session_id=?").get(sessionId);}
function current(row,config){const now=config.now().getTime();return row&&row.role==='admin'&&row.account_enabled===1&&!row.revoked_at&&!row.link_revoked_at&&!row.session_revoked_at&&row.encrypted_tokens&&row.provider_origin===CALAI_ORIGIN&&Date.parse(row.absolute_expires_at)>now&&Date.parse(row.expires_at)>now;}
function invalidate(db,sessionId,config,expected=null){const stamp=config.now().toISOString();return withTransaction(db,()=>{if(expected){const fresh=record(db,sessionId);if(!fresh||fresh.link_id!==expected.link_id||fresh.encrypted_tokens!==expected.encrypted_tokens)return false;}db.prepare('UPDATE platform_admin_sessions SET encrypted_tokens=NULL,revoked_at=COALESCE(revoked_at,?) WHERE session_id=?').run(stamp,sessionId);db.prepare('UPDATE sessions SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(stamp,sessionId);return true;});}
async function revalidate(db,config,session){
 requireEnabled(config);const local=admin(db,session,config),before=record(db,session.sessionId);
 if(!before)throw new HttpError(403,'PLATFORM_CONNECTION_REQUIRED','Connect this Cal-Eats administrator session to Calai first.');
 if(!current(before,config)||before.user_id!==local.id||!hasLiveBankingCredential(db,local.id)){invalidate(db,session.sessionId,config,before);throw new HttpError(401,'PLATFORM_RECONNECT_REQUIRED','Reconnect your platform administrator account.');}
 try{
  const tokens=decryptPlatformTokens(config,before.encrypted_tokens,aad(before)),accessToken=await adapter(config).refresh(tokens.refreshToken);await adapter(config).probe(accessToken);
  tokenMetadata(tokens.refreshToken,before.upstream_user_id,config);tokenMetadata(accessToken,before.upstream_user_id,config);
  const encrypted=encryptPlatformTokens(config,{accessToken,refreshToken:tokens.refreshToken},aad(before));
  const saved=withTransaction(db,()=>{const fresh=record(db,session.sessionId);if(!current(fresh,config)||fresh.link_id!==before.link_id||fresh.password_hash!==before.password_hash||fresh.encrypted_tokens!==before.encrypted_tokens)return false;return db.prepare('UPDATE platform_admin_sessions SET encrypted_tokens=? WHERE session_id=? AND encrypted_tokens=? AND revoked_at IS NULL').run(encrypted,before.session_id,before.encrypted_tokens).changes===1;});
  if(!saved)throw new HttpError(401,'PLATFORM_RECONNECT_REQUIRED','The administrator connection changed. Sign in again.');
  return {userId:local.id,sessionId:session.sessionId,linkId:before.link_id,upstreamUserId:before.upstream_user_id,passwordHash:before.password_hash,accessToken};
 }catch(error){invalidate(db,session.sessionId,config,before);if(error instanceof HttpError)throw error;throw new HttpError(503,'CALAI_AUTHORITY_UNAVAILABLE','Calai administrator access could not be confirmed. Sign in again when the connection is available.');}
}
function assertContext(db,config,context){const row=record(db,context.sessionId);if(!current(row,config)||row.user_id!==context.userId||row.link_id!==context.linkId||row.upstream_user_id!==context.upstreamUserId||row.password_hash!==context.passwordHash||!hasLiveBankingCredential(db,context.userId))throw new HttpError(401,'PLATFORM_RECONNECT_REQUIRED','The administrator connection changed. Sign in again.');return row;}
export async function requirePlatformConnection(db,config,session){
 requireEnabled(config);admin(db,session,config);let databases=flights.get(config);if(!databases){databases=new WeakMap();flights.set(config,databases);}let group=databases.get(db);if(!group){group=new Map();databases.set(db,group);}let flight=group.get(session.sessionId);if(!flight){flight=revalidate(db,config,session);group.set(session.sessionId,flight);flight.finally(()=>{if(group.get(session.sessionId)===flight)group.delete(session.sessionId);}).catch(()=>{});}return flight;
}
export async function readCalaiBusinessDirectory(db,config,session){
 const context=await requirePlatformConnection(db,config,session);assertContext(db,config,context);
 const response=await adapter(config).request('GET','/tenants',undefined,context.accessToken);assertContext(db,config,context);
 if(response?.status!==200||response?.success!==true)throw new HttpError(503,'CALAI_DIRECTORY_UNAVAILABLE','The authorised native Calai business directory is unavailable. No integration records were changed.');
 if(!Array.isArray(response.data)||response.data.length>10000)throw new HttpError(502,'CALAI_DIRECTORY_INVALID','Calai returned an unsupported business directory.');
 const seen=new Set();
 return response.data.map(row=>{
  if(!row||typeof row!=='object'||Array.isArray(row)||!isCalaiUserId(row.id)||typeof row.name!=='string'||!row.name.trim()||row.name.length>200||/[\u0000-\u001f\u007f]/.test(row.name)||typeof row.status!=='string'||!row.status.trim()||row.status.length>64||/[\u0000-\u001f\u007f]/.test(row.status))throw new HttpError(502,'CALAI_DIRECTORY_INVALID','Calai returned an unsupported native business reference.');
  const id=row.id.toLowerCase();if(seen.has(id))throw new HttpError(502,'CALAI_DIRECTORY_INVALID','Calai returned conflicting native business references.');seen.add(id);
  return{id,name:row.name.trim(),status:row.status};
 });
}
export async function enforcePlatformAdminAuthority({req,url,db,config,session}){
 if(!session?.platformFederated)return;
 // HTML/assets must still load during an upstream outage. Public sign-in and
 // recovery must also remain independent of an old federated browser cookie.
 if(!url.pathname.startsWith('/api/'))return;
 const recovery=new Set(['/api/auth/login','/api/auth/register','/api/auth/logout','/api/auth/password/forgot','/api/auth/password/reset','/api/auth/email-verification/confirm','/api/platform-auth/login','/api/platform-auth/local-login','/api/platform-auth/settings','/api/admin/platform-connection/link','/api/native/auth/login','/api/native/business/auth/login','/api/native/auth/register','/api/native/business/auth/apply','/api/native/auth/forgot-password','/api/native/auth/reset-password','/api/native/auth/email-verification/confirm']);
 if(recovery.has(url.pathname)||url.pathname==='/api/runtime'||url.pathname.startsWith('/api/media/')||url.pathname==='/api/restaurants'||/^\/api\/restaurants\/[^/]+\/menu$/.test(url.pathname))return;
 if(req.method==='GET'&&url.pathname==='/api/admin/platform-connection/requests/lookup')return; // Its own handler also binds the immutable upstream identity.
 if(req.method==='POST'&&/^\/api\/admin\/platform-connection\/requests\/[0-9a-f-]{36}\/check$/.test(url.pathname))return; // Own reauthentication + fresh source proof inside its handler.
 if(!config.platformAdmin?.enabled){invalidate(db,session.sessionId,config);throw new HttpError(401,'PLATFORM_RECONNECT_REQUIRED','Use the separate Cal-Eats administrator sign-in.');}
 if(!url.pathname.startsWith('/api/admin/calai/'))await requirePlatformConnection(db,config,session);
}
async function reauthenticate(db,config,session,currentPassword,checkRate,req){
 const user=admin(db,session,config);if(typeof currentPassword!=='string'||currentPassword.length<12||currentPassword.length>200)throw new HttpError(403,'CURRENT_PASSWORD_INCORRECT','Enter your current Cal-Eats administrator password.');checkRate(req,'platform-link:'+user.email);
 if(!hasLiveBankingCredential(db,user.id))throw new HttpError(403,'PLATFORM_PASSWORD_SECURITY_REQUIRED','Secure your Cal-Eats administrator password before connecting accounts.');
 if(!await verifyPassword(currentPassword,user.password_hash))throw new HttpError(403,'CURRENT_PASSWORD_INCORRECT','Your current Cal-Eats administrator password is incorrect.');return user;
}
function credentials(body){const email=typeof body.email==='string'?body.email.trim():'',password=body.password;if(email.length>254||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||typeof password!=='string'||!password.length||password.length>200)throw new HttpError(400,'VALIDATION_ERROR','Enter your Calai administrator email and password.');return {email,password};}
function attach(db,config,sessionId,userId,link,proof){
 const existing=db.prepare('SELECT expires_at FROM sessions WHERE id=? AND user_id=? AND revoked_at IS NULL').get(sessionId,userId),now=config.now();
 if(!existing)throw new HttpError(401,'AUTH_REQUIRED','Sign in again.');
 const expires=new Date(Math.min(now.getTime()+PLATFORM_SESSION_MS,Date.parse(existing.expires_at),proof.refreshExpiresAt));
 if(expires.getTime()<=now.getTime())throw new HttpError(401,'CALAI_IDENTITY_INVALID','The Calai connection has expired.');
 const row={session_id:sessionId,user_id:userId,link_id:link.id},encrypted=encryptPlatformTokens(config,proof.tokens,aad(row));
 db.prepare('UPDATE sessions SET expires_at=? WHERE id=?').run(expires.toISOString(),sessionId);
 db.prepare('INSERT INTO platform_admin_sessions(session_id,link_id,user_id,encrypted_tokens,absolute_expires_at,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET link_id=excluded.link_id,user_id=excluded.user_id,encrypted_tokens=excluded.encrypted_tokens,absolute_expires_at=MIN(platform_admin_sessions.absolute_expires_at,excluded.absolute_expires_at),revoked_at=NULL').run(sessionId,link.id,userId,encrypted,expires.toISOString(),now.toISOString());return expires;
}
function connection(db,config,session){
 const user=admin(db,session,config),link=db.prepare('SELECT * FROM platform_admin_links WHERE user_id=? AND revoked_at IS NULL').get(user.id),row=record(db,session.sessionId),usable=Boolean(config.platformAdmin?.enabled&&current(row,config));
 const readOnly=config.platformAdmin?.readOnly!==false;
 return {enabled:Boolean(config.platformAdmin?.enabled),configured:Boolean(config.platformAdmin?.encryptionKey),readOnly,linked:Boolean(link),identity:link?{id:link.upstream_user_id,email:link.upstream_email,name:link.upstream_name,role:'SYSTEM_OWNER'}:null,session:{federated:usable,expiresAt:usable?row.absolute_expires_at:null},capabilities:{read:usable,write:usable&&!readOnly,uploads:usable&&!readOnly},globalSignOutSupported:false};
}
function requestState(res,status,id,state,code,message){return sendJson(res,status,{error:{code,message,details:{requestId:id,state}},meta:{source:'calai',requestId:id,state}});}
const mutationMeta=row=>({source:'calai',requestId:row.id,state:row.status});
function replay(res,row){if(row.status==='dispatching')return requestState(res,409,row.id,row.status,'CALAI_MUTATION_IN_PROGRESS','This request is being checked. Do not submit it again.');if(row.status==='unknown')return requestState(res,409,row.id,row.status,'CALAI_MUTATION_UNCERTAIN','Calai may have applied this request. Check its status before taking further action.');if(row.status.startsWith('operator_reported_'))return requestState(res,409,row.id,row.status,'CALAI_MUTATION_REVIEWED',row.review_result==='not_applied'?'You reported that this request was not applied. Start a separate new action if it is still needed.':'You reported that this request was applied. It has not been resubmitted.');return sendJson(res,row.response_status,JSON.parse(row.response_json));}
function requestDto(row){return {id:row.id,status:row.status,method:row.method,path:row.path,createdAt:row.created_at,updatedAt:row.updated_at,canRetry:false,canSubmitNewIntent:row.status==='operator_reported_not_applied',source:'calai',providerConfirmed:row.status==='confirmed',review:row.review_result?{result:row.review_result,note:row.review_note,reviewedAt:row.reviewed_at,reportedBy:'operator'}:null};}
function aliasRequestKey(db,context,requestKey,hash,id,stamp){db.prepare('INSERT INTO platform_admin_request_keys(user_id,request_key,request_id,request_hash,created_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,request_key) DO NOTHING').run(context.userId,requestKey,id,hash,stamp);const key=db.prepare('SELECT request_id,request_hash FROM platform_admin_request_keys WHERE user_id=? AND request_key=?').get(context.userId,requestKey);if(key.request_id!==id||key.request_hash!==hash)throw new HttpError(409,'IDEMPOTENCY_CONFLICT','This request identifier already belongs to another action.');}

export async function routePlatformAdmin({req,res,url,db,config,session,checkRate}){
 const path=url.pathname;
 if(path==='/api/platform-auth/settings'&&req.method==='GET')return sendJson(res,200,{data:{enabled:Boolean(config.platformAdmin?.enabled),readOnly:config.platformAdmin?.readOnly!==false,localLoginAvailable:true,loginAvailable:Boolean(config.platformAdmin?.enabled&&db.prepare("SELECT 1 FROM platform_admin_links l JOIN users u ON u.id=l.user_id WHERE l.revoked_at IS NULL AND u.account_enabled=1 AND u.role='admin' LIMIT 1").get()),provider:'calai',maxSessionHours:4}});
 if(path==='/api/platform-auth/login'&&req.method==='POST'){
  requireEnabled(config);const body=await readJson(req,config.bodyLimit);exactObject(body,['email','password']);const input=credentials(body);checkRate(req,'platform-login:'+input.email.toLowerCase());const proof=await authenticate(config,input.email,input.password);
  const outcome=withTransaction(db,()=>{const link=db.prepare("SELECT l.*,u.* ,l.id link_id FROM platform_admin_links l JOIN users u ON u.id=l.user_id WHERE l.provider_origin=? AND l.upstream_user_id=? AND l.revoked_at IS NULL AND u.role='admin' AND u.account_enabled=1").get(CALAI_ORIGIN,proof.person.id);if(!link||!hasLiveBankingCredential(db,link.user_id))throw new HttpError(403,'PLATFORM_IDENTITY_NOT_LINKED','This Calai administrator has not been linked to a Cal-Eats administrator. Use the separate Cal-Eats administrator sign-in to connect it.');const created=createSession(db,link.user_id,{...config,sessionHours:4}),stored=db.prepare('SELECT id FROM sessions WHERE token_hash=?').get(tokenHash(created.token));const expires=attach(db,config,stored.id,link.user_id,{id:link.link_id},proof);audit(db,link.user_id,'platform_sign_in',link.link_id,{source:'calai',upstreamUserId:proof.person.id},config.now().toISOString());return {user:publicUser({...link,id:link.user_id}),created,expires};});
  return sendJson(res,200,{data:{user:outcome.user}},{'Set-Cookie':cookieFor(outcome.created.token,outcome.expires,config.now(),config.secureCookies)});
 }
 if(path==='/api/admin/platform-connection'&&req.method==='GET')return sendJson(res,200,{data:connection(db,config,session)});
 if(path==='/api/admin/platform-connection/link'){
  const body=await readJson(req,config.bodyLimit);
  if(req.method==='DELETE'){
   exactObject(body,['currentPassword']);const before=await reauthenticate(db,config,session,body.currentPassword,checkRate,req);
   withTransaction(db,()=>{const fresh=admin(db,session,config);if(fresh.password_hash!==before.password_hash)throw new HttpError(409,'CREDENTIALS_CHANGED','Your account changed. Sign in again.');const now=config.now().toISOString(),links=db.prepare('SELECT id FROM platform_admin_links WHERE user_id=? AND revoked_at IS NULL').all(fresh.id);for(const link of links){db.prepare('UPDATE platform_admin_links SET revoked_at=?,updated_at=? WHERE id=?').run(now,now,link.id);db.prepare('UPDATE sessions SET revoked_at=COALESCE(revoked_at,?) WHERE id IN(SELECT session_id FROM platform_admin_sessions WHERE link_id=?)').run(now,link.id);audit(db,fresh.id,'platform_identity_unlinked',link.id,{source:'calai'},now);}});return sendJson(res,200,{data:{unlinked:true,signInRequired:Boolean(session.platformFederated)}});
  }
  if(req.method!=='POST')throw new HttpError(405,'METHOD_NOT_ALLOWED','Use POST or DELETE for the platform connection.');
  requireEnabled(config);exactObject(body,['currentPassword','email','password']);const before=await reauthenticate(db,config,session,body.currentPassword,checkRate,req),input=credentials(body),proof=await authenticate(config,input.email,input.password);
  const linked=withTransaction(db,()=>{const fresh=admin(db,session,config);if(fresh.password_hash!==before.password_hash||!hasLiveBankingCredential(db,fresh.id))throw new HttpError(409,'CREDENTIALS_CHANGED','Your administrator account changed. Sign in again.');const owned=db.prepare('SELECT * FROM platform_admin_links WHERE provider_origin=? AND upstream_user_id=? AND revoked_at IS NULL').get(CALAI_ORIGIN,proof.person.id);if(owned&&owned.user_id!==fresh.id)throw new HttpError(409,'PLATFORM_IDENTITY_ALREADY_LINKED','This Calai identity is already linked to another administrator.');const existing=db.prepare('SELECT * FROM platform_admin_links WHERE user_id=? AND revoked_at IS NULL').get(fresh.id);if(existing&&existing.upstream_user_id!==proof.person.id)throw new HttpError(409,'PLATFORM_IDENTITY_ALREADY_LINKED','Disconnect the existing Calai identity before linking a different account.');const now=config.now().toISOString(),link=owned??{id:randomUUID()};if(!owned)db.prepare('INSERT INTO platform_admin_links VALUES(?,?,?,?,?,?,?,?,NULL)').run(link.id,fresh.id,CALAI_ORIGIN,proof.person.id,proof.person.email,proof.person.name,now,now);else db.prepare('UPDATE platform_admin_links SET upstream_email=?,upstream_name=?,updated_at=? WHERE id=?').run(proof.person.email,proof.person.name,now,link.id);const created=createSession(db,fresh.id,{...config,sessionHours:4}),nextId=db.prepare('SELECT id FROM sessions WHERE token_hash=?').get(tokenHash(created.token)).id,expires=attach(db,config,nextId,fresh.id,link,proof);db.prepare('UPDATE sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(now,session.sessionId);audit(db,fresh.id,'platform_identity_linked',link.id,{source:'calai',upstreamUserId:proof.person.id,sessionRotated:true},now);return {created,expires,session:{sessionId:nextId,user:publicUser(fresh),platformFederated:true}};});
  return sendJson(res,200,{data:connection(db,config,linked.session)},{'Set-Cookie':cookieFor(linked.created.token,linked.expires,config.now(),config.secureCookies)});
 }
 if(path==='/api/admin/platform-connection/requests/lookup'&&req.method==='GET'){
  const user=admin(db,session,config),key=url.searchParams.get('key');if([...url.searchParams].length!==1||url.searchParams.getAll('key').length!==1||typeof key!=='string'||! /^[A-Za-z0-9_.:-]{8,100}$/.test(key))throw new HttpError(400,'VALIDATION_ERROR','Enter the saved request reference.');
  const context=await requirePlatformConnection(db,config,session);assertContext(db,config,context);const row=db.prepare('SELECT m.* FROM platform_admin_request_keys k JOIN platform_admin_mutations m ON m.id=k.request_id AND m.user_id=k.user_id JOIN platform_admin_links l ON l.id=m.link_id WHERE k.user_id=? AND k.request_key=? AND l.provider_origin=? AND l.upstream_user_id=?').get(user.id,key,CALAI_ORIGIN,context.upstreamUserId);if(!row)throw new HttpError(404,'NOT_FOUND','No saved request matched this reference. Do not resubmit an uncertain action.');return sendJson(res,200,{data:requestDto(row)});
 }
 const requestMatch=path.match(/^\/api\/admin\/platform-connection\/requests\/([0-9a-f-]{36})$/);
 if(requestMatch&&req.method==='GET'){const user=admin(db,session,config),row=db.prepare('SELECT * FROM platform_admin_mutations WHERE id=? AND user_id=?').get(requestMatch[1],user.id);if(!row)throw new HttpError(404,'NOT_FOUND','Request not found.');return sendJson(res,200,{data:requestDto(row)});}
 const checkMatch=path.match(/^\/api\/admin\/platform-connection\/requests\/([0-9a-f-]{36})\/check$/);
 if(checkMatch&&req.method==='POST'){
  const body=await readJson(req,config.bodyLimit);exactObject(body,['currentPassword','result','note']);const note=typeof body.note==='string'?body.note.trim():'';
  if(!['applied','not_applied'].includes(body.result)||note.length<20||note.length>1000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note))throw new HttpError(400,'VALIDATION_ERROR','Record what you checked in20–1000 characters and whether Calai applied the action.');
  const before=await reauthenticate(db,config,session,body.currentPassword,checkRate,req),context=await requirePlatformConnection(db,config,session);
  const checked=withTransaction(db,()=>{assertContext(db,config,context);const fresh=admin(db,session,config);if(fresh.password_hash!==before.password_hash)throw new HttpError(409,'CREDENTIALS_CHANGED','Your account changed. Sign in again.');const row=db.prepare('SELECT m.*,l.provider_origin,l.upstream_user_id FROM platform_admin_mutations m JOIN platform_admin_links l ON l.id=m.link_id WHERE m.id=? AND m.user_id=?').get(checkMatch[1],fresh.id);if(!row||row.provider_origin!==CALAI_ORIGIN||row.upstream_user_id!==context.upstreamUserId)throw new HttpError(404,'NOT_FOUND','Request not found.');if(row.review_result){if(row.review_result===body.result&&row.review_note===note)return row;throw new HttpError(409,'CALAI_REVIEW_CONFLICT','This request already has a recorded operator check.');}if(row.status!=='unknown'&&(row.status!=='dispatching'||Date.parse(row.updated_at)>config.now().getTime()-120000))throw new HttpError(409,'CALAI_REVIEW_NOT_NEEDED','This request is confirmed, rejected or still within its processing window.');const stamp=config.now().toISOString();db.prepare('UPDATE platform_admin_mutations SET status=?,review_result=?,review_note=?,reviewed_at=?,reviewed_by=?,updated_at=? WHERE id=?').run('operator_reported_'+body.result,body.result,note,stamp,fresh.id,stamp,row.id);audit(db,fresh.id,'platform_request_operator_checked',row.id,{source:'calai',result:body.result,providerConfirmed:false},stamp);return db.prepare('SELECT * FROM platform_admin_mutations WHERE id=?').get(row.id);});
  return sendJson(res,200,{data:requestDto(checked)});
 }
 if(!path.startsWith('/api/admin/calai/'))return false;
 if(path==='/api/admin/calai/settings/logo/image'&&req.method==='GET'){
  admin(db,session,config);if([...url.searchParams].length)throw new HttpError(400,'CALAI_FILTER_INVALID','The logo image does not accept a URL or filter.');const context=await requirePlatformConnection(db,config,session);assertContext(db,config,context);
  const metadata=await adapter(config).request('GET','/settings/logo',undefined,context.accessToken);assertContext(db,config,context);if(metadata.status!==200||!metadata.success)throw new HttpError(502,'CALAI_LOGO_INVALID','The Calai logo image is unavailable.');if(!metadata.data?.logoUrl)throw new HttpError(404,'CALAI_LOGO_NOT_SET','No Calai platform logo has been uploaded.');
  const sourceUrl=validateCalaiLogoUrl(metadata.data.logoUrl);assertContext(db,config,context);const fetched=await adapter(config).image(sourceUrl);assertContext(db,config,context);const image=validateCalaiLogoBytes(fetched.bytes),extension={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[image.mimeType];res.writeHead(200,{'Content-Type':image.mimeType,'Content-Length':image.bytes.length,'Content-Disposition':'inline; filename="calai-platform-logo.'+extension+'"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(image.bytes);return true;
 }
 admin(db,session,config);requireEnabled(config);
 if(req.method!=='GET'&&config.platformAdmin?.readOnly!==false)throw new HttpError(403,'CALAI_READ_ONLY','Calai is connected for viewing only. Changes to the original Calai platform are disabled.');
 const policy=calaiRoutePolicy(req.method,path.slice('/api/admin/calai'.length),url.searchParams),upload=['createAgentUpload','specialOffersUpload','logoUpload'].includes(policy.kind);
 const input=req.method==='GET'?undefined:await readJson(req,upload?PLATFORM_UPLOAD_BODY_BYTES:config.bodyLimit),body=req.method==='GET'?undefined:upload?validatePlatformUpload(policy.kind,input):validateCalaiMutation(policy.kind,input);
 const context=await requirePlatformConnection(db,config,session);let mutation;
 assertContext(db,config,context);
 if(req.method!=='GET'){
  const requestKey=req.headers['idempotency-key'];if(typeof requestKey!=='string'||! /^[A-Za-z0-9_.:-]{8,100}$/.test(requestKey))throw new HttpError(400,'IDEMPOTENCY_KEY_REQUIRED','A stable request identifier is required.');
  const descriptor=upload?{fields:body.fields,files:body.files.map(file=>({field:file.field,name:file.name,mimeType:file.mimeType,size:file.bytes.length,sha256:file.sha256}))}:body;
  const hash=platformRequestHash(config,canonicalPlatformBody({method:req.method,path:policy.target,body:descriptor}));
  const prior=db.prepare('SELECT m.*,k.request_hash alias_request_hash,l.provider_origin request_provider_origin,l.upstream_user_id request_upstream_user_id FROM platform_admin_request_keys k JOIN platform_admin_mutations m ON m.id=k.request_id AND m.user_id=k.user_id JOIN platform_admin_links l ON l.id=m.link_id WHERE k.user_id=? AND k.request_key=?').get(context.userId,requestKey);if(prior){if(prior.alias_request_hash!==hash||prior.request_provider_origin!==CALAI_ORIGIN||prior.request_upstream_user_id!==context.upstreamUserId)throw new HttpError(409,'IDEMPOTENCY_CONFLICT','This request identifier already belongs to another action.');return replay(res,prior);}
  // Reconnecting creates a new local link/SID, not a new upstream operation.
  // Keep uncertainty bound to the immutable source identity across recovery.
  const unresolved=db.prepare("SELECT m.* FROM platform_admin_mutations m JOIN platform_admin_links l ON l.id=m.link_id WHERE m.user_id=? AND l.provider_origin=? AND l.upstream_user_id=? AND m.method=? AND m.path=? AND (m.status IN('dispatching','unknown') OR (m.status='operator_reported_applied' AND m.request_hash=?)) ORDER BY m.created_at LIMIT 1").get(context.userId,CALAI_ORIGIN,context.upstreamUserId,req.method,policy.target,hash);if(unresolved){withTransaction(db,()=>{assertContext(db,config,context);aliasRequestKey(db,context,requestKey,hash,unresolved.id,config.now().toISOString());});return replay(res,unresolved);}
  checkRate(req,'platform-mutation:'+context.userId);mutation={id:randomUUID(),status:'dispatching'};const now=config.now().toISOString();withTransaction(db,()=>{assertContext(db,config,context);db.prepare('INSERT INTO platform_admin_mutations(id,user_id,link_id,request_key,request_hash,method,path,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(mutation.id,context.userId,context.linkId,requestKey,hash,req.method,policy.target,'dispatching',now,now);aliasRequestKey(db,context,requestKey,hash,mutation.id,now);audit(db,context.userId,'platform_request_dispatched',mutation.id,{source:'calai',method:req.method,path:policy.path},now);});
 }
 try{
  assertContext(db,config,context);
  const response=await adapter(config).request(req.method,policy.target,body,context.accessToken);
  const active=record(db,session.sessionId);if(!current(active,config)||active.link_id!==context.linkId||active.upstream_user_id!==context.upstreamUserId)throw new HttpError(401,'PLATFORM_RECONNECT_REQUIRED','Your administrator connection changed. Sign in again.');
  if(response.status>=200&&response.status<300&&response.success){const payload={data:sanitizeCalaiData(response.data??null),meta:{source:'calai',...(mutation?{requestId:mutation.id,state:'confirmed'}:{})}};if(mutation){const now=config.now().toISOString();withTransaction(db,()=>{db.prepare("UPDATE platform_admin_mutations SET status='confirmed',response_status=?,response_json=?,updated_at=? WHERE id=? AND status='dispatching'").run(response.status,JSON.stringify(payload),now,mutation.id);audit(db,context.userId,'platform_request_confirmed',mutation.id,{source:'calai',method:req.method,path:policy.path},now);});}return sendJson(res,response.status,payload);}
  if([401,403].includes(response.status)){invalidate(db,session.sessionId,config);if(!mutation)throw new HttpError(response.status,'CALAI_ADMIN_REQUIRED','Calai did not confirm your current administrator access. Sign in again.');}
  // Original delegated provider services sometimes map response loss to400.
  // Only its pre-handler authentication denial is a definite write rejection.
  if(mutation&&[401,403].includes(response.status)){const payload={error:{code:'CALAI_REQUEST_REJECTED',message:'Calai did not accept this request.'},meta:{source:'calai',requestId:mutation.id,state:'rejected'}};db.prepare("UPDATE platform_admin_mutations SET status='rejected',response_status=?,response_json=?,updated_at=? WHERE id=?").run(response.status,JSON.stringify(payload),config.now().toISOString(),mutation.id);return sendJson(res,response.status,payload);}
  throw new HttpError(503,'CALAI_UNAVAILABLE','Calai could not complete this request.');
 }catch(error){if(mutation){db.prepare("UPDATE platform_admin_mutations SET status='unknown',updated_at=? WHERE id=? AND status='dispatching'").run(config.now().toISOString(),mutation.id);return requestState(res,409,mutation.id,'unknown','CALAI_MUTATION_UNCERTAIN','Calai may have applied this request. Do not resend it. Check the affected record before contacting support.');}if(error instanceof HttpError)throw error;throw new HttpError(503,'CALAI_UNAVAILABLE','Calai is unavailable. Try again later.');}
}
