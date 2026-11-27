import {restaurantCapabilities} from './auth/authorization.js';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {HttpError,exactObject,readJson,sendJson} from './http.js';
import {createSession,cookieFor} from './auth/sessions.js';
import {verifyPassword} from './auth/passwords.js';
import {businessProductState,businessProductPermission,ensureBusinessProductPermissions,terminalHasCalaiAuthority} from './business-product-policy.js';
import {businessAccountMembership as membership} from './business-account-membership.js';
import {tabletApplicationProducts,tabletProductPermitted,tabletApplicationConfiguration,nativeBothPilot} from './tablet-product-policy.js';
import {managedTabletAwaitingBrowser} from './tablet-managed-setup.js';
import {readCalaiBusinessDirectory} from './platform-admin.js';
import {parseLondonDateRange} from './marketplace-reporting.js';
import {PAYABLE_ORDER_SQL} from './order-confirmation.js';
import {calaiLiveCallSummary,freshCalaiLiveCalls,readCalaiLiveCalls,readCalaiPhoneOrderActivity} from './calai-live-calls.js';
import {liveRestaurantOrderCounts} from './business-dashboard.js';
import {CALAI_BUSINESS_ORIGIN,authenticateCalaiBusiness,calaiBusinessAdapter,calaiBusinessReadPath,calaiTokenMetadata,assertCalaiBusinessIdentity,encryptCalaiBusinessCredentials,decryptCalaiBusinessCredentials,redactCalaiBusinessData,isSourceId} from './unified-business-calai.js';
export {authenticateCalaiBusiness} from './unified-business-calai.js';

