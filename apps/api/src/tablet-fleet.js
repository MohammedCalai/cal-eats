import {randomUUID} from 'node:crypto';
import {HttpError,exactObject,readJson,sendJson} from './http.js';
import {withTransaction} from './db/index.js';
import {hasLiveBankingCredential} from './auth/password-change.js';
import {enforcePlatformAdminAuthority} from './platform-admin.js';
import {businessAccountState,canonicalBusinessId} from './unified-business.js';
import {getSurfaceStatus} from './surface-monitoring.js';
import {retireBusinessTerminal,issueBusinessTerminalSetup} from './business-terminals.js';
import {buildTerminalInstaller} from '../../terminal-auth/windows/build-installer.mjs';
import {tabletManagementState,queueTabletManagementRefresh} from './tablet-management.js';
import {assertFleetNewEnrolmentAllowed,canOfferOwnerCalaiSetup} from './tablet-fleet-policy.js';
import {readTabletDirectory} from './tablet-directory.js';
import {queueTabletManagedSetup, tabletManagedSetupState, tabletManagedTarget} from './tablet-managed-setup.js';
import {tabletApplicationConfiguration,hasNativeCalaiSetupAuthority} from './tablet-product-policy.js';
import {assertTabletSelectionReady,assertTabletSelectionDoesNotStrandWork,assertTabletSelectionActivation} from './tablet-assignment-safety.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=(status,code,message)=>new HttpError(status,code,message);
const noStore={'Cache-Control':'private, no-store'};
const mappingFields={intuneManagedDeviceId:'intune_managed_device_id',entraDeviceId:'entra_device_id',startupGroupId:'startup_group_id',startupProfileId:'startup_profile_id'};
const deliveryLimitation='Startup configuration is recorded as requested only. No supported Intune delivery or trusted Windows acknowledgement is connected.';
const handoffLimitation='Previous browser/native sessions cannot be selectively cleared by this inventory. Existing printer tenant credentials and queued receipts are also preserved, and need an authorised cleanup/rebinding procedure before cross-restaurant use. Keep the tablet quarantined until the complete physical handoff is verified. No handoff-completion capability is connected.';
function currentAdmin(db,config,session){
 if(!session?.user?.id)throw fail(401,'AUTH_REQUIRED','Sign in to system administration.');
 if(session.principalKind==='terminal'||session.nativeAudience==='business')throw fail(403,'PLATFORM_ADMIN_REQUIRED','System administrator access is required.');
 const user=db.prepare("SELECT * FROM users WHERE id=? AND role='admin' AND account_enabled=1 AND principal_kind='human'").get(session.user.id);
 if(!user||session.user.role!=='admin')throw fail(403,'PLATFORM_ADMIN_REQUIRED','Current system administrator access is required.');
 const table=session.nativeAudience==='platform-admin'?'native_platform_sessions':'sessions';
 if(!session.sessionId||!db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?`).get(session.sessionId,user.id,config.now().toISOString()))throw fail(401,'AUTH_REQUIRED','Sign in again to manage tablets.');
 if(session.platformFederated){const proof=db.prepare("SELECT 1 FROM platform_admin_sessions WHERE session_id=? AND user_id=? AND revoked_at IS NULL AND encrypted_tokens IS NOT NULL AND absolute_expires_at>?").get(session.sessionId,user.id,config.now().toISOString());if(!proof)throw fail(401,'PLATFORM_RECONNECT_REQUIRED','Reconnect the authorised system administrator account.');}
 if(!hasLiveBankingCredential(db,user.id))throw fail(403,'ADMIN_PASSWORD_SECURITY_REQUIRED','Secure your system administrator password before managing the tablet fleet.');
 return user;
}
function name(value,label,max=100){if(typeof value!=='string'||value.trim().length<2||value.trim().length>max||/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value))throw fail(400,'VALIDATION_ERROR',`${label} is invalid.`);return value.trim();}
function optionalId(value,label){if(value===undefined||value===null||value==='')return null;if(typeof value!=='string'||!uuid.test(value))throw fail(400,'VALIDATION_ERROR',`${label} must be a valid identifier.`);return value.toLowerCase();}
function serial(value){if(value===undefined||value===null||value==='')return null;if(typeof value!=='string'||! /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,119}$/.test(value.trim()))throw fail(400,'VALIDATION_ERROR','Recorded serial number is invalid.');return value.trim();}
function startup(value){if(value===undefined||value===null||value==='')return null;if(!['calai','cal-eats'].includes(value))throw fail(400,'VALIDATION_ERROR','Choose Calai-first or Cal-Eats-first.');return value;}
function location(db,value){const id=optionalId(value,'Business/location');if(id&&!db.prepare('SELECT 1 FROM business_accounts WHERE id=? AND archived_at IS NULL').get(id))throw fail(404,'BUSINESS_NOT_FOUND','The business/location is unavailable.');return id;}
function rowFor(db,id){if(!uuid.test(id))throw fail(404,'TABLET_NOT_FOUND','Tablet record not found.');const row=db.prepare('SELECT * FROM admin_tablets WHERE id=?').get(id);if(!row)throw fail(404,'TABLET_NOT_FOUND','Tablet record not found.');return row;}
function revision(body,row){if(row.archived_at)throw fail(409,'TABLET_RECORD_SUPERSEDED','This inventory placeholder was superseded. Open its current inventory record.');if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<1)throw fail(400,'VALIDATION_ERROR','A current tablet record revision is required.');if(row.revision!==body.expectedRevision)throw fail(409,'TABLET_REVISION_CHANGED','This tablet changed. Reload its current record before retrying.');}
function page(url,defaultSize=20){const integer=(key,fallback,max)=>{const value=url.searchParams.get(key);if(value===null)return fallback;if(!/^[1-9]\d*$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)>max)throw fail(400,'VALIDATION_ERROR','Tablet pagination is invalid.');return Number(value);};return{page:integer('page',1,1000000),pageSize:integer('pageSize',defaultSize,100)};}
function search(url){const q=(url.searchParams.get('q')||'').trim();if(q.length>120||/[\u0000-\u001f\u007f]/.test(q))throw fail(400,'VALIDATION_ERROR','Tablet search is invalid.');return q;}
const like=q=>'%'+q.replace(/[\\%_]/g,value=>'\\'+value)+'%';
const mapping=row=>Object.fromEntries(Object.entries(mappingFields).map(([key,column])=>[key,row[column]??null]));
const snapshot=row=>({id:row.id,displayName:row.display_name,serialNumber:row.serial_number,businessId:row.business_id,requestedBusinessId:row.requested_business_id,terminalId:row.terminal_id,applicationProducts:row.application_products??null,requestedStartupProduct:row.requested_startup_product,lifecycleState:row.lifecycle_state,revision:row.revision,identitySource:row.inventory_source,supersededBy:row.superseded_by,archivedAt:row.archived_at,mapping:mapping(row)});

function applicationMode(value){if(!['calai','cal-eats','both'].includes(value))throw fail(400,'VALIDATION_ERROR','Choose Calai, Cal-Eats or both.');return value;}
const selectedProducts=mode=>mode==='both'?['calai','cal-eats']:[mode];
function validateApplicationMode(db,config,businessId,mode){
 assertTabletSelectionReady(db,config,businessId,mode);return businessAccountState(db,businessId,{config});
}
function ensureNoStrandedOrders(db,businessId,mode){
 assertTabletSelectionDoesNotStrandWork(db,businessId,mode);
}
function invalidateTabletPresence(db,row){
 if(!row.terminal_id)return;
 db.prepare('UPDATE business_terminals SET last_screen_at=NULL WHERE id=?').run(row.terminal_id);
 // Requests re-evaluate device policy server-side; keep a valid grant so the
 // existing companion can receive its new scope without a manual reconnect.
 db.prepare('DELETE FROM surface_application_presence WHERE terminal_id=?').run(row.terminal_id);
}
function applicationAccess(db,row,business){
 const modes=['calai','cal-eats','both'].map(value=>({value,available:Boolean(business&&selectedProducts(value).every(product=>business.products?.[product]?.active&&business.products?.[product]?.readiness?.ready))}));
 return{selection:row.application_products??null,choices:modes,paired:Boolean(row.terminal_id&&db.prepare('SELECT 1 FROM business_terminals WHERE id=? AND revoked_at IS NULL').get(row.terminal_id)),configuration:tabletApplicationConfiguration(db,row.terminal_id,row.business_id),scope:'protected_cal_eats_application',windowsStartupChanged:false,nativeCalaiChanged:false};
}
function audit(db,actor,id,action,before,after,at,reason=null){db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)').run(randomUUID(),actor,'tablet_fleet',id,action,JSON.stringify({product:'cal-eats-integration',previous:before? snapshot(before):null,current:after?snapshot(after):null,reason,windowsConfigurationChanged:false,calaiUnchanged:true}),at);}
function requestConfiguration(db,row,userId,at){
 db.prepare("UPDATE tablet_configuration_requests SET state='cancelled' WHERE tablet_id=? AND state='requested'").run(row.id);
 db.prepare("INSERT INTO tablet_configuration_requests(id,tablet_id,record_revision,business_id,startup_product,mapping_snapshot,requested_by,requested_at,state) VALUES(?,?,?,?,?,?,?,?,'requested')").run(randomUUID(),row.id,row.revision,row.handoff_requested_at?row.requested_business_id:row.business_id,row.requested_startup_product,JSON.stringify(mapping(row)),userId,at);
}
function revokeRegistration(db,row,actor,at){
 if(!row.terminal_id)return;
 const terminal=db.prepare('SELECT * FROM business_terminals WHERE id=?').get(row.terminal_id);
 if(!terminal||canonicalBusinessId(db,terminal.business_id)!==canonicalBusinessId(db,row.business_id))throw fail(409,'TABLET_REGISTRATION_CHANGED','The recorded terminal association changed. Inspect it before changing tablet access.');
 retireBusinessTerminal(db,terminal,actor,at);
 db.prepare('UPDATE business_terminal_pairings SET consumed_at=COALESCE(consumed_at,?) WHERE business_id=? AND consumed_at IS NULL').run(at,terminal.business_id);
 db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)').run(randomUUID(),actor,'business_terminal',terminal.business_id,'terminal_revoked',JSON.stringify({terminalId:terminal.id,source:'central_tablet_fleet',tabletId:row.id}),at);
}
function setupCapability(db,row,business,actorId=null){
 const current=row.business_id&&db.prepare('SELECT id FROM business_terminals WHERE business_id=? AND revoked_at IS NULL').get(row.business_id);
 let reason=null;
 if(row.archived_at||row.authority_blocked_at||row.handoff_requested_at||['disabled','pending_handoff'].includes(row.lifecycle_state))reason='Tablet setup is blocked while this device is disabled or awaiting verified physical cleanup.';
 else if(!row.business_id||!business||business.archived)reason='Associate this inventory record with its current native business first.';
 else if(!business.eatsRestaurantId&&(!business.products.calai.active||!business.products.calai.readiness.ready||!hasNativeCalaiSetupAuthority(db,actorId,row.business_id)))reason='Verify and connect the exact native Calai account as the current setup administrator before pairing this Calai-only tablet. No Cal-Eats restaurant is required.';
 else if(business.id!==row.business_id)reason='Reconcile the inventory with its canonical native business before issuing setup.';
 if(!reason){try{assertFleetNewEnrolmentAllowed(db,row.business_id);}catch(error){if(error.code!=='TABLET_QUARANTINED')throw error;reason='A tablet for this location is quarantined pending complete physical session and printer-tenant cleanup.';}}
 const combinedReason=reason||(!row.serial_number?'The tablet’s exact serial is required for its single-file setup.':current?.id||row.terminal_id?'Use the reviewed replacement flow for an existing application registration.':null);
 const ownerFirstSetup=Boolean(!current&&business&&business.id===row.business_id&&!business.archived&&!business.eatsRestaurantId&&canOfferOwnerCalaiSetup(row));
 return{canIssueSetup:!reason,setupBlockReason:reason,currentTerminalId:current?.id??null,canDownloadPairedSetup:!combinedReason,pairedSetupBlockReason:combinedReason,ownerFirstSetup};
}
function latestEnrolment(db,config,row){
 const record=db.prepare('SELECT f.*,p.consumed_at,t.revoked_at,t.id AS paired_id FROM tablet_fleet_pairing_requests f JOIN business_terminal_pairings p ON p.terminal_id=f.terminal_id LEFT JOIN business_terminals t ON t.id=f.terminal_id WHERE f.tablet_id=? ORDER BY f.issued_at DESC,f.rowid DESC LIMIT 1').get(row.id);if(!record)return null;
 const paired=Boolean(record.paired_id&&row.terminal_id===record.terminal_id&&!record.revoked_at),status=paired?'paired':record.consumed_at||row.revision!==record.record_revision||row.archived_at||row.authority_blocked_at?'superseded':Date.parse(record.expires_at)<=config.now().getTime()?'expired':'issued';
 return{terminalId:record.terminal_id,issuedAt:record.issued_at,expiresAt:record.expires_at,consumedAt:record.consumed_at,status};
}
function dto(db,config,row,{history=false,actorId=null}={}){
 const state=id=>{if(!id)return null;try{return businessAccountState(db,id,{config});}catch(error){if(error.status!==404)throw error;const account=db.prepare('SELECT name FROM business_accounts WHERE id=?').get(id);return{id,name:account?.name??'Unavailable business',archived:true,products:{},eatsRestaurantId:null};}};
 const business=state(row.business_id),requestedBusiness=state(row.requested_business_id);
 const terminal=row.terminal_id?db.prepare('SELECT id,name,business_id,registered_at,revoked_at,last_contact_at FROM business_terminals WHERE id=?').get(row.terminal_id):null;
 let application=null;
 if(business?.eatsRestaurantId&&terminal&&!terminal.revoked_at&&terminal.business_id===row.business_id){const observed=getSurfaceStatus(db,config,business.eatsRestaurantId);if(observed.tablet.terminalId===terminal.id)application=observed;}
 const request=db.prepare('SELECT * FROM tablet_configuration_requests WHERE tablet_id=? ORDER BY record_revision DESC LIMIT 1').get(row.id);
 const management=tabletManagementState(db,config,row),actions={...setupCapability(db,row,business,actorId),canRefreshManagement:management.refreshReady&&!row.archived_at,managementBlockReason:row.archived_at?'This inventory record was superseded.':management.refreshBlockReason};
 const result={...snapshot(row),business,requestedBusiness,mapping:{...mapping(row),source:'administrator_metadata',provesHardwareIdentity:false},management:{state:'unavailable',lastContactAt:null,source:null},registration:terminal?{terminalId:terminal.id,name:terminal.name,businessId:terminal.business_id,registered:!terminal.revoked_at,registeredAt:terminal.registered_at,revokedAt:terminal.revoked_at,lastContactAt:terminal.last_contact_at}:null,application,startup:{state:request?.state??'not_requested',requestedAt:request?.requested_at??null,assignedAt:request?.assigned_at??null,offeredAt:request?.offered_at??null,receivedAt:request?.received_at??null,appliedAt:request?.applied_at??null,physicallyVerifiedAt:request?.physically_verified_at??null,appliedProduct:null,deliveryLimitation},handoff:{state:row.handoff_requested_at?'pending_physical_cleanup':'not_requested',requestedAt:row.handoff_requested_at,completionSupported:false,limitation:row.handoff_requested_at?((terminal?.revoked_at?'The linked Cal-Eats application terminal authority was revoked. ':'No linked Cal-Eats application identity can be revoked from this metadata record. ')+handoffLimitation):null},createdAt:row.created_at,updatedAt:row.updated_at};
 result.management=management;result.actions=actions;result.latestEnrolment=latestEnrolment(db,config,row);result.applicationAccess=applicationAccess(db,row,business);result.managedSetup=tabletManagedSetupState(db,config,row);
 if(history)result.history=db.prepare("SELECT id,actor_user_id AS actorUserId,action,details,created_at AS createdAt FROM audit_events WHERE entity_type='tablet_fleet' AND entity_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50").all(row.id).map(event=>({...event,details:JSON.parse(event.details)}));
 return result;
}
function ensureUnique(error){if(/UNIQUE constraint failed: admin_tablets\.(?:serial_number|terminal_id|intune_managed_device_id|entra_device_id)/.test(String(error?.message)))throw fail(409,'TABLET_METADATA_CONFLICT','This recorded serial, management identifier or application registration already belongs to a fleet record.');throw error;}
async function mutationBody({req,res,url,db,config,session},fields,before){if(session.native)throw fail(403,'FLEET_WEB_ADMIN_REQUIRED','Use the authorised system-administration website for device changes. The phone app remains view-only.');const body=await readJson(req,config.bodyLimit);exactObject(body,fields);await enforcePlatformAdminAuthority({req,res,url,db,config,session});const fresh=currentAdmin(db,config,session);if(fresh.password_hash!==before.password_hash)throw fail(409,'ADMIN_CREDENTIALS_CHANGED','Administrator credentials changed. Sign in again.');return body;}

export async function routeTabletFleet(context){
 const {req,res,url,db,config,session}=context;
 if(!url.pathname.startsWith('/api/admin/tablets'))return false;
 const admin=currentAdmin(db,config,session),base='/api/admin/tablets';
 if(req.method==='GET'&&url.pathname===base+'/directory'){
  const paging=page(url),q=search(url).toLocaleLowerCase('en-GB'),directory=await(context.directoryReader??readTabletDirectory)(config);currentAdmin(db,config,session);
  const inventory=db.prepare('SELECT t.*,a.name business_name FROM admin_tablets t LEFT JOIN business_accounts a ON a.id=t.business_id WHERE t.archived_at IS NULL AND t.intune_managed_device_id IS NOT NULL').all(),byId=new Map(inventory.map(row=>[row.intune_managed_device_id,row]));
  const matches=directory.items.map(device=>{const row=byId.get(device.intuneManagedDeviceId);return{...device,managedSetupAvailable:Boolean(tabletManagedTarget(config,device)),fleetRecord:row?{...snapshot(row),businessName:row.business_name??null,applicationRegistered:Boolean(row.terminal_id&&db.prepare('SELECT 1 FROM business_terminals WHERE id=? AND revoked_at IS NULL').get(row.terminal_id)),configuration:tabletApplicationConfiguration(db,row.terminal_id,row.business_id),managedSetup:tabletManagedSetupState(db,config,row)}:null};}).filter(device=>!q||[device.displayName,device.serialNumber,device.model,device.fleetRecord?.displayName,device.fleetRecord?.businessName].some(value=>typeof value==='string'&&value.toLocaleLowerCase('en-GB').includes(q)));
  return sendJson(res,200,{data:{items:matches.slice((paging.page-1)*paging.pageSize,paging.page*paging.pageSize),pagination:{...paging,total:matches.length,totalPages:Math.max(1,Math.ceil(matches.length/paging.pageSize))},complete:directory.complete,truncated:directory.truncated,collectedAt:directory.collectedAt,source:'microsoft_graph'}},noStore);
 }
 const directorySelection=/^\/api\/admin\/tablets\/directory\/([0-9a-f-]{36})$/.exec(url.pathname);
 if(directorySelection&&req.method==='POST'){
  const body=await mutationBody(context,['displayName','businessId','applicationProducts'],admin),managedId=optionalId(directorySelection[1],'Microsoft tablet');
  const directory=await(context.directoryReader??readTabletDirectory)(config),device=directory.items.find(item=>item.intuneManagedDeviceId===managedId);if(!device)throw fail(404,'TABLET_DIRECTORY_DEVICE_UNAVAILABLE','This Windows tablet was not returned by the current Microsoft directory. Refresh the list.');
  let outcome;try{outcome=withTransaction(db,()=>{
   const actor=currentAdmin(db,config,session);if(actor.password_hash!==admin.password_hash)throw fail(409,'ADMIN_CREDENTIALS_CHANGED','Administrator credentials changed. Sign in again.');
   const at=config.now().toISOString(),businessId=location(db,body.businessId),mode=applicationMode(body.applicationProducts);if(!businessId)throw fail(400,'BUSINESS_REQUIRED','Choose the tablet’s restaurant or location.');validateApplicationMode(db,config,businessId,mode);
   if(db.prepare('SELECT 1 FROM admin_tablets WHERE intune_managed_device_id=?').get(managedId))throw fail(409,'TABLET_METADATA_CONFLICT','This Microsoft tablet already has a saved record. Open it to change its assignment.');
   const id=randomUUID();db.prepare("INSERT INTO admin_tablets(id,display_name,serial_number,business_id,intune_managed_device_id,entra_device_id,lifecycle_state,created_by,created_at,updated_at,application_products) VALUES(?,?,?,?,?,?,'assigned',?,?,?,?)").run(id,name(body.displayName??device.displayName,'Tablet name'),serial(device.serialNumber),businessId,managedId,optionalId(device.entraDeviceId,'Microsoft device'),actor.id,at,at,mode);
   const after=rowFor(db,id),managed=queueTabletManagedSetup(db,config,after,actor.id);
   audit(db,actor.id,id,'tablet_directory_assigned',null,after,at,managed?'Managed first connection requested.':'Assigned from the Microsoft directory. Device pairing and Windows startup are unchanged.');return after;
  });}catch(error){ensureUnique(error);}
  return sendJson(res,201,{data:dto(db,config,outcome,{history:true,actorId:admin.id})},noStore);
 }
 const configuration=/^\/api\/admin\/tablets\/([0-9a-f-]{36})\/configuration$/.exec(url.pathname);
 if(configuration&&req.method==='POST'){
  const body=await mutationBody(context,['expectedRevision','displayName','businessId','applicationProducts'],admin);
  const outcome=withTransaction(db,()=>{
   const actor=currentAdmin(db,config,session),before=rowFor(db,configuration[1]);revision(body,before);
   if(before.authority_blocked_at||before.handoff_requested_at||before.lifecycle_state==='disabled')throw fail(409,'TABLET_HANDOFF_PENDING','This tablet is disabled or awaiting a safe physical handoff. Its application access cannot be enabled here.');
   const at=config.now().toISOString(),businessId=location(db,body.businessId),mode=applicationMode(body.applicationProducts);if(!businessId)throw fail(400,'BUSINESS_REQUIRED','Choose a restaurant or location.');
   if(before.business_id&&businessId!==before.business_id)throw fail(409,'TABLET_REASSIGNMENT_REQUIRED','Use the safe reassignment action when moving a tablet to another business.');
   if(before.terminal_id){const terminal=db.prepare('SELECT business_id,revoked_at FROM business_terminals WHERE id=?').get(before.terminal_id);if(!terminal||terminal.business_id!==businessId||terminal.revoked_at)throw fail(409,'TABLET_REGISTRATION_CHANGED','The existing tablet registration must be reviewed before changing its application access.');}
   validateApplicationMode(db,config,businessId,mode);if(mode!==before.application_products)ensureNoStrandedOrders(db,businessId,mode);
   const changed=db.prepare("UPDATE admin_tablets SET display_name=?,business_id=?,application_products=?,lifecycle_state='assigned',revision=revision+1,updated_at=? WHERE id=? AND revision=?").run(name(body.displayName,'Tablet name'),businessId,mode,at,before.id,before.revision);if(changed.changes!==1)throw fail(409,'TABLET_REVISION_CHANGED','This tablet changed. Reload its record.');
   if(mode!==before.application_products)invalidateTabletPresence(db,before);
   const after=rowFor(db,before.id);queueTabletManagedSetup(db,config,after,actor.id);
   audit(db,actor.id,before.id,'tablet_application_access_updated',before,after,at,'Device-scoped application access; current native rights and protected pairing still apply. Windows startup and native Calai are unchanged.');return after;
  });
  return sendJson(res,200,{data:dto(db,config,outcome,{history:true,actorId:admin.id})},noStore);
 }
 if(req.method==='GET'&&url.pathname===base+'/locations'){
  const paging=page(url,25),q=search(url),where=q?"WHERE a.archived_at IS NULL AND(a.name LIKE ? ESCAPE '\\' OR a.id=?)":'WHERE a.archived_at IS NULL',args=q?[like(q),q]:[];
  const total=db.prepare(`SELECT COUNT(*) n FROM business_accounts a ${where}`).get(...args).n;
  const rows=db.prepare(`SELECT a.id FROM business_accounts a ${where} ORDER BY a.name COLLATE NOCASE,a.id LIMIT ? OFFSET ?`).all(...args,paging.pageSize,(paging.page-1)*paging.pageSize);
  const items=rows.map(({id})=>{const state=businessAccountState(db,id,{config}),restaurant=state.eatsRestaurantId&&db.prepare('SELECT address FROM restaurants WHERE id=?').get(state.eatsRestaurantId);return{id,name:state.name,locationLabel:restaurant?.address||null,products:state.products};});
  return sendJson(res,200,{data:{items,pagination:{...paging,total,totalPages:Math.max(1,Math.ceil(total/paging.pageSize))}}},noStore);
 }
 if(req.method==='GET'&&url.pathname===base){
  const paging=page(url),q=search(url),state=url.searchParams.get('status')||'all',businessId=url.searchParams.has('businessId')?location(db,url.searchParams.get('businessId')):null;
  if(!['all','active','assigned','unassigned','disabled','pending_handoff'].includes(state))throw fail(400,'VALIDATION_ERROR','Tablet status filter is invalid.');
  const clauses=['t.archived_at IS NULL'],args=[];
  if(q){clauses.push("(t.display_name LIKE ? ESCAPE '\\' OR t.serial_number LIKE ? ESCAPE '\\' OR a.name LIKE ? ESCAPE '\\' OR t.id=?)");args.push(like(q),like(q),like(q),q);}
  if(state!=='all'){clauses.push('t.lifecycle_state=?');args.push(state==='active'?'assigned':state);}
  if(businessId){clauses.push('(t.business_id=? OR t.requested_business_id=?)');args.push(businessId,businessId);}
  const where=clauses.length?'WHERE '+clauses.join(' AND '):'',from='FROM admin_tablets t LEFT JOIN business_accounts a ON a.id=t.business_id';
  const total=db.prepare(`SELECT COUNT(*) n ${from} ${where}`).get(...args).n;
  const rows=db.prepare(`SELECT t.* ${from} ${where} ORDER BY t.display_name COLLATE NOCASE,t.id LIMIT ? OFFSET ?`).all(...args,paging.pageSize,(paging.page-1)*paging.pageSize);
  return sendJson(res,200,{data:{items:rows.map(row=>dto(db,config,row,{actorId:admin.id})),pagination:{...paging,total,totalPages:Math.max(1,Math.ceil(total/paging.pageSize))},capabilities:{deviceConfigurationDelivery:false,physicalHandoffCompletion:false},limitation:deliveryLimitation}},noStore);
 }
 if(req.method==='POST'&&url.pathname===base){
  const body=await mutationBody(context,['displayName','serialNumber','businessId','requestedStartupProduct',...Object.keys(mappingFields),'terminalId'],admin);
  let outcome;try{outcome=withTransaction(db,()=>{
   const actor=currentAdmin(db,config,session),at=config.now().toISOString(),id=randomUUID(),businessId=location(db,body.businessId),terminalId=optionalId(body.terminalId,'Application terminal'),product=startup(body.requestedStartupProduct);
   if(terminalId){const terminal=db.prepare('SELECT business_id FROM business_terminals WHERE id=?').get(terminalId);if(!terminal||!businessId||terminal.business_id!==businessId)throw fail(409,'TABLET_REGISTRATION_MISMATCH','Confirm the exact existing registration and its current native business. Metadata cannot transfer application authority.');}
   const mapped=Object.entries(mappingFields).map(([key])=>optionalId(body[key],key));
   const revoked=terminalId&&db.prepare('SELECT revoked_at FROM business_terminals WHERE id=?').get(terminalId)?.revoked_at;
   db.prepare('INSERT INTO admin_tablets(id,display_name,serial_number,business_id,terminal_id,requested_startup_product,intune_managed_device_id,entra_device_id,startup_group_id,startup_profile_id,lifecycle_state,created_by,created_at,updated_at,disabled_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,name(body.displayName,'Display name'),serial(body.serialNumber),businessId,terminalId,product,...mapped,revoked?'disabled':businessId?'assigned':'unassigned',actor.id,at,at,revoked||null);
   const row=rowFor(db,id);if(product||mapped.some(Boolean))requestConfiguration(db,row,actor.id,at);audit(db,actor.id,id,'tablet_inventory_created',null,row,at);return row;
  });}catch(error){ensureUnique(error);}
  return sendJson(res,201,{data:dto(db,config,outcome,{history:true,actorId:admin.id})},noStore);
 }
 const pairedPackage=/^\/api\/admin\/tablets\/([0-9a-f-]{36})\/setup-package$/.exec(url.pathname);
 if(pairedPackage&&req.method==='POST'){
  const body=await mutationBody(context,['expectedRevision','confirmReplaceTerminalId'],admin);context.checkRate?.(req,'tablet-package:'+pairedPackage[1]);
  const bytes=withTransaction(db,()=>{
   const actor=currentAdmin(db,config,session),row=rowFor(db,pairedPackage[1]);revision(body,row);const at=config.now().toISOString(),business=row.business_id?businessAccountState(db,row.business_id,{config}):null,capability=setupCapability(db,row,business,actor.id);
   if(!capability.canDownloadPairedSetup)throw fail(409,'TABLET_PAIRED_SETUP_NOT_READY',capability.pairedSetupBlockReason);
   if(!Object.hasOwn(body,'confirmReplaceTerminalId')||body.confirmReplaceTerminalId!==null)throw fail(409,'TABLET_REPLACEMENT_CONFIRMATION_REQUIRED','Single-file setup is for a first connection. Review existing registration replacement separately.');
   assertTabletSelectionActivation(db,config,row.business_id,row.application_products);
   const enrolment=issueBusinessTerminalSetup(db,config,session,row.business_id,{expectedTerminalId:null});
   db.prepare('INSERT INTO tablet_fleet_pairing_requests VALUES(?,?,?,?,?,?,?)').run(enrolment.terminalId,row.id,row.revision,row.business_id,actor.id,at,enrolment.expiresAt);
   const content=Buffer.from((context.installerBuilder??buildTerminalInstaller)({targetSerial:row.serial_number,enrolment,deviceName:row.display_name.slice(0,80)}),'utf8');
   audit(db,actor.id,row.id,'tablet_paired_package_issued',row,row,at,'Private first-connection package; expiry and signed physical pairing still apply.');return content;
  });
  res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="CalEats-Tablet-Setup.ps1"','Content-Length':bytes.length,...noStore});res.end(bytes);return true;
 }
 const operation=/^\/api\/admin\/tablets\/([0-9a-f-]{36})\/(enrolment|installer|management\/refresh)$/.exec(url.pathname);
 if(operation&&operation[2]==='installer'&&req.method==='GET'){
  if(session.native)throw fail(403,'FLEET_WEB_ADMIN_REQUIRED','Use system-administration website for tablet installation.');
  const row=rowFor(db,operation[1]),business=row.business_id?businessAccountState(db,row.business_id,{config}):null,capability=setupCapability(db,row,business,admin.id);if(!capability.canIssueSetup)throw fail(409,'TABLET_SETUP_NOT_READY',capability.setupBlockReason);
  const bytes=Buffer.from(buildTerminalInstaller({targetSerial:row.serial_number??''}),'utf8');currentAdmin(db,config,session);
  res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="CalEats-Tablet-Setup.ps1"','Content-Length':bytes.length,...noStore});res.end(bytes);return true;
 }
 if(operation&&req.method==='POST'&&operation[2]!=='installer'){
  const isSetup=operation[2]==='enrolment',body=await mutationBody(context,isSetup?['expectedRevision','confirmReplaceTerminalId']:['expectedRevision'],admin);
  const outcome=withTransaction(db,()=>{
   const actor=currentAdmin(db,config,session),row=rowFor(db,operation[1]);revision(body,row);const at=config.now().toISOString();
   if(!isSetup){const job=queueTabletManagementRefresh(db,config,row,actor.id);audit(db,actor.id,row.id,'tablet_management_refresh_requested',row,row,at);return{job};}
   const business=row.business_id?businessAccountState(db,row.business_id,{config}):null,capability=setupCapability(db,row,business,admin.id);
   if(!capability.canIssueSetup)throw fail(409,'TABLET_SETUP_NOT_READY',capability.setupBlockReason);
   if(!Object.hasOwn(body,'confirmReplaceTerminalId'))throw fail(400,'TABLET_REPLACEMENT_CONFIRMATION_REQUIRED','Confirm the exact current registration, or null when no terminal is registered.');
   const expected=optionalId(body.confirmReplaceTerminalId,'Current terminal');
   if(expected!==capability.currentTerminalId)throw fail(409,'TABLET_REPLACEMENT_CONFIRMATION_REQUIRED','The registered tablet changed. Reload and confirm its exact identity.');
   const enrolment=issueBusinessTerminalSetup(db,config,session,row.business_id,{replace:Boolean(expected),expectedTerminalId:expected});
   db.prepare('INSERT INTO tablet_fleet_pairing_requests VALUES(?,?,?,?,?,?,?)').run(enrolment.terminalId,row.id,row.revision,row.business_id,actor.id,at,enrolment.expiresAt);
   audit(db,actor.id,row.id,'tablet_central_enrolment_issued',row,row,at,'Short-lived setup only; physical signed pairing is still required.');
   return{enrolment,installerUrl:base+'/'+row.id+'/installer',inventoryRevision:row.revision,expiresAt:enrolment.expiresAt,documentFilename:'CalEats-Tablet-Enrolment.json',targetSerial:row.serial_number,limitation:'The recorded serial is metadata, not device authentication. Run this setup on the intended Windows tablet. Replacement takes effect only after valid signed pairing; no Calai/printer/startup change is made.'};
  });
  return sendJson(res,isSetup?201:202,{data:outcome},noStore);
 }
 const match=/^\/api\/admin\/tablets\/([0-9a-f-]{36})(?:\/(disable|revoke|reassign|registration))?$/.exec(url.pathname);
 if(!match)return false;
 if(req.method==='GET'&&!match[2])return sendJson(res,200,{data:dto(db,config,rowFor(db,match[1]),{history:true,actorId:admin.id})},noStore);
 if(req.method==='PATCH'&&!match[2]){
  const body=await mutationBody(context,['expectedRevision','displayName','serialNumber','requestedStartupProduct',...Object.keys(mappingFields)],admin);
  if(Object.keys(body).length<2)throw fail(400,'VALIDATION_ERROR','Choose a supported metadata field to update.');
  let outcome;
  try{outcome=withTransaction(db,()=>{
   const actor=currentAdmin(db,config,session),before=rowFor(db,match[1]);revision(body,before);const at=config.now().toISOString(),values=[],changes=[];
   for(const [key,column]of Object.entries({displayName:'display_name',serialNumber:'serial_number',requestedStartupProduct:'requested_startup_product',...mappingFields})){if(!Object.hasOwn(body,key))continue;const value=key==='displayName'?name(body[key],'Display name'):key==='serialNumber'?serial(body[key]):key==='requestedStartupProduct'?startup(body[key]):optionalId(body[key],key);changes.push(column+'=?');values.push(value);}
   const updated=db.prepare(`UPDATE admin_tablets SET ${changes.join(',')},revision=revision+1,updated_at=? WHERE id=? AND revision=?`).run(...values,at,before.id,before.revision);if(updated.changes!==1)throw fail(409,'TABLET_REVISION_CHANGED','This tablet changed. Reload its record.');const after=rowFor(db,before.id);
   if(Object.hasOwn(body,'requestedStartupProduct')||Object.keys(mappingFields).some(key=>Object.hasOwn(body,key)))requestConfiguration(db,after,actor.id,at);
   audit(db,actor.id,before.id,'tablet_metadata_updated',before,after,at);return after;
  });}catch(error){ensureUnique(error);}
  return sendJson(res,200,{data:dto(db,config,outcome,{history:true,actorId:admin.id})},noStore);
 }
 if(req.method==='POST'&&match[2]==='registration'){
  const body=await mutationBody(context,['expectedRevision','terminalId','confirmSamePhysicalDevice'],admin);
  const outcome=withTransaction(db,()=>{
   const actor=currentAdmin(db,config,session),before=rowFor(db,match[1]);revision(body,before);
   if(before.authority_blocked_at||before.handoff_requested_at||before.archived_at||before.lifecycle_state==='disabled')throw fail(409,'TABLET_HANDOFF_PENDING','Registration reconciliation cannot complete a disabled/quarantined physical handoff.');
   if(body.confirmSamePhysicalDevice!==true||!before.business_id)throw fail(400,'TABLET_REGISTRATION_CONFIRMATION_REQUIRED','Confirm this inventory device and its existing native business before recording the registration.');
   const terminalId=optionalId(body.terminalId,'Application terminal'),terminal=terminalId&&db.prepare('SELECT * FROM business_terminals WHERE id=? AND revoked_at IS NULL').get(terminalId),canonical=canonicalBusinessId(db,before.business_id);
   if(!terminal||terminal.business_id!==canonical)throw fail(409,'TABLET_REGISTRATION_MISMATCH','The application registration must already belong to this exact native business.');
   assertTabletSelectionActivation(db,config,canonical,before.application_products);
   const at=config.now().toISOString(),other=db.prepare('SELECT * FROM admin_tablets WHERE terminal_id=? AND id<>?').get(terminalId,before.id);
   if(other){
    if(other.inventory_source!=='application_registration'||other.revision!==1||other.serial_number||Object.values(mapping(other)).some(Boolean)||other.authority_blocked_at||other.handoff_requested_at||other.requested_startup_product||other.archived_at)throw fail(409,'TABLET_METADATA_CONFLICT','This registration already has a managed inventory record. Review the records rather than merging their metadata.');
    db.prepare("UPDATE admin_tablets SET terminal_id=NULL,archived_at=?,superseded_by=?,lifecycle_state='disabled',revision=revision+1,updated_at=? WHERE id=? AND revision=?").run(at,before.id,at,other.id,other.revision);
    audit(db,actor.id,other.id,'tablet_registration_placeholder_superseded',other,rowFor(db,other.id),at);
   }
   if(before.terminal_id&&before.terminal_id!==terminalId&&db.prepare('SELECT 1 FROM business_terminals WHERE id=? AND revoked_at IS NULL').get(before.terminal_id))throw fail(409,'TABLET_REGISTRATION_CHANGED','The inventory still points at another active registration. Inspect it before reconciliation.');
   db.prepare("UPDATE admin_tablets SET business_id=?,terminal_id=?,lifecycle_state='assigned',revision=revision+1,updated_at=? WHERE id=? AND revision=?").run(canonical,terminalId,at,before.id,before.revision);
   const after=rowFor(db,before.id);audit(db,actor.id,before.id,'tablet_registration_reconciled',before,after,at,'Administrator-recorded same-device mapping only; no Windows cleanup, startup application or new operational authority.');return after;
  });
  return sendJson(res,200,{data:dto(db,config,outcome,{history:true,actorId:admin.id})},noStore);
 }
 if(req.method==='POST'&&match[2]){
  const reassign=match[2]==='reassign',body=await mutationBody(context,reassign?['expectedRevision','businessId','requestedStartupProduct','reason','confirmQuarantine']:['expectedRevision','reason'],admin);
  const outcome=withTransaction(db,()=>{
   const actor=currentAdmin(db,config,session),before=rowFor(db,match[1]);revision(body,before);const at=config.now().toISOString(),reason=name(body.reason,'Reason',300);
   if(reassign){
    if(body.confirmQuarantine!==true||!Object.hasOwn(body,'businessId'))throw fail(400,'QUARANTINE_CONFIRMATION_REQUIRED','Confirm that this device stays quarantined pending physical cleanup.');
    const target=location(db,body.businessId);if(target===before.business_id&&!before.handoff_requested_at)throw fail(409,'TABLET_ASSIGNMENT_UNCHANGED','This is already the recorded business assignment.');
    revokeRegistration(db,before,actor.id,at);
    db.prepare("UPDATE admin_tablets SET requested_business_id=?,requested_startup_product=?,lifecycle_state='pending_handoff',handoff_requested_at=COALESCE(handoff_requested_at,?),authority_blocked_at=COALESCE(authority_blocked_at,?),revision=revision+1,updated_at=? WHERE id=? AND revision=?").run(target,Object.hasOwn(body,'requestedStartupProduct')?startup(body.requestedStartupProduct):before.requested_startup_product,at,at,at,before.id,before.revision);
    const after=rowFor(db,before.id);requestConfiguration(db,after,actor.id,at);audit(db,actor.id,before.id,'tablet_reassignment_quarantined',before,after,at,reason);return after;
   }
   revokeRegistration(db,before,actor.id,at);
   db.prepare("UPDATE admin_tablets SET lifecycle_state='disabled',disabled_at=COALESCE(disabled_at,?),authority_blocked_at=COALESCE(authority_blocked_at,?),revision=revision+1,updated_at=? WHERE id=? AND revision=?").run(at,at,at,before.id,before.revision);
   const after=rowFor(db,before.id);audit(db,actor.id,before.id,'tablet_access_disabled',before,after,at,reason);return after;
  });
  return sendJson(res,200,{data:dto(db,config,outcome,{history:true,actorId:admin.id})},noStore);
 }
 return false;
}