const stamp=config=>config.now().toISOString();
const fail=(status,code,message)=>new HttpError(status,code,message);
const unavailable=()=>fail(404,'BUSINESS_NOT_FOUND','Business account not found.');
const tableExists=(db,name)=>Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
const terminal=session=>session?.principalKind==='terminal'||session?.terminalPrincipal===true;
const text=(value,label,max=160)=>{if(typeof value!=='string'||!value.trim()||value.trim().length>max||/[\r\n\0]/.test(value))throw fail(400,'VALIDATION_ERROR',`${label} is invalid.`);return value.trim();};
const noStore={'Cache-Control':'private, no-store'};
function withTransaction(db,work){const name='unified_'+randomBytes(8).toString('hex');db.exec('SAVEPOINT '+name);try{const result=work();db.exec('RELEASE SAVEPOINT '+name);return result;}catch(error){db.exec('ROLLBACK TO SAVEPOINT '+name);db.exec('RELEASE SAVEPOINT '+name);throw error;}}
const passwordText=value=>{if(typeof value!=='string'||value.length<1||value.length>256||/[\r\n\0]/.test(value))throw fail(400,'VALIDATION_ERROR','Password is invalid.');return value;};
function actor(db,session){
  if(!session?.user?.id)throw fail(401,'AUTH_REQUIRED','Sign in to the business platform.');
  const user=db.prepare('SELECT * FROM users WHERE id=? AND account_enabled=1').get(session.user.id);
  if(!user||!['admin','restaurant'].includes(user.role))throw fail(403,'FORBIDDEN','Business access is required.');
  if(session.sessionId&&!terminal(session)){const table=session.nativeAudience==='platform-admin'?'native_platform_sessions':session.nativeAudience==='business'?'native_business_sessions':'sessions';if(!db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND user_id=? AND revoked_at IS NULL`).get(session.sessionId,user.id))throw fail(401,'AUTH_REQUIRED','Sign in to the business platform again.');}
  if(user.principal_kind==='terminal'&&!terminal(session))throw fail(403,'TERMINAL_AUTH_REQUIRED','Use the registered tablet connection.');
  return user;
}
function human(db,session){const user=actor(db,session);if(terminal(session)||user.principal_kind==='terminal')throw fail(403,'OWNER_REQUIRED','An owner must sign in for this action.');return user;}
function audit(db,userId,businessId,action,details,now){db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)').run(randomUUID(),userId,'business_account',businessId,action,JSON.stringify(details),now);}
export function canonicalBusinessId(db,id){
  if(typeof id!=='string'||!id||id.length>100)throw unavailable();
  const seen=new Set();let value=id;
  for(let i=0;i<12;i++){if(seen.has(value))throw unavailable();seen.add(value);const alias=db.prepare('SELECT business_id FROM business_account_aliases WHERE old_id=?').get(value);if(!alias)return value;value=alias.business_id;}
  throw unavailable();
}
function rawAccount(db,id){return db.prepare('SELECT * FROM business_accounts WHERE id=? AND archived_at IS NULL').get(id);}
function links(db,id){return db.prepare('SELECT * FROM business_product_links WHERE business_id=? ORDER BY product').all(id);}
function access(db,session,id,{owner=false,calai=false}={}){
  const user=actor(db,session),canonical=canonicalBusinessId(db,id);
  if(terminal(session)&&(canonical!==id||session.businessId!==id))throw unavailable();
  if(!rawAccount(db,canonical))throw unavailable();
  const member=membership(db,user.id,canonical);
  if(user.role!=='admin'&&!member)throw unavailable();
  if(owner&&(terminal(session)||user.principal_kind==='terminal'||(user.role!=='admin'&&member?.permission!=='owner')))throw fail(403,'OWNER_REQUIRED','An owner must sign in for this action.');
  if(calai&&terminal(session)&&(!tabletProductPermitted(db,session.terminalId,canonical,'calai')||!terminalHasCalaiAuthority(db,session.terminalId,canonical)))throw fail(403,'CALAI_AUTHORITY_REQUIRED','The registered tablet has not been authorised for this native Calai account.');
  if(calai&&!terminal(session)){const proof=db.prepare("SELECT 1 FROM business_product_authorities a JOIN business_product_links p ON p.business_id=a.business_id AND p.product=a.product AND p.source_account_id=a.source_account_id AND p.upstream_user_id=a.source_user_id WHERE a.business_id=? AND a.product='calai' AND a.user_id=?").get(canonical,user.id);if(!proof)throw fail(403,'CALAI_AUTHORITY_REQUIRED','Verify your authority over this native Calai account. Cal-Eats roles do not grant Calai access.');}
  return{user,businessId:canonical,member,canManageProducts:!terminal(session)&&(user.role==='admin'||member?.permission==='owner')};
}
export function hasCurrentBusinessOwner(db,businessId){
  if(canonicalBusinessId(db,businessId)!==businessId||!rawAccount(db,businessId))return false;
  const eats=db.prepare("SELECT restaurant_id FROM business_product_links WHERE business_id=? AND product='cal-eats'").get(businessId);if(eats)return Boolean(db.prepare("SELECT 1 FROM restaurant_memberships m JOIN users u ON u.id=m.user_id WHERE m.restaurant_id=? AND m.permission='owner' AND u.role='restaurant' AND u.account_enabled=1 AND u.principal_kind='human'").get(eats.restaurant_id));
  return db.prepare("SELECT u.* FROM business_account_memberships m JOIN users u ON u.id=m.user_id WHERE m.business_id=? AND m.permission='owner' AND u.account_enabled=1 AND u.role IN('restaurant','admin')").all(businessId).some(user=>user.principal_kind!=='terminal'&&(!user.password_hash?.startsWith('!calai-external-only:')||db.prepare('SELECT 1 FROM business_source_identities WHERE user_id=?').get(user.id))&&membership(db,user.id,businessId)?.permission==='owner');
}
export function requireBusinessAccountOwner(db,session,businessId){return access(db,session,businessId,{owner:true}).user;}
export function businessAccountState(db,businessId,{config={}}={}){
  const id=canonicalBusinessId(db,businessId),account=rawAccount(db,id);if(!account)throw unavailable();
  const rows=links(db,id),calai=rows.find(row=>row.product==='calai'),eats=rows.find(row=>row.product==='cal-eats');
  const restaurant=eats&&db.prepare('SELECT archived_at FROM restaurants WHERE id=?').get(eats.restaurant_id);
  const product=(row,kind)=>{const policy=businessProductState(db,id,kind,config);return{...policy,active:Boolean(policy.adminAllowed&&row?.status==='active'&&(kind!=='cal-eats'||(restaurant&&!restaurant.archived_at))),linked:Boolean(row),status:row?.status??'not_linked',sourceAccountId:row?.source_account_id??null,financialAccess:false,nativeLinks:kind==='calai'?{dashboard:'https://calai.info/owner/dashboard',settings:'https://calai.info/owner/settings',statements:'https://calai.info/owner/settings/subscription',onboarding:'https://calai.info/'}:{dashboard:'/business/owner/dashboard',settings:'/business/owner/settings',statements:'/business/owner/finance'}};};
  return{id:account.id,name:account.name,eatsRestaurantId:eats?.restaurant_id??null,products:{calai:{...product(calai,'calai'),connectionStatus:!calai?'not_linked':!calai.encrypted_credentials?'reconnect_required':calai.last_error_code==='CALAI_UNAVAILABLE'?'unavailable':calai.last_error_code?'reconnect_required':'connected',verifiedSourceUserId:calai?.upstream_user_id??null,authExpiresAt:calai?.credential_expires_at??null,credentialCheckedAt:calai?.credential_checked_at??null,permanentDeviceSignInSupported:false,integratedWritesSupported:false},'cal-eats':product(eats,'cal-eats')},createdAt:account.created_at,updatedAt:account.updated_at};
}
export function ensureBusinessForRestaurant(db,restaurantId,config){
  const existing=db.prepare("SELECT business_id FROM business_product_links WHERE product='cal-eats' AND restaurant_id=?").get(restaurantId);if(existing)return businessAccountState(db,existing.business_id);
  const restaurant=db.prepare('SELECT id,name,created_at,archived_at FROM restaurants WHERE id=?').get(restaurantId);if(!restaurant||restaurant.archived_at)throw unavailable();
  const now=stamp(config),id=rawAccount(db,restaurant.id)?randomUUID():restaurant.id;
  withTransaction(db,()=>{db.prepare('INSERT INTO business_accounts(id,name,created_at,updated_at) VALUES(?,?,?,?)').run(id,restaurant.name,now,now);db.prepare("INSERT INTO business_product_links(id,business_id,product,source_account_id,restaurant_id,status,created_at,updated_at) VALUES(?,?,'cal-eats',?,?,'active',?,?)").run(randomUUID(),id,restaurant.id,restaurant.id,now,now);for(const row of db.prepare('SELECT user_id,permission,created_at FROM restaurant_memberships WHERE restaurant_id=?').all(restaurantId))db.prepare("INSERT INTO business_account_memberships(business_id,user_id,permission,created_at,membership_source) VALUES(?,?,?,?,'cal-eats')").run(id,row.user_id,row.permission,row.created_at);});
  ensureBusinessProductPermissions(db,id,now);return businessAccountState(db,id,{config});
}
function accountIds(db,user){
  if(user.role==='admin')return db.prepare('SELECT id FROM business_accounts WHERE archived_at IS NULL ORDER BY created_at,id').all().map(row=>row.id);
  return db.prepare(`SELECT DISTINCT a.id FROM business_accounts a LEFT JOIN business_account_memberships m ON m.business_id=a.id AND m.user_id=? LEFT JOIN business_product_links p ON p.business_id=a.id AND p.product='cal-eats' LEFT JOIN restaurant_memberships r ON r.restaurant_id=p.restaurant_id AND r.user_id=? WHERE a.archived_at IS NULL AND(m.user_id IS NOT NULL OR r.user_id IS NOT NULL) ORDER BY a.created_at,a.id`).all(user.id,user.id).map(row=>row.id).filter(id=>membership(db,user.id,id));
}
export function businessAccountForSession(db,session,config){
  const user=actor(db,session);
  if(terminal(session)){if(!isSourceId(session.businessId)||canonicalBusinessId(db,session.businessId)!==session.businessId)throw unavailable();access(db,session,session.businessId);return businessAccountState(db,session.businessId);}
  for(const restaurant of db.prepare('SELECT r.id FROM restaurants r JOIN restaurant_memberships m ON m.restaurant_id=r.id WHERE m.user_id=? AND r.archived_at IS NULL').all(user.id))ensureBusinessForRestaurant(db,restaurant.id,config);
  const ids=accountIds(db,user),preferred=db.prepare('SELECT business_id FROM business_account_preferences WHERE user_id=?').get(user.id);
  const selected=preferred?canonicalBusinessId(db,preferred.business_id):null,id=selected&&ids.includes(selected)?selected:ids[0];if(!id)throw unavailable();return businessAccountState(db,id);
}
function selectedContext(db,session,config){
 const selected=businessAccountForSession(db,session,config),state=businessAccountState(db,selected.id,{config}),rights=access(db,session,state.id),proof=db.prepare("SELECT source_user_id,source_account_id FROM business_product_authorities WHERE business_id=? AND product='calai' AND user_id=?").get(state.id,rights.user.id),calaiAllowed=Boolean(proof&&proof.source_user_id===state.products.calai.verifiedSourceUserId&&proof.source_account_id===state.products.calai.sourceAccountId),eatsMembership=state.eatsRestaurantId&&db.prepare("SELECT permission FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?").get(state.eatsRestaurantId,rights.user.id),admin=rights.user.role==='admin',canViewEats=Boolean(eatsMembership||admin),capabilities=state.eatsRestaurantId?restaurantCapabilities(db,session,state.eatsRestaurantId):{};
 if(terminal(session))state.products=tabletApplicationProducts(db,session.terminalId,state.id,state.products);
 state.products.calai.financialAccess=!terminal(session)&&calaiAllowed;
 state.products['cal-eats'].financialAccess=!terminal(session)&&Boolean(admin||capabilities.viewFinance);
 state.products['cal-eats'].capabilities={viewOrders:canViewEats,viewPayouts:state.products['cal-eats'].financialAccess,manageMenu:!terminal(session)&&Boolean(admin||capabilities.manageMenu),viewDevices:!terminal(session)&&Boolean(admin||capabilities.viewDevices),manageTerminal:!terminal(session)&&Boolean(admin||capabilities.manageTerminal)};
 const assignment=terminal(session)?tabletApplicationConfiguration(db,session.terminalId,state.id,config):null;
 return{...state,...(terminal(session)?{tabletConfiguration:assignment,...(nativeBothPilot(config,assignment)?{nativeBothLaunch:true}:{})}:{}),canManageProducts:admin,canConnectProducts:rights.canManageProducts,canViewEats:canViewEats&&(!terminal(session)||state.products['cal-eats'].allowedOnTablet),canViewCalai:terminal(session)?state.products.calai.allowedOnTablet&&terminalHasCalaiAuthority(db,session.terminalId,state.id):calaiAllowed,principalKind:terminal(session)?'terminal':'human'};
}
function selectAccount(db,userId,id,now){db.prepare('INSERT INTO business_account_preferences(user_id,business_id,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET business_id=excluded.business_id,updated_at=excluded.updated_at').run(userId,id,now);}
function revokeSourceTerminals(db,businessId,now){
  if(!tableExists(db,'business_terminals'))return;
  if(tableExists(db,'business_terminal_grants'))db.prepare('UPDATE business_terminal_grants SET revoked_at=COALESCE(revoked_at,?) WHERE terminal_id IN(SELECT id FROM business_terminals WHERE business_id=?)').run(now,businessId);
  db.prepare('UPDATE business_terminals SET revoked_at=COALESCE(revoked_at,?) WHERE business_id=?').run(now,businessId);
}
function mergeEmptyProductWorkspace(db,{sourceId,targetId,userId,now,config}){
  if(sourceId===targetId)return;
  const sourceLinks=links(db,sourceId),targetLinks=links(db,targetId);
  if(sourceLinks.some(source=>targetLinks.some(target=>target.product===source.product)))throw fail(409,'BUSINESS_PRODUCT_CONFLICT','Both accounts already have this product. No records were changed.');
  const sourceReferences=db.prepare('SELECT * FROM business_native_references WHERE business_id=?').all(sourceId),targetReferences=db.prepare('SELECT * FROM business_native_references WHERE business_id=?').all(targetId);if(sourceReferences.some(source=>targetReferences.some(target=>target.product===source.product&&target.source_account_id!==source.source_account_id)))throw fail(409,'BUSINESS_PRODUCT_CONFLICT','The registered native account references conflict. Ask the administrator to review the locations.');
  revokeSourceTerminals(db,sourceId,now);
  for(const product of sourceLinks.map(row=>row.product)){const prior=db.prepare('SELECT * FROM business_product_permissions WHERE business_id=? AND product=?').get(sourceId,product),target=db.prepare('SELECT * FROM business_product_permissions WHERE business_id=? AND product=?').get(targetId,product);if(target?.changed_by&&target.allowed===0&&prior?.allowed===1)throw fail(403,'ADMIN_CONNECTION_PERMISSION_REQUIRED','The administrator disabled this product for the destination location.');if(prior&&(!target||!target.changed_by))db.prepare('INSERT INTO business_product_permissions VALUES(?,?,?,?,?) ON CONFLICT(business_id,product) DO UPDATE SET allowed=excluded.allowed,changed_by=excluded.changed_by,changed_at=excluded.changed_at').run(targetId,product,prior.allowed,prior.changed_by,now);}
  for(const row of sourceLinks.filter(row=>row.product==='calai'&&row.encrypted_credentials)){const credentials=decryptCalaiBusinessCredentials(config,row);db.prepare('UPDATE business_product_links SET encrypted_credentials=? WHERE id=?').run(encryptCalaiBusinessCredentials(config,{...row,business_id:targetId},credentials),row.id);}
  const principalColumn=db.prepare('PRAGMA table_info(users)').all().some(row=>row.name==='principal_kind');
  const members=db.prepare(`SELECT m.* FROM business_account_memberships m JOIN users u ON u.id=m.user_id WHERE m.business_id=?${principalColumn?" AND u.principal_kind='human'":''}`).all(sourceId);
  for(const member of members){const previous=db.prepare('SELECT permission FROM business_account_memberships WHERE business_id=? AND user_id=?').get(targetId,member.user_id);db.prepare('INSERT INTO business_account_memberships(business_id,user_id,permission,created_at,membership_source,can_view_calai) VALUES(?,?,?,?,?,?) ON CONFLICT(business_id,user_id) DO UPDATE SET permission=excluded.permission').run(targetId,member.user_id,previous?.permission==='owner'||member.permission==='owner'?'owner':'staff',now,member.membership_source,member.can_view_calai);}
  db.prepare('UPDATE business_product_links SET business_id=?,updated_at=? WHERE business_id=?').run(targetId,now,sourceId);
  db.prepare('UPDATE business_native_references SET business_id=? WHERE business_id=?').run(targetId,sourceId);
  db.prepare('UPDATE business_source_identities SET business_id=?,updated_at=? WHERE business_id=?').run(targetId,now,sourceId);
  db.prepare('INSERT OR IGNORE INTO business_product_authorities(business_id,product,user_id,source_user_id,source_account_id,verified_at) SELECT ?,product,user_id,source_user_id,source_account_id,verified_at FROM business_product_authorities WHERE business_id=?').run(targetId,sourceId);
  db.prepare('DELETE FROM business_product_authorities WHERE business_id=?').run(sourceId);
  db.prepare('UPDATE business_product_permissions SET allowed=0,changed_by=?,changed_at=? WHERE business_id=?').run(userId,now,sourceId);
  db.prepare('UPDATE business_account_preferences SET business_id=?,updated_at=? WHERE business_id=?').run(targetId,now,sourceId);
  db.prepare('UPDATE business_account_aliases SET business_id=? WHERE business_id=?').run(targetId,sourceId);
  db.prepare('INSERT INTO business_account_aliases(old_id,business_id,linked_by,created_at) VALUES(?,?,?,?)').run(sourceId,targetId,userId,now);
  db.prepare('UPDATE business_accounts SET archived_at=?,updated_at=? WHERE id=?').run(now,now,sourceId);
  db.prepare('UPDATE business_accounts SET updated_at=? WHERE id=?').run(now,targetId);
  audit(db,userId,targetId,'business_accounts_linked',{sourceBusinessId:sourceId,products:sourceLinks.map(row=>row.product),sourceTabletsRevoked:true},now);
}
function saveCalaiLink(db,config,{businessId,userId,proof,confirmMergeBusinessId=null,activate=true}){
  const now=stamp(config),existing=db.prepare("SELECT * FROM business_product_links WHERE product='calai' AND source_account_id=?").get(proof.person.businessId),target=db.prepare("SELECT * FROM business_product_links WHERE business_id=? AND product='calai'").get(businessId);
  if(target&&target.source_account_id!==proof.person.businessId)throw fail(409,'BUSINESS_PRODUCT_CONFLICT','This business already has a different Calai account. Nothing was replaced.');
  const reference=db.prepare("SELECT source_account_id FROM business_native_references WHERE business_id=? AND product='calai'").get(businessId);if(reference&&reference.source_account_id!==proof.person.businessId)throw fail(409,'BUSINESS_PRODUCT_CONFLICT','This location has a different Calai native account reference.');
  if(existing&&existing.upstream_user_id!==proof.person.id)throw fail(403,'CALAI_BUSINESS_CHANGED','The Calai owner changed. An administrator must review the existing link.');
  const priorReference=db.prepare("SELECT business_id FROM business_native_references WHERE product='calai' AND source_account_id=?").get(proof.person.businessId),priorBusiness=existing?.business_id??priorReference?.business_id;
  if(priorBusiness&&priorBusiness!==businessId){
    requireConnectionAllowed(db,priorBusiness,'calai');
    if(confirmMergeBusinessId!==priorBusiness)return{mergeRequired:{businessId:priorBusiness,name:rawAccount(db,priorBusiness)?.name??'Existing Calai business',targetBusinessId:businessId,targetName:rawAccount(db,businessId)?.name??'Business account'}};
    const existingEats=links(db,priorBusiness).find(row=>row.product==='cal-eats');
    if(existingEats){const owner=membership(db,userId,priorBusiness);if(owner?.permission!=='owner'||owner.productOnly)throw fail(403,'OWNER_REQUIRED','Approve the existing Cal-Eats owner account before linking these business accounts.');}
    mergeEmptyProductWorkspace(db,{sourceId:priorBusiness,targetId:businessId,userId,now,config});
  }
  const row={id:target?.id??existing?.id??randomUUID(),business_id:businessId,provider_origin:CALAI_BUSINESS_ORIGIN,upstream_user_id:proof.person.id,source_account_id:proof.person.businessId},encrypted=encryptCalaiBusinessCredentials(config,row,proof.tokens);
  if(existing||target)db.prepare('UPDATE business_product_links SET business_id=?,status=?,upstream_user_id=?,upstream_email=?,encrypted_credentials=?,credential_expires_at=?,credential_checked_at=?,last_error_code=NULL,updated_at=? WHERE id=?').run(businessId,activate?'active':'inactive',proof.person.id,proof.person.email,encrypted,proof.authExpiresAt,now,now,row.id);
  else db.prepare("INSERT INTO business_product_links(id,business_id,product,source_account_id,status,provider_origin,upstream_user_id,upstream_email,encrypted_credentials,credential_expires_at,credential_checked_at,created_at,updated_at) VALUES(?,?,'calai',?,?,?,?,?,?,?,?,?,?)").run(row.id,businessId,proof.person.businessId,activate?'active':'inactive',CALAI_BUSINESS_ORIGIN,proof.person.id,proof.person.email,encrypted,proof.authExpiresAt,now,now,now);
  // Login verifies ownership, not native service status. Preserve any separately
  // observed directory status and its timestamp instead of replacing it with a
  // synthetic 'verified' service state during connection/re-authentication.
  db.prepare("INSERT INTO business_native_references(business_id,product,source_account_id,name,native_status,verified_at) VALUES(?,'calai',?,?,NULL,?) ON CONFLICT(business_id,product) DO UPDATE SET name=excluded.name").run(businessId,proof.person.businessId,proof.business.name,now);
  db.prepare("INSERT INTO business_account_memberships(business_id,user_id,permission,created_at,membership_source,can_view_calai) VALUES(?,?,'owner',?,'master',1) ON CONFLICT(business_id,user_id) DO UPDATE SET permission='owner',membership_source='master',can_view_calai=1").run(businessId,userId,now);
  db.prepare("INSERT INTO business_product_authorities(business_id,product,user_id,source_user_id,source_account_id,verified_at) VALUES(?,'calai',?,?,?,?) ON CONFLICT(business_id,product,user_id) DO UPDATE SET source_user_id=excluded.source_user_id,source_account_id=excluded.source_account_id,verified_at=excluded.verified_at").run(businessId,userId,proof.person.id,proof.person.businessId,now);
  db.prepare('UPDATE business_accounts SET updated_at=? WHERE id=?').run(now,businessId);
  audit(db,userId,businessId,'calai_business_linked',{sourceBusinessId:proof.person.businessId,sourceUserId:proof.person.id,authExpiresAt:proof.authExpiresAt},now);
  return{state:businessAccountState(db,businessId)};
}
function currentLink(db,row){const current=db.prepare('SELECT p.* FROM business_product_links p JOIN business_accounts a ON a.id=p.business_id WHERE p.id=? AND p.status=\'active\' AND a.archived_at IS NULL').get(row.id);if(!businessProductPermission(db,row.business_id,'calai')||!current||current.business_id!==row.business_id||current.upstream_user_id!==row.upstream_user_id||current.source_account_id!==row.source_account_id||current.encrypted_credentials!==row.encrypted_credentials)throw fail(403,'BUSINESS_LINK_CHANGED','The business connection changed. Refresh this page.');return current;}
export async function readCalaiBusinessResource(db,config,businessId,section,{id=null,detail=null}={}){
  calaiBusinessReadPath(section,id,detail);
  return withCalaiBusinessRead(db,config,businessId,(adapter,accessToken)=>adapter.read(section,accessToken,{id,detail}));
}

async function withCalaiBusinessRead(db,config,businessId,read){
  const row=db.prepare("SELECT * FROM business_product_links WHERE business_id=? AND product='calai' AND status='active'").get(businessId);if(!row)throw fail(403,'PRODUCT_INACTIVE','Calai is not active for this business.');
  currentLink(db,row);
  try{
    if(!row.encrypted_credentials||Date.parse(row.credential_expires_at)<=config.now().getTime())throw fail(403,'CALAI_RECONNECT_REQUIRED','An owner must reconnect Calai. Cal-Eats remains available.');
    const adapter=calaiBusinessAdapter(config),credentials=decryptCalaiBusinessCredentials(config,row),accessToken=await adapter.refresh(credentials.refreshToken);calaiTokenMetadata(credentials.refreshToken,row.upstream_user_id,config);calaiTokenMetadata(accessToken,row.upstream_user_id,config);
    const expected={userId:row.upstream_user_id,businessId:row.source_account_id};assertCalaiBusinessIdentity(await adapter.identity(accessToken),expected);currentLink(db,row);
    const data=await read(adapter,accessToken,row);assertCalaiBusinessIdentity(await adapter.identity(accessToken),expected);currentLink(db,row);
    db.prepare('UPDATE business_product_links SET credential_checked_at=?,last_error_code=NULL WHERE id=? AND encrypted_credentials=?').run(stamp(config),row.id,row.encrypted_credentials);
    return redactCalaiBusinessData(data);
  }catch(error){const code=['CALAI_UNAVAILABLE','CALAI_BUSINESS_NOT_CONFIGURED'].includes(error.code)?error.code:'CALAI_RECONNECT_REQUIRED';db.prepare('UPDATE business_product_links SET last_error_code=? WHERE id=? AND encrypted_credentials=?').run(code,row.id,row.encrypted_credentials);throw error;}
}
function canReadCalaiLiveCalls(business) {
  return business.canViewCalai && business.products.calai.active &&
    business.canViewEats && business.products['cal-eats'].active &&
    (business.principalKind !== 'terminal' || business.tabletConfiguration?.selection === 'both');
}

async function readCalaiDashboard(db, config, business) {
  if (!canReadCalaiLiveCalls(business)) {
    return { orders: await readCalaiBusinessResource(db, config, business.id, 'orders'), liveCalls: null };
  }
  let live, dashboard;
  try {
    dashboard = await withCalaiBusinessRead(db, config, business.id, async (adapter, accessToken, link) => {
      live = readCalaiLiveCalls(db, config, link, adapter, accessToken);
      const orders = await adapter.read('orders', accessToken, { id: null, detail: null });
      return { orders, liveCalls: await live.result };
    });
    return dashboard;
  } finally {
    live?.finish?.(dashboard?.liveCalls, Boolean(dashboard));
  }
}

function assertCurrentBusinessRead(db, session, config) {
  if (!terminal(session)) return currentHumanSession(db, session, config);
  if (!db.prepare(`SELECT 1 FROM business_terminals t JOIN business_terminal_grants g ON g.terminal_id=t.id
    WHERE t.id=? AND t.business_id=? AND t.revoked_at IS NULL AND g.token_hash=? AND g.revoked_at IS NULL AND g.expires_at>?`)
    .get(session.terminalId, session.businessId, session.terminalGrantHash, stamp(config))) {
    throw fail(401, 'TERMINAL_SESSION_EXPIRED', 'Reconnect the registered restaurant tablet.');
  }
}

async function calaiBusinessActivity(db, session, config) {
  const denied = () => fail(403, 'CALAI_AUTHORITY_REQUIRED', 'Calai alerts require authorised access to both services.');
  const business = selectedContext(db, session, config);
  if (!canReadCalaiLiveCalls(business)) throw denied();
  let live, orders, activity;
  try {
    activity = await withCalaiBusinessRead(db, config, business.id, async (adapter, accessToken, link) => {
      live = readCalaiLiveCalls(db, config, link, adapter, accessToken);
      orders = readCalaiPhoneOrderActivity(db, config, link, adapter, accessToken);
      const [calls, phoneOrders] = await Promise.all([live.result, orders.result]);
      return { calls, phoneOrders };
    });
  } catch {
    // Calai activity is optional. A native source outage must not interrupt
    // a signed tablet's ability to keep receiving its Cal-Eats orders.
  } finally {
    live?.finish?.(activity?.calls, Boolean(activity));
    orders?.finish?.(activity?.phoneOrders, Boolean(activity));
  }
  assertCurrentBusinessRead(db, session, config);
  const fresh = selectedContext(db, session, config);
  if (!canReadCalaiLiveCalls(fresh) || fresh.id !== business.id || fresh.eatsRestaurantId !== business.eatsRestaurantId ||
      fresh.products.calai.sourceAccountId !== business.products.calai.sourceAccountId ||
      fresh.products.calai.verifiedSourceUserId !== business.products.calai.verifiedSourceUserId) throw denied();
  const calls = freshCalaiLiveCalls(activity?.calls, config.now().getTime(), 20_000);
  return { businessId: fresh.id, calls: calls && { generatedAt: calls.generatedAt, events: calls.events }, phoneOrders: activity?.phoneOrders ?? null };
}

const londonOrderDay = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'});
const dateKey=value=>londonOrderDay.format(new Date(value));
function minor(value){if(value===null||value===undefined||value==='')return null;const number=Number(value);return Number.isFinite(number)&&number>=0&&number<=1e9?Math.round(number*100):null;}
function sourceOrder(row){const confirmation=row.confirmationStatus,status=confirmation===true||confirmation==='confirmed'?'confirmed':confirmation===false||confirmation==='unconfirmed'?'unconfirmed':'received';return{id:'calai:'+row.id,sourceOrderId:row.id,source:'calai',sourceLabel:'Calai telephone',createdAt:row.createdAt,customerName:String(row.customerName??'Customer').slice(0,160),status,fulfilment:['delivery','collection','takeaway'].includes(row.orderType)?row.orderType:'unknown',totalMinor:minor(row.totalPrice),currency:'GBP',requiresAcceptance:false,canProcess:false};}
const waitingEatsOrder = `(o.status='placed' AND o.confirmed_at IS NULL AND o.merchant_visible_at IS NOT NULL AND ${PAYABLE_ORDER_SQL})`;
const visibleEatsOrder = `(${waitingEatsOrder} OR o.status IN ('accepted','preparing','ready','out_for_delivery','completed')
  OR (o.status='rejected' AND o.merchant_visible_at IS NOT NULL))`;
const newestOrder = (a,b) => Date.parse(b.createdAt)-Date.parse(a.createdAt) || a.id.localeCompare(b.id);

function dailyCalaiOrders(data, today) {
  if (!Array.isArray(data) || data.some(row => !isSourceId(row?.id) || !Number.isFinite(Date.parse(row.createdAt)))) {
    throw fail(502, 'CALAI_RESPONSE_INVALID', 'Calai order data could not be read.');
  }
  const unique = new Map();
  for (const row of data) {
    if (dateKey(row.createdAt) !== today) continue;
    const id = row.id.toLowerCase(), previous = unique.get(id);
    if (!previous || Date.parse(row.createdAt) > Date.parse(previous.createdAt)) unique.set(id, row);
  }
  return [...unique.values()].sort(newestOrder);
}

export async function unifiedBusinessDashboard(db,session,config){
  const business=selectedContext(db,session,config),today=dateKey(config.now()),orders=[],connections={},counts={calai:{today:0,available:!business.products.calai.active},'cal-eats':{today:0,available:!business.products['cal-eats'].active}};
  let calaiLiveCalls = null;
  if(business.products.calai.active){
    if(!business.canViewCalai){counts.calai={today:null,available:false};connections.calai={status:'owner_required',message:'An owner must authorise Calai access.'};}
    else try{
      const dashboard = await readCalaiDashboard(db, config, business);
      calaiLiveCalls = dashboard.liveCalls;
      const current = dailyCalaiOrders(dashboard.orders, today);
      counts.calai = { today: current.length, available: true };
      orders.push(...current.slice(0,100).map(sourceOrder));
      connections.calai = { status: 'connected', checkedAt: stamp(config) };
    }
    catch(error){counts.calai={today:null,available:false};connections.calai={status:error.status===503?'unavailable':'reconnect_required',code:error.code??'CALAI_UNAVAILABLE',message:error.status===503?'Calai is temporarily unavailable.':'An owner must reconnect Calai.'};}
  }
  assertCurrentBusinessRead(db, session, config);
  const fresh=selectedContext(db,session,config);if(fresh.id!==business.id)throw fail(409,'BUSINESS_CONTEXT_CHANGED','The selected account changed. Refresh its dashboard.');
  const canShowCalai=fresh.canViewCalai&&fresh.products.calai.active&&fresh.products.calai.sourceAccountId===business.products.calai.sourceAccountId&&fresh.products.calai.verifiedSourceUserId===business.products.calai.verifiedSourceUserId;
  if(!canShowCalai){counts.calai={today:null,available:false};connections.calai={status:fresh.products.calai.adminAllowed?'permission_required':'disabled_by_admin'};}

  if(fresh.products['cal-eats'].linked&&fresh.eatsRestaurantId&&fresh.canViewEats){
    const range=parseLondonDateRange(new URL(`http://local.invalid/?from=${today}&to=${today}`));
    const where=`o.restaurant_id=? AND o.created_at>=? AND o.created_at<? AND ${visibleEatsOrder}`;
    const parameters=[fresh.eatsRestaurantId,range.from,range.toExclusive];
    const current=db.prepare(`SELECT o.id,o.created_at,o.status,o.fulfillment,o.total_minor,o.currency,u.name customer_name
      FROM orders o LEFT JOIN users u ON u.id=o.customer_id WHERE ${where} ORDER BY o.created_at DESC,o.id DESC LIMIT 100`).all(...parameters);
    const count=db.prepare(`SELECT COUNT(*) n FROM orders o WHERE ${where}`).get(...parameters).n;
    counts['cal-eats']={today:count,available:true};
    orders.push(...current.map(row=>({id:'cal-eats:'+row.id,sourceOrderId:row.id,source:'cal-eats',sourceLabel:'Cal Eats online',
      createdAt:row.created_at,customerName:row.customer_name??'Customer',status:row.status,fulfilment:row.fulfillment,
      totalMinor:row.total_minor,currency:row.currency,requiresAcceptance:row.status==='placed',canProcess:false})));
    connections['cal-eats']={status:'connected',checkedAt:stamp(config)};
  }else if(!fresh.canViewEats||fresh.products['cal-eats'].active){
    counts['cal-eats']={today:null,available:false};connections['cal-eats']={status:'permission_required'};
  }

  const visible=orders.filter(row=>row.source!=='calai'||canShowCalai).sort(newestOrder).slice(0,150)
    .map(row=>fresh.products[row.source].financialAccess?row:{...row,totalMinor:null});
  const complete=Object.entries(fresh.products).every(([product,state])=>!state.active||counts[product].available);
  const canShowLive = canShowCalai && canReadCalaiLiveCalls(fresh) && fresh.eatsRestaurantId === business.eatsRestaurantId;
  const liveCalls = canShowLive ? calaiLiveCallSummary(calaiLiveCalls, config.now().getTime()) : null;
  const eatsLiveOrders = canReadCalaiLiveCalls(fresh) && fresh.eatsRestaurantId && counts['cal-eats'].available
    ? liveRestaurantOrderCounts(db, fresh.eatsRestaurantId) : null;
  return{business:fresh,calaiLiveCalls:liveCalls,eatsLiveOrders,counts:{...counts,total:{today:complete?Object.values(counts).reduce((sum,row)=>sum+(row.today??0),0):null,complete}},orders:visible,connections,generatedAt:stamp(config),timeZone:'Europe/London',counterPeriod:'today',counterDefinition:'Orders received today in London. Cal-Eats counts orders released to the restaurant, including completed and closed orders.'};
}
function requireConnectionAllowed(db,businessId,product){if(!businessProductPermission(db,businessId,product))throw fail(403,'ADMIN_CONNECTION_PERMISSION_REQUIRED','The platform administrator must allow this product connection first.');}
function currentHumanSession(db,session,config){const user=human(db,session);if(session.sessionId){const table=session.nativeAudience==='platform-admin'?'native_platform_sessions':session.nativeAudience==='business'?'native_business_sessions':'sessions';if(!db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?`).get(session.sessionId,user.id,stamp(config)))throw fail(401,'AUTH_REQUIRED','Sign in again to confirm this account connection.');}return user;}
function proofEnvelope(row){return{id:'connection-proof:'+row.product+':'+row.token_hash,business_id:row.business_id,provider_origin:CALAI_BUSINESS_ORIGIN,upstream_user_id:row.source_user_id,source_account_id:row.source_account_id};}
function storeConnectionProof(db,config,session,businessId,product,proof){const token=randomBytes(32).toString('base64url'),row={token_hash:createHash('sha256').update(token).digest('hex'),business_id:businessId,product,source_user_id:proof.person.id,source_account_id:proof.person.businessId},now=stamp(config),expiresAt=new Date(config.now().getTime()+300000).toISOString(),encrypted=encryptCalaiBusinessCredentials(config,proofEnvelope(row),proof);db.prepare('DELETE FROM business_connection_proofs WHERE expires_at<=?').run(now);db.prepare('INSERT INTO business_connection_proofs VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)').run(row.token_hash,businessId,product,session.user.id,session.sessionId??'module-session',row.source_user_id,row.source_account_id,proof.business.name,encrypted,now,expiresAt);const prior=db.prepare('SELECT business_id FROM business_product_links WHERE product=? AND source_account_id=? UNION SELECT business_id FROM business_native_references WHERE product=? AND source_account_id=? LIMIT 1').get(product,row.source_account_id,product,row.source_account_id);return{connectionToken:token,sourceAccount:{id:row.source_account_id,name:proof.business.name},businessId,expiresAt,...(prior&&prior.business_id!==businessId?{mergeRequired:{businessId:prior.business_id,name:rawAccount(db,prior.business_id)?.name??proof.business.name}}:{})};}
function connectionProof(db,config,session,businessId,product,body){if(typeof body.connectionToken!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(body.connectionToken)||body.confirmLocation!==true)throw fail(400,'BRANCH_CONFIRMATION_REQUIRED','Verify and explicitly confirm the correct restaurant and branch.');const row=db.prepare('SELECT * FROM business_connection_proofs WHERE token_hash=? AND business_id=? AND product=? AND user_id=? AND session_id=? AND expires_at>?').get(createHash('sha256').update(body.connectionToken).digest('hex'),businessId,product,session.user.id,session.sessionId??'module-session',stamp(config));if(!row)throw fail(409,'CONNECTION_PROOF_EXPIRED','Verify the account again before connecting it.');const expected=product==='calai'?body.expectedBusinessId:body.restaurantId;if(expected!==row.source_account_id)throw fail(403,'BUSINESS_ACCOUNT_MISMATCH','The confirmed account does not match the verified restaurant and branch.');return{row,proof:decryptCalaiBusinessCredentials(config,{...proofEnvelope(row),encrypted_credentials:row.encrypted_proof})};}
function saveAuthority(db,businessId,product,userId,sourceUserId,sourceAccountId,now){db.prepare('INSERT INTO business_product_authorities VALUES(?,?,?,?,?,?) ON CONFLICT(business_id,product,user_id) DO UPDATE SET source_user_id=excluded.source_user_id,source_account_id=excluded.source_account_id,verified_at=excluded.verified_at').run(businessId,product,userId,sourceUserId,sourceAccountId,now);}
async function calaiHumanLogin({req,res,db,config,checkRate}){
  if(terminal(req.session)||req.headers['x-cal-eats-terminal-session'])throw fail(403,'HUMAN_LOGIN_REQUIRED','An owner must sign in for this action.');
  const body=await readJson(req,config.bodyLimit);exactObject(body,['email','password']);const email=text(body.email,'Email',254),password=passwordText(body.password);checkRate?.(req,'calai-business:'+email.toLowerCase());
  const proof=await authenticateCalaiBusiness(config,email,password),now=stamp(config);
  const result=withTransaction(db,()=>{
    let identity=db.prepare('SELECT * FROM business_source_identities WHERE provider_origin=? AND source_user_id=?').get(CALAI_BUSINESS_ORIGIN,proof.person.id),product=db.prepare("SELECT * FROM business_product_links WHERE product='calai' AND source_account_id=?").get(proof.person.businessId),userId,businessId;
    const reference=db.prepare("SELECT business_id FROM business_native_references WHERE product='calai' AND source_account_id=?").get(proof.person.businessId),registeredBusiness=identity?.business_id??product?.business_id??reference?.business_id;
    if(!registeredBusiness)throw fail(403,'ADMIN_CONNECTION_PERMISSION_REQUIRED','The platform administrator must authorise this Calai location before it can connect. Native Calai remains available.');
    requireConnectionAllowed(db,canonicalBusinessId(db,registeredBusiness),'calai');
    if(identity){
      if(identity.source_business_id!==proof.person.businessId)throw fail(403,'CALAI_BUSINESS_CHANGED','The Calai business changed. An administrator must review the existing link.');
      userId=identity.user_id;businessId=canonicalBusinessId(db,identity.business_id);const existingUser=db.prepare('SELECT role,account_enabled FROM users WHERE id=?').get(userId);if(existingUser?.role!=='restaurant'||!existingUser.account_enabled)throw fail(403,'ACCOUNT_DISABLED','This business account is disabled.');
      const membershipRow=membership(db,userId,businessId);if(membershipRow?.permission!=='owner')throw fail(403,'OWNER_REQUIRED','The business owner access has changed.');
    }else{
      if(product&&product.upstream_user_id!==proof.person.id)throw fail(403,'CALAI_BUSINESS_CHANGED','The Calai owner changed. An administrator must review the existing link.');
      const existingOwner=db.prepare('SELECT 1 FROM business_source_identities WHERE provider_origin=? AND source_business_id=?').get(CALAI_BUSINESS_ORIGIN,proof.person.businessId);if(existingOwner)throw fail(403,'CALAI_BUSINESS_CHANGED','This Calai business already has an owner mapping.');
      userId=randomUUID();businessId=canonicalBusinessId(db,registeredBusiness);const identityEmail='calai-'+createHash('sha256').update(proof.person.id).digest('hex')+'@identity.cal-eats.invalid';
      db.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at,email_verified_at) VALUES(?,?,?,?,\'restaurant\',?,?)').run(userId,proof.person.name,identityEmail,'!calai-external-only:'+randomBytes(32).toString('base64url'),now,now);
      ensureBusinessProductPermissions(db,businessId,now);
      db.prepare("INSERT INTO business_account_memberships(business_id,user_id,permission,created_at) VALUES(?,?,'owner',?)").run(businessId,userId,now);
      db.prepare('INSERT INTO business_source_identities(provider_origin,source_user_id,source_business_id,user_id,business_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(CALAI_BUSINESS_ORIGIN,proof.person.id,proof.person.businessId,userId,businessId,now,now);
    }
    const saved=saveCalaiLink(db,config,{businessId,userId,proof,activate:product?product.status==='active':true});if(saved.mergeRequired)throw fail(409,'BUSINESS_LINK_CHANGED','The business account link changed.');selectAccount(db,userId,businessId,now);
    const created=createSession(db,userId,config),user=db.prepare('SELECT id,name,email,role FROM users WHERE id=?').get(userId);audit(db,userId,businessId,'calai_business_sign_in',{sourceUserId:proof.person.id},now);return{created,user,business:businessAccountState(db,businessId)};
  });
  return sendJson(res,200,{data:{user:result.user,business:result.business}}, {...noStore,'Set-Cookie':cookieFor(result.created.token,result.created.expires,config.now(),config.secureCookies)});
}
function adminBusinessAccountState(db,id,config){const value=businessAccountState(db,id,{config});value.products['cal-eats'].financialAccess=Boolean(value.eatsRestaurantId);return value;}
export async function routeUnifiedBusiness({req,res,url,db,config,session,checkRate}){
  if(url.pathname.startsWith('/api/admin/business/accounts')){
    const administrator=currentHumanSession(db,session,config);if(administrator.role!=='admin')throw fail(403,'FORBIDDEN','Platform administrator access is required.');
    for(const row of db.prepare('SELECT id FROM restaurants WHERE archived_at IS NULL').all())ensureBusinessForRestaurant(db,row.id,config);
    if(req.method==='POST'&&url.pathname==='/api/admin/business/accounts/sync-calai'){exactObject(await readJson(req,config.bodyLimit),[]);const tenants=await readCalaiBusinessDirectory(db,config,session),now=stamp(config);const imported=withTransaction(db,()=>{if(currentHumanSession(db,session,config).role!=='admin')throw fail(403,'FORBIDDEN','Platform administrator access is required.');for(const native of tenants){const existing=db.prepare("SELECT business_id FROM business_native_references WHERE product='calai' AND source_account_id=?").get(native.id),id=existing?.business_id??randomUUID();if(!existing){db.prepare('INSERT INTO business_accounts(id,name,created_at,updated_at) VALUES(?,?,?,?)').run(id,native.name,now,now);ensureBusinessProductPermissions(db,id,now);}db.prepare("INSERT INTO business_native_references VALUES(?,'calai',?,?,?,?) ON CONFLICT(business_id,product) DO UPDATE SET name=excluded.name,native_status=excluded.native_status,verified_at=excluded.verified_at").run(id,native.id,native.name,native.status,now);}audit(db,administrator.id,'directory','calai_business_directory_synchronised',{count:tenants.length,nativeCalaiUnchanged:true},now);return tenants.length;});return sendJson(res,200,{data:{imported,nativeCalaiUnchanged:true}},noStore);}
    if(req.method==='GET'&&url.pathname==='/api/admin/business/accounts'){const restaurantId=url.searchParams.get('restaurantId'),product=url.searchParams.get('product');if(product&&!['calai','cal-eats','both'].includes(product))throw fail(400,'VALIDATION_ERROR','Product filter is invalid.');let rows=db.prepare('SELECT id FROM business_accounts WHERE archived_at IS NULL ORDER BY name,id').all().map(row=>adminBusinessAccountState(db,row.id,config));if(restaurantId)rows=rows.filter(row=>row.eatsRestaurantId===restaurantId);if(product)rows=rows.filter(row=>product==='both'?row.products.calai.linked&&row.products['cal-eats'].linked:row.products[product].linked);return sendJson(res,200,{data:rows},noStore);}
    let adminMatch=/^\/api\/admin\/business\/accounts\/([^/]+)(?:\/products\/(calai|cal-eats))?$/.exec(url.pathname);
    if(adminMatch){const id=canonicalBusinessId(db,adminMatch[1]);if(!rawAccount(db,id))throw unavailable();if(req.method==='GET'&&!adminMatch[2])return sendJson(res,200,{data:adminBusinessAccountState(db,id,config)},noStore);
      if(req.method==='PATCH'&&adminMatch[2]){const body=await readJson(req,config.bodyLimit);exactObject(body,['allowed']);if(typeof body.allowed!=='boolean')throw fail(400,'VALIDATION_ERROR','Administrator permission must be true or false.');const now=stamp(config);withTransaction(db,()=>{if(currentHumanSession(db,session,config).role!=='admin')throw fail(403,'FORBIDDEN','Platform administrator access is required.');ensureBusinessProductPermissions(db,id,now);const before=businessProductPermission(db,id,adminMatch[2]);db.prepare('UPDATE business_product_permissions SET allowed=?,changed_by=?,changed_at=? WHERE business_id=? AND product=?').run(Number(body.allowed),administrator.id,now,id,adminMatch[2]);audit(db,administrator.id,id,'business_product_permission_changed',{product:adminMatch[2],previous:before,current:body.allowed,nativeCalaiUnchanged:true},now);});return sendJson(res,200,{data:adminBusinessAccountState(db,id,config)},noStore);}
    }
    throw unavailable();
  }
  if(!url.pathname.startsWith('/api/business/'))return false;
  if(req.method==='POST'&&url.pathname==='/api/business/auth/calai/login')return calaiHumanLogin({req,res,db,config,checkRate});
  const user=actor(db,session);let match;
  if(req.method==='GET'&&url.pathname==='/api/business/context'){
    const data=selectedContext(db,session,config);
    if(!session.nativeAudience&&data.principalKind==='human'&&managedTabletAwaitingBrowser(db,config,data.id))data.managedTabletAwaitingConnection=true;
    return sendJson(res,200,{data},noStore);
  }
  if(req.method==='GET'&&url.pathname==='/api/business/accounts')return sendJson(res,200,{data:terminal(session)?[selectedContext(db,session,config)]:accountIds(db,user).map(id=>({...businessAccountState(db,id),canManageProducts:access(db,session,id).canManageProducts}))},noStore);
  if(req.method==='GET'&&url.pathname==='/api/business/dashboard')return sendJson(res,200,{data:await unifiedBusinessDashboard(db,session,config)},noStore);
  // The installed tablet companion already permits the scoped Calai orders
  // read. Alert clients receive opaque observations, never native order data.
  if(req.method==='GET'&&url.pathname==='/api/business/calai/orders'&&url.search==='?scope=activity'){
    return sendJson(res,200,{data:await calaiBusinessActivity(db,session,config)},noStore);
  }
  if(req.method==='POST'&&url.pathname==='/api/business/accounts'){
    if(human(db,session).role!=='admin')throw fail(403,'ADMIN_REQUIRED','The platform administrator must create or authorise this location.');const body=await readJson(req,config.bodyLimit);exactObject(body,['name']);const name=text(body.name,'Business name'),id=randomUUID(),now=stamp(config);
    withTransaction(db,()=>{db.prepare('INSERT INTO business_accounts(id,name,created_at,updated_at) VALUES(?,?,?,?)').run(id,name,now,now);ensureBusinessProductPermissions(db,id,now);db.prepare("INSERT INTO business_account_memberships(business_id,user_id,permission,created_at) VALUES(?,?,'owner',?)").run(id,user.id,now);selectAccount(db,user.id,id,now);audit(db,user.id,id,'business_account_created',{},now);});return sendJson(res,201,{data:businessAccountState(db,id,{config})},noStore);
  }
  if((match=/^\/api\/business\/accounts\/([^/]+)\/select$/.exec(url.pathname))&&req.method==='POST'){
    human(db,session);const allowed=access(db,session,match[1]);const body=await readJson(req,config.bodyLimit);exactObject(body,[]);selectAccount(db,user.id,allowed.businessId,stamp(config));return sendJson(res,200,{data:selectedContext(db,session,config)},noStore);
  }
  if((match=/^\/api\/business\/accounts\/([^/]+)\/(calai|cal-eats)\/prepare-link$/.exec(url.pathname))&&req.method==='POST'){
    const current=currentHumanSession(db,session,config),allowed=access(db,session,match[1],{owner:true}),product=match[2],body=await readJson(req,config.bodyLimit);requireConnectionAllowed(db,allowed.businessId,product);exactObject(body,['email','password','restaurantId']);const email=text(body.email,'Email',254).toLowerCase(),password=passwordText(body.password);checkRate?.(req,'business-connection:'+email);let proof;
    if(product==='calai')proof=await authenticateCalaiBusiness(config,email,password);
    else{const native=db.prepare("SELECT * FROM users WHERE email=? AND role='restaurant' AND account_enabled=1 AND principal_kind='human'").get(email);if(!native||!await verifyPassword(password,native.password_hash))throw fail(401,'INVALID_CREDENTIALS','Email or password is incorrect.');const accounts=db.prepare("SELECT r.id,r.name FROM restaurants r JOIN restaurant_memberships m ON m.restaurant_id=r.id WHERE m.user_id=? AND m.permission='owner' AND r.archived_at IS NULL ORDER BY r.name,r.id").all(native.id);if(accounts.length>1&&!body.restaurantId)return sendJson(res,200,{data:{selectionRequired:true,sourceAccounts:accounts}},noStore);const source=accounts.find(row=>!body.restaurantId||row.id===body.restaurantId);if(!source)throw unavailable();proof={person:{id:native.id,businessId:source.id},business:{name:source.name},passwordVersion:createHash('sha256').update(native.password_hash).digest('hex')};}
    const result=withTransaction(db,()=>{currentHumanSession(db,session,config);access(db,session,allowed.businessId,{owner:true});requireConnectionAllowed(db,allowed.businessId,product);return storeConnectionProof(db,config,session,allowed.businessId,product,proof);});return sendJson(res,200,{data:result},noStore);
  }
  if((match=/^\/api\/business\/accounts\/([^/]+)\/calai\/link$/.exec(url.pathname))&&req.method==='POST'){
    currentHumanSession(db,session,config);const allowed=access(db,session,match[1],{owner:true}),body=await readJson(req,config.bodyLimit);exactObject(body,['connectionToken','expectedBusinessId','confirmLocation','confirmMergeBusinessId']);requireConnectionAllowed(db,allowed.businessId,'calai');const {row,proof}=connectionProof(db,config,session,allowed.businessId,'calai',body);
    const adapter=calaiBusinessAdapter(config),token=await adapter.refresh(proof.tokens.refreshToken);calaiTokenMetadata(token,proof.person.id,config);assertCalaiBusinessIdentity(await adapter.identity(token),{userId:proof.person.id,businessId:proof.person.businessId});
    const saved=withTransaction(db,()=>{currentHumanSession(db,session,config);access(db,session,allowed.businessId,{owner:true});requireConnectionAllowed(db,allowed.businessId,'calai');const freshProof=connectionProof(db,config,session,allowed.businessId,'calai',body);if(freshProof.row.consumed_at){const existing=links(db,allowed.businessId).find(link=>link.product==='calai');if(existing?.source_account_id!==row.source_account_id)throw fail(409,'CONNECTION_PROOF_USED','This confirmation was already used.');return{state:businessAccountState(db,allowed.businessId,{config})};}const result=saveCalaiLink(db,config,{businessId:allowed.businessId,userId:user.id,proof,confirmMergeBusinessId:body.confirmMergeBusinessId??null});if(!result.mergeRequired)db.prepare('UPDATE business_connection_proofs SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL').run(stamp(config),row.token_hash);return result;});
    if(saved.mergeRequired)return sendJson(res,409,{error:{code:'BUSINESS_MERGE_CONFIRMATION_REQUIRED',message:'Review and confirm linking these existing business accounts.'},mergeRequired:saved.mergeRequired},noStore);
    return sendJson(res,200,{data:saved.state},noStore);
  }
  if((match=/^\/api\/business\/accounts\/([^/]+)\/cal-eats\/link$/.exec(url.pathname))&&req.method==='POST'){
    currentHumanSession(db,session,config);const allowed=access(db,session,match[1],{owner:true}),body=await readJson(req,config.bodyLimit);exactObject(body,['connectionToken','restaurantId','confirmLocation','confirmMergeBusinessId']);requireConnectionAllowed(db,allowed.businessId,'cal-eats');const {row,proof}=connectionProof(db,config,session,allowed.businessId,'cal-eats',body),native=db.prepare("SELECT * FROM users WHERE id=? AND account_enabled=1 AND role='restaurant' AND principal_kind='human'").get(row.source_user_id),owned=native&&db.prepare("SELECT 1 FROM restaurant_memberships WHERE restaurant_id=? AND user_id=? AND permission='owner'").get(row.source_account_id,native.id);if(!owned||createHash('sha256').update(native.password_hash).digest('hex')!==proof.passwordVersion)throw fail(403,'NATIVE_ACCOUNT_CHANGED','Sign in to the Cal-Eats account again.');
    const source=ensureBusinessForRestaurant(db,row.source_account_id,config);if(source.id!==allowed.businessId&&body.confirmMergeBusinessId!==source.id)return sendJson(res,409,{error:{code:'BUSINESS_MERGE_CONFIRMATION_REQUIRED',message:'Confirm the two independent accounts and their correct location.'},mergeRequired:{businessId:source.id,name:source.name,targetBusinessId:allowed.businessId,targetName:rawAccount(db,allowed.businessId).name}},noStore);
    const result=withTransaction(db,()=>{currentHumanSession(db,session,config);access(db,session,allowed.businessId,{owner:true});requireConnectionAllowed(db,allowed.businessId,'cal-eats');connectionProof(db,config,session,allowed.businessId,'cal-eats',body);const fresh=db.prepare("SELECT password_hash FROM users WHERE id=? AND account_enabled=1 AND role='restaurant' AND principal_kind='human'").get(native.id);if(!fresh||createHash('sha256').update(fresh.password_hash).digest('hex')!==proof.passwordVersion||!db.prepare("SELECT 1 FROM restaurant_memberships WHERE user_id=? AND restaurant_id=? AND permission='owner'").get(native.id,row.source_account_id))throw fail(403,'NATIVE_ACCOUNT_CHANGED','Verify the Cal-Eats account again.');requireConnectionAllowed(db,source.id,'cal-eats');if(source.id!==allowed.businessId)mergeEmptyProductWorkspace(db,{sourceId:allowed.businessId,targetId:source.id,userId:user.id,now:stamp(config),config});const calai=links(db,source.id).find(link=>link.product==='calai'),sourceAuthority=db.prepare("SELECT 1 FROM business_product_authorities WHERE business_id=? AND product='calai' AND user_id=?").get(source.id,user.id);if(calai&&sourceAuthority)saveAuthority(db,source.id,'calai',native.id,calai.upstream_user_id,calai.source_account_id,stamp(config));saveAuthority(db,source.id,'cal-eats',native.id,native.id,row.source_account_id,stamp(config));selectAccount(db,native.id,source.id,stamp(config));db.prepare('UPDATE business_connection_proofs SET consumed_at=COALESCE(consumed_at,?) WHERE token_hash=?').run(stamp(config),row.token_hash);return{created:createSession(db,native.id,config),state:businessAccountState(db,source.id,{config})};});return sendJson(res,200,{data:{...result.state,sessionChanged:true}}, {...noStore,'Set-Cookie':cookieFor(result.created.token,result.created.expires,config.now(),config.secureCookies)});
  }
  if((match=/^\/api\/business\/accounts\/([^/]+)\/products\/(calai|cal-eats)$/.exec(url.pathname))&&req.method==='PATCH'){
    throw fail(403,'ADMIN_SERVICE_CONTROL_REQUIRED','Use platform administration to change connection permission or service enablement.');

  }
  if((match=/^\/api\/business\/accounts\/([^/]+)\/calai\/disconnect$/.exec(url.pathname))&&req.method==='POST'){
    throw fail(403,'ADMIN_SERVICE_CONTROL_REQUIRED','Business users cannot disconnect product accounts.');

  }
  if((match=/^\/api\/business\/calai\/([a-z-]+)(?:\/([^/]+))?(?:\/([a-z-]+))?$/.exec(url.pathname))&&req.method==='GET'){
    if(url.search)throw fail(400,'CALAI_QUERY_NOT_ALLOWED','This Calai view does not accept query parameters.');const business=businessAccountForSession(db,session,config);access(db,session,business.id,{calai:true});
    if(terminal(session)&&!['orders','hours'].includes(match[1]))throw fail(403,'OWNER_REQUIRED','An owner must sign in for this Calai feature.');
    const data=await readCalaiBusinessResource(db,config,business.id,match[1],{id:match[2]??null,detail:match[3]??null});access(db,session,business.id,{calai:true});return sendJson(res,200,{data,meta:{source:'calai',businessId:business.id,readOnly:true,generatedAt:stamp(config)}},noStore);
  }
  if(url.pathname.startsWith('/api/business/calai/'))throw fail(403,'CALAI_SOURCE_CAPABILITY_REQUIRED','This Calai action requires an additional source capability. Existing Calai data was not changed.');
  return false;
}
