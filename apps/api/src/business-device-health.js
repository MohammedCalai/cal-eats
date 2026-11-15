import {randomUUID} from "node:crypto";
import {requireRestaurantMembership} from "./auth/authorization.js";
import {requireRestaurantCapability} from "./membership-capabilities.js";
import {HttpError,exactObject,readJson,sendJson} from "./http.js";
import {orderingTerminalStatus,requireOrderingTerminal} from "./ordering-terminals.js";
import {restaurantAvailability} from "./availability.js";
import {withTransaction} from "./db/index.js";
import {PAYABLE_ORDER_SQL} from "./order-confirmation.js";

const states=new Set(["ready","unreachable","not_configured","needs_attention","unknown"]);
const sources=new Set(["windows_spooler","tcp_connect","escpos_status","none"]);
const knownFaults=new Set(["out_of_paper","cover_open","paused_queue","printer_error","offline","driver_unavailable","spooler_unavailable","connection_failed"]);
const blockingFaults=new Set(["out_of_paper","cover_open","paused_queue","printer_error"]);
const parse=value=>{try{return JSON.parse(value);}catch{return [];}};
const date=value=>Number.isFinite(Date.parse(value));
const sqlNow=config=>config.now().toISOString();
function requireDeviceAccess(db,session,restaurantId,req,config){
  const user=requireRestaurantMembership(db,session,restaurantId);if(user.role!=='restaurant')return user;
  try{requireRestaurantCapability(db,session,restaurantId,'canViewDevices');return user;}
  catch(cause){if(cause.code!=='RESTAURANT_CAPABILITY_REQUIRED'||!session.terminalDelegation||session.native)throw cause;}
  // A paired tablet operator needs to read outage warnings even when its screen
  // is stale. This is read/acknowledgement access, never processing authority.
  const terminal=requireOrderingTerminal({req,db,config,session,restaurantId,action:'device'});
  requireRestaurantCapability(db,session,restaurantId,'canProcessOrders');
  const stamp=sqlNow(config),grant=session.terminalId===terminal.id&&db.prepare(`SELECT 1 FROM ordering_terminal_sessions g
    JOIN sessions s ON s.id=g.session_id AND s.user_id=g.user_id JOIN users u ON u.id=g.user_id
    WHERE g.token_hash=? AND g.terminal_id=? AND g.restaurant_id=? AND g.user_id=? AND g.session_id=?
      AND g.revoked_at IS NULL AND g.expires_at>? AND s.revoked_at IS NULL AND s.expires_at>?
      AND u.account_enabled=1 AND u.role='restaurant'`).get(session.terminalGrantHash,terminal.id,restaurantId,user.id,session.sessionId,stamp,stamp);
  if(!grant)throw new HttpError(403,'DEVICE_ACCESS_REQUIRED','Connect your staff sign-in on the registered restaurant tablet to view these warnings.');
  return user;
}
export function loadBusinessDeviceConfig(input={},env=process.env){
  const defaults={reportIntervalSeconds:15,staleAfterSeconds:60,connectivityConfirmationSeconds:30,recoveryHealthyChecks:2};
  const names={reportIntervalSeconds:"CALAI_DEVICE_HEALTH_REPORT_SECONDS",staleAfterSeconds:"CALAI_DEVICE_HEALTH_STALE_SECONDS",connectivityConfirmationSeconds:"CALAI_DEVICE_HEALTH_CONFIRM_SECONDS",recoveryHealthyChecks:"CALAI_DEVICE_HEALTH_RECOVERY_CHECKS"};
  const result={};for(const[key,value]of Object.entries(defaults)){const number=Number(input[key]??env[names[key]]??value);if(!Number.isInteger(number)||number<1||number>(key==="recoveryHealthyChecks"?10:600))throw Error(`Invalid device health setting: ${key}`);result[key]=number;}
  if(result.staleAfterSeconds<result.reportIntervalSeconds*2)throw Error("Device health freshness must allow two reporting intervals");return result;
}
const settings=config=>config.businessDevices??loadBusinessDeviceConfig();
function terminalStatus(db,config,id){const value=orderingTerminalStatus(db,config,id);return {...value,deviceId:value.deviceId??value.id??null,status:value.status??(value.isReady?"online":value.registered?"offline":"not_registered")};}
function jobCounts(db,id){
  const rows=db.prepare("SELECT * FROM (SELECT j.id AS id,j.order_id AS order_id,j.status AS status,j.updated_at AS updated_at,j.spooler_job_id,j.manual_reprint,j.receipt_revision,'order' source FROM device_print_jobs j JOIN restaurant_printers p ON p.id=j.printer_id WHERE p.restaurant_id=? UNION ALL SELECT j.id,NULL order_id,j.status,j.updated_at,j.spooler_job_id,0 manual_reprint,j.receipt_revision,'test_receipt' source FROM printer_test_jobs j JOIN restaurant_printers p ON p.id=j.printer_id WHERE p.restaurant_id=?) ORDER BY updated_at DESC,id DESC LIMIT 100").all(id,id);
  const totals=db.prepare("SELECT status,SUM(n) n FROM (SELECT j.status,COUNT(*) n FROM device_print_jobs j JOIN restaurant_printers p ON p.id=j.printer_id WHERE p.restaurant_id=? GROUP BY j.status UNION ALL SELECT j.status,COUNT(*) n FROM printer_test_jobs j JOIN restaurant_printers p ON p.id=j.printer_id WHERE p.restaurant_id=? GROUP BY j.status) GROUP BY status").all(id,id),counts=Object.fromEntries(totals.map(r=>[r.status,r.n]));
  return {queued:counts.queued??0,dispatched:(counts.dispatched??0)+(counts.claimed??0),submitted:counts.submitted??0,failed:counts.failed??0,uncertain:counts.uncertain??0,lastOutcome:rows[0]?{id:rows[0].id,status:rows[0].status==="printed"?"legacy_unverified":rows[0].status,updatedAt:rows[0].updated_at,spoolerJobId:rows[0].spooler_job_id??null}:null,rows};
}
export function businessOperationsHealth(db,config,restaurantId,userId=null){
  const restaurant=db.prepare("SELECT * FROM restaurants WHERE id=?").get(restaurantId);if(!restaurant)throw new HttpError(404,"NOT_FOUND","Restaurant not found");
  const now=config.now(),stamp=now.toISOString(),s=settings(config),terminal=terminalStatus(db,config,restaurantId),deviceId=terminal.deviceId;
  const observed=deviceId?db.prepare("SELECT * FROM business_device_health WHERE terminal_id=? AND restaurant_id=?").get(deviceId,restaurantId):null;
  const fresh=observed&&Date.parse(observed.received_at)>+now-s.staleAfterSeconds*1000;
  const observationFresh=observed&&Date.parse(observed.reported_observed_at)>+now-s.staleAfterSeconds*1000;
  const awaitingFirstReport=!observed&&terminal.registered&&+now-Date.parse(terminal.registeredAt)<=s.staleAfterSeconds*1000;
  const bridgeOnline=Boolean(fresh),diagnosticsUsable=terminal.isReady&&bridgeOnline,printerRow=db.prepare("SELECT id,name FROM restaurant_printers WHERE restaurant_id=? AND enabled=1 AND revoked_at IS NULL ORDER BY created_at,id LIMIT 1").get(restaurantId);
  const selected=observed?.printer_id?db.prepare("SELECT id,name FROM restaurant_printers WHERE id=? AND restaurant_id=? AND enabled=1 AND revoked_at IS NULL").get(observed.printer_id,restaurantId):printerRow;
  const faults=diagnosticsUsable&&observationFresh?parse(observed.faults):[],state=!selected?"not_configured":!diagnosticsUsable||!observationFresh?"unknown":observed.printer_state;
  const physicalReadinessKnown=Boolean(diagnosticsUsable&&observationFresh&&observed.physical_readiness_known);
  let label=!terminal.isReady?"Tablet offline — printer status unavailable":!fresh?(awaitingFirstReport?"Waiting for the first printing service report":"Printing service offline"):state==="not_configured"?"Printer not configured":state==="unreachable"?"Printer not connected":state==="needs_attention"?"Printer needs attention":state==="ready"?(physicalReadinessKnown?"Printer ready":"No reported printer fault"):"Printer status unavailable";
  if(!terminal.registered)label="Ordering tablet not registered — printer status unavailable";
  const jobs=jobCounts(db,restaurantId),incidents=db.prepare("SELECT i.*,r.read_at FROM business_device_incidents i LEFT JOIN business_device_incident_reads r ON r.incident_id=i.id AND r.user_id=? WHERE i.restaurant_id=? AND i.status<>'candidate' ORDER BY CASE WHEN i.status='active' THEN 0 ELSE 1 END,i.last_observed_at DESC,i.id DESC LIMIT 50").all(userId,restaurantId).map(r=>({id:r.id,status:r.status,faultCode:r.fault_code,title:r.title,message:r.message,severity:r.severity,openedAt:r.opened_at,resolvedAt:r.resolved_at,readAt:r.read_at&&r.read_at>=(r.resolved_at??r.opened_at??r.first_observed_at)?r.read_at:null,...(r.order_id?{orderId:r.order_id}:{})}));
  return {restaurantId,restaurantName:restaurant.name,generatedAt:stamp,settings:s,tablet:terminal,bridge:{status:bridgeOnline?"online":terminal.isReady&&!awaitingFirstReport?"offline":"unknown",lastContactAt:observed?.received_at??null,version:observed?.bridge_version??null},printer:{id:selected?.id??null,name:selected?.name??null,state,label,source:diagnosticsUsable&&observationFresh?observed.observation_source:"none",faults,lastObservedAt:observed?.reported_observed_at??null,physicalReadinessKnown},jobs:{...jobs,rows:undefined},incidents,push:{enabled:Boolean(config.businessPush?.enabled),configured:Boolean(config.businessPush?.enabled&&config.businessPush.accessToken),registrationRequired:true}};
}
function actionableRecipients(db,restaurantId){return db.prepare("SELECT u.id FROM users u JOIN restaurant_memberships m ON m.user_id=u.id WHERE m.restaurant_id=? AND u.role='restaurant' AND u.account_enabled=1 AND (m.permission='owner' OR COALESCE(m.can_view_devices,0)=1)").all(restaurantId);}
function announce(db,config,incident,phase,quiet){
  const stamp=sqlNow(config),restaurant=db.prepare("SELECT name FROM restaurants WHERE id=?").get(incident.restaurant_id),recovery=phase==="resolved";
  const title=recovery?`Connection restored — ${restaurant.name}`:incident.title,message=recovery?`The ${incident.fault_code==='tablet_offline'?'ordering tablet':incident.fault_code==='printing_service_offline'?'printing service':'printer'} has recovered after consecutive healthy checks.`:incident.message;
  for(const user of actionableRecipients(db,incident.restaurant_id)){
    const key=`device-incident:${incident.id}:${phase}`,id=randomUUID();
    db.prepare("INSERT OR IGNORE INTO user_notifications(id,user_id,type,title,message,restaurant_id,event_key,created_at,read_at) VALUES(?,?,'device_incident',?,?,?,?,?,NULL)").run(id,user.id,title,message,incident.restaurant_id,key,stamp);
    if(quiet)continue;
    const notice=db.prepare("SELECT id FROM user_notifications WHERE user_id=? AND event_key=?").get(user.id,key);
    db.prepare("INSERT OR IGNORE INTO business_incident_push_outbox(id,incident_id,notification_id,phase,device_id,generation,user_id,status,available_at,expires_at,created_at,updated_at) SELECT lower(hex(randomblob(16))),?,?,?,d.id,d.generation,d.user_id,'pending',?,?,?,? FROM business_push_devices d JOIN native_business_sessions s ON s.id=d.session_id WHERE d.user_id=? AND d.revoked_at IS NULL AND d.expires_at>? AND s.revoked_at IS NULL AND s.expires_at>?").run(incident.id,notice.id,phase,stamp,new Date(Date.parse(stamp)+24*3600000).toISOString(),stamp,stamp,user.id,stamp,stamp);
  }
}
function observeFault(db,config,{restaurantId,terminalId,printerId=null,orderId=null,jobId=null,code,bad,immediate=false,evidence,title,message,severity="warning",quiet=false}){
  const stamp=sqlNow(config),s=settings(config),old=db.prepare("SELECT * FROM business_device_incidents WHERE restaurant_id=? AND terminal_id=? AND fault_code=? AND COALESCE(job_id,'')=? AND status IN ('candidate','active')").get(restaurantId,terminalId,code,jobId??"");
  if(!bad){
    if(!old||old.last_evidence===evidence||!evidence)return;
    const healthy=old.healthy_checks+1;
    if(healthy>=s.recoveryHealthyChecks){db.prepare("UPDATE business_device_incidents SET status='resolved',resolved_at=?,last_observed_at=?,healthy_checks=?,last_evidence=? WHERE id=?").run(stamp,stamp,healthy,evidence,old.id);if(old.status==='active')announce(db,config,old,"resolved",quiet||Boolean(old.push_suppressed));}
    else db.prepare("UPDATE business_device_incidents SET healthy_checks=?,last_evidence=?,last_observed_at=? WHERE id=?").run(healthy,evidence,stamp,old.id);
    return;
  }
  if(!old){
    const id=randomUUID(),status=immediate?"active":"candidate";
    db.prepare("INSERT INTO business_device_incidents(id,restaurant_id,terminal_id,printer_id,order_id,job_id,fault_code,severity,status,title,message,first_observed_at,opened_at,last_observed_at,last_evidence,push_suppressed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,restaurantId,terminalId,printerId,orderId,jobId,code,severity,status,title,message,stamp,immediate?stamp:null,stamp,evidence??null,Number(quiet));
    if(immediate)announce(db,config,db.prepare("SELECT * FROM business_device_incidents WHERE id=?").get(id),"opened",quiet);
    return;
  }
  const observations=old.bad_observations+(old.last_evidence!==evidence?1:0),open=old.status==='candidate'&&(immediate||(observations>=2&&Date.parse(stamp)-Date.parse(old.first_observed_at)>=s.connectivityConfirmationSeconds*1000));
  db.prepare("UPDATE business_device_incidents SET healthy_checks=0,bad_observations=?,last_evidence=?,last_observed_at=?,status=?,opened_at=CASE WHEN ? THEN ? ELSE opened_at END WHERE id=?").run(observations,evidence??null,stamp,open?'active':old.status,Number(open),stamp,old.id);
  if(open)announce(db,config,old,"opened",quiet);
  else if(old.status==='active'&&old.push_suppressed&&!quiet){db.prepare('UPDATE business_device_incidents SET push_suppressed=0 WHERE id=?').run(old.id);announce(db,config,old,'opened',false);}
}
function reconcile(db,config,restaurantId){
  const health=businessOperationsHealth(db,config,restaurantId),r=db.prepare("SELECT * FROM restaurants WHERE id=?").get(restaurantId);if(r.status!=='approved'||r.archived_at)return health;
  const currentTime=config.now().getTime(),freshness=settings(config).staleAfterSeconds*1000;
  const deadlines=[health.tablet.lastContactAt,health.tablet.screenLastSeenAt,health.bridge.lastContactAt,health.printer.lastObservedAt].filter(Boolean).map(value=>Date.parse(value)+freshness+1);
  const hasEpisode=db.prepare("SELECT 1 FROM business_device_incidents WHERE restaurant_id=? AND status IN ('candidate','active') LIMIT 1").get(restaurantId);
  const nextCheck=health.tablet.isReady&&health.bridge.status==='online'&&!hasEpisode&&deadlines.every(value=>value>currentTime)?Math.min(...deadlines):currentTime+settings(config).reportIntervalSeconds*1000;
  db.prepare('UPDATE restaurants SET device_health_due_at=? WHERE id=?').run(new Date(nextCheck).toISOString(),restaurantId);
  const terminal=health.tablet,id=terminal.deviceId??`unregistered-${restaurantId}`,raw=terminal.deviceId?db.prepare("SELECT * FROM business_device_health WHERE terminal_id=?").get(terminal.deviceId):null;
  const active=db.prepare(`SELECT COUNT(*) n FROM orders o WHERE o.restaurant_id=? AND (o.status IN ('accepted','preparing','ready','out_for_delivery') OR (o.status='placed' AND o.merchant_visible_at IS NOT NULL AND ${PAYABLE_ORDER_SQL}))`).get(restaurantId).n;
  const quiet=!restaurantAvailability({...r,tablet_offline_blocked_at:null},config.now()).acceptingOrders&&!active;
  const args={restaurantId,terminalId:id,printerId:health.printer.id,quiet};
  const offline=!terminal.isReady&&Boolean(terminal.graceExceeded??true),screenEvidence=terminal.screenLastSeenAt??terminal.lastContactAt??`offline-${sqlNow(config)}`;
  // A replacement retires an old printer episode; it is not evidence that the
  // old hardware recovered. Its tablet outage still needs two new screen checks.
  for(const previous of db.prepare("SELECT * FROM business_device_incidents WHERE restaurant_id=? AND terminal_id<>? AND status IN ('candidate','active')").all(restaurantId,id)){
    if(previous.fault_code==='tablet_offline'&&terminal.isReady)observeFault(db,config,{...args,terminalId:previous.terminal_id,code:'tablet_offline',bad:false,evidence:`${id}:${screenEvidence}`});
    else if(previous.fault_code!=='tablet_offline')db.prepare("UPDATE business_device_incidents SET status='resolved',resolved_at=?,last_observed_at=?,message=message||' The registered device was replaced.' WHERE id=?").run(sqlNow(config),sqlNow(config),previous.id);
  }
  observeFault(db,config,{...args,code:'tablet_offline',bad:offline,immediate:true,evidence:screenEvidence,title:`Tablet offline — ${r.name}`,message:'Tablet offline — printer status unavailable. New orders are unavailable until the ordering tablet reconnects.'});
  if(offline)db.prepare("UPDATE restaurants SET tablet_offline_blocked_at=COALESCE(tablet_offline_blocked_at,?) WHERE id=?").run(sqlNow(config),restaurantId);
  else if(terminal.isReady&&!db.prepare("SELECT 1 FROM business_device_incidents WHERE restaurant_id=? AND fault_code='tablet_offline' AND status IN ('active','candidate')").get(restaurantId))db.prepare("UPDATE restaurants SET tablet_offline_blocked_at=NULL WHERE id=?").run(restaurantId);
  if(!terminal.isReady)return businessOperationsHealth(db,config,restaurantId);
  // Re-sending one cached observation must not count as another healthy check.
  const evidence=raw?.reported_observed_at?`${raw.terminal_id}:${Date.parse(raw.reported_observed_at)}`:null;
  observeFault(db,config,{...args,code:'printing_service_offline',bad:health.bridge.status==='offline',immediate:true,evidence:health.bridge.status==='unknown'?null:evidence??`service-offline-${sqlNow(config)}`,title:`Printing service offline — ${r.name}`,message:'Printing service offline — the restaurant printing service is not responding.'});
  if(health.bridge.status!=='online')return businessOperationsHealth(db,config,restaurantId);
  observeFault(db,config,{...args,code:'printer_not_configured',bad:health.printer.state==='not_configured',immediate:true,evidence,title:`Printer not configured — ${r.name}`,message:'Choose a printer on the restaurant tablet. Printer status is unavailable until setup is complete.'});
  observeFault(db,config,{...args,code:'printer_unreachable',bad:health.printer.state==='unreachable',evidence:['ready','needs_attention','unreachable'].includes(health.printer.state)?evidence:null,title:`Printer not connected — ${r.name}`,message:'Check the printer’s power and connection. Orders remain visible on the restaurant tablet.'});
  for(const code of blockingFaults)observeFault(db,config,{...args,code,bad:health.printer.faults.includes(code),immediate:true,evidence:health.printer.state!=='unknown'&&['windows_spooler','escpos_status'].includes(health.printer.source)?evidence:null,title:`Printer needs attention — ${r.name}`,message:code==='out_of_paper'?'The printer reports that it is out of paper.':code==='cover_open'?'The printer reports that its cover is open.':code==='paused_queue'?'The Windows printer queue reports that it is paused.':'The printer driver reports a blocking fault.'});
  const jobs=jobCounts(db,restaurantId).rows;
  for(const job of jobs.filter(j=>['failed','uncertain'].includes(j.status)))observeFault(db,config,{...args,jobId:job.id,orderId:job.order_id,code:job.status==='uncertain'?'print_uncertain':'print_failed',bad:true,immediate:true,evidence:job.updated_at,title:`${job.status==='uncertain'?'Print result uncertain':'Print failed'} — ${job.order_id?`Order #${job.order_id.slice(0,8).toUpperCase()}`:`Test receipt · ${r.name}`}`,message:job.status==='uncertain'?'Check the receipt on the restaurant tablet before reprinting; it may already have printed.':job.order_id?'Open the order on the restaurant tablet to check and retry.':'Open the printer page on the restaurant tablet to check the test receipt.'});
  return businessOperationsHealth(db,config,restaurantId);
}
export function reconcileBusinessDeviceHealth(db,config,restaurantId){return withTransaction(db,()=>reconcile(db,config,restaurantId));}
// An explicit, audited tablet-side receipt check closes a job incident. It is
// not a hardware recovery observation and must not send a "connection restored" push.
export function resolveCheckedPrintIncident(db,config,jobId){
  const stamp=sqlNow(config);
  db.prepare("UPDATE business_device_incidents SET status='resolved',resolved_at=?,last_observed_at=?,message=message||' A staff member checked this receipt on the registered tablet.' WHERE job_id=? AND fault_code IN ('print_failed','print_uncertain') AND status IN ('candidate','active')").run(stamp,stamp,jobId);
}
export function runBusinessDeviceHealth(db,config,{limit=100,after=null}={}){
  const bound=Math.min(500,Math.max(1,limit)),rows=db.prepare("SELECT id FROM restaurants WHERE status='approved' AND archived_at IS NULL AND (device_health_due_at IS NULL OR device_health_due_at<=?) ORDER BY COALESCE(device_health_due_at,''),id LIMIT ?").all(sqlNow(config),bound);
  for(const row of rows)reconcileBusinessDeviceHealth(db,config,row.id);return {checked:rows.length,hasMore:rows.length===bound,nextCursor:null};
}
export function assertTabletOrderingAvailable(db,config,restaurantId){
  const value=terminalStatus(db,config,restaurantId),r=db.prepare("SELECT tablet_offline_blocked_at FROM restaurants WHERE id=?").get(restaurantId);
  if(r?.tablet_offline_blocked_at||!value.isReady&&Boolean(value.graceExceeded??true))throw new HttpError(409,"ORDERING_TABLET_UNAVAILABLE","This restaurant is temporarily unavailable. Please check back shortly.");
}
export async function routeBusinessDeviceHealth({req,res,url,db,config,session}){
  const view=/^\/api\/restaurant\/restaurants\/([^/]+)\/operations-health$/.exec(url.pathname);
  if(view&&req.method==='GET'){const user=requireDeviceAccess(db,session,view[1],req,config);return sendJson(res,200,{data:businessOperationsHealth(db,config,view[1],user.id)});}
  const read=/^\/api\/restaurant\/incidents\/([^/]+)\/read$/.exec(url.pathname);
  if(read&&req.method==='PATCH'){
    const incident=db.prepare("SELECT restaurant_id FROM business_device_incidents WHERE id=? AND status<>'candidate'").get(read[1]);if(!incident)throw new HttpError(404,'NOT_FOUND','Incident not found');
    const user=requireDeviceAccess(db,session,incident.restaurant_id,req,config),body=await readJson(req,config.bodyLimit);exactObject(body,['read']);if(body.read!==true)throw new HttpError(400,'VALIDATION_ERROR','Mark the incident as read');
    withTransaction(db,()=>{const stamp=sqlNow(config);db.prepare("INSERT INTO business_device_incident_reads(incident_id,user_id,read_at) VALUES(?,?,?) ON CONFLICT(incident_id,user_id) DO UPDATE SET read_at=excluded.read_at").run(read[1],user.id,stamp);db.prepare("UPDATE user_notifications SET read_at=COALESCE(read_at,?) WHERE user_id=? AND event_key IN (?,?) AND created_at<=?").run(stamp,user.id,`device-incident:${read[1]}:opened`,`device-incident:${read[1]}:resolved`,stamp);});return sendJson(res,200,{data:{read:true,incidentId:read[1]}});
  }
  if(req.method!=='POST'||url.pathname!=='/api/terminal-devices/health')return false;
  const body=await readJson(req,config.bodyLimit);exactObject(body,['bridgeVersion','printer','jobs']);
  if(typeof body.bridgeVersion!=='string'||!/^[A-Za-z0-9._-]{1,40}$/.test(body.bridgeVersion)||!body.printer||typeof body.printer!=='object')throw new HttpError(400,'VALIDATION_ERROR','Device health report is invalid');
  exactObject(body.printer,['id','state','source','faults','observedAt','physicalReadinessKnown','spoolerJobIds']);
  const p=body.printer;if(!states.has(p.state)||!sources.has(p.source)||!Array.isArray(p.faults)||p.faults.length>8||p.faults.some(v=>!knownFaults.has(v))||typeof p.physicalReadinessKnown!=='boolean'||typeof p.observedAt!=='string'||!date(p.observedAt))throw new HttpError(400,'VALIDATION_ERROR','A fresh timestamped printer observation is required');
  if(p.observedAt&&(config.now().getTime()-Date.parse(p.observedAt)>settings(config).staleAfterSeconds*1000||Date.parse(p.observedAt)>config.now().getTime()+15000))throw new HttpError(409,'STALE_PRINTER_OBSERVATION','Take a new printer observation before reporting health');
  if(p.faults.some(v=>blockingFaults.has(v))&&!['windows_spooler','escpos_status'].includes(p.source)||p.physicalReadinessKnown&&p.source!=='escpos_status')throw new HttpError(400,'UNSUPPORTED_DIAGNOSTIC','The observation source cannot establish this physical printer state');
  if(p.source==='none'&&(!['unknown','not_configured'].includes(p.state)||p.faults.length))throw new HttpError(400,'UNSUPPORTED_DIAGNOSTIC','Printer readiness requires a supported observation source');
  const terminal=await requireOrderingTerminal({req,db,config,session,action:'health',body}),restaurantId=terminal.restaurantId??terminal.restaurant_id,terminalId=terminal.deviceId??terminal.id;
  if(p.id&&!db.prepare("SELECT 1 FROM restaurant_printers WHERE id=? AND restaurant_id=? AND enabled=1 AND revoked_at IS NULL").get(p.id,restaurantId))throw new HttpError(404,'NOT_FOUND','Configured printer not found');
  const stamp=sqlNow(config);db.prepare("INSERT INTO business_device_health(terminal_id,restaurant_id,printer_id,bridge_version,printer_state,observation_source,faults,physical_readiness_known,reported_observed_at,received_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(terminal_id) DO UPDATE SET printer_id=excluded.printer_id,bridge_version=excluded.bridge_version,printer_state=excluded.printer_state,observation_source=excluded.observation_source,faults=excluded.faults,physical_readiness_known=excluded.physical_readiness_known,reported_observed_at=excluded.reported_observed_at,received_at=excluded.received_at,sequence=business_device_health.sequence+1").run(terminalId,restaurantId,p.id??null,body.bridgeVersion,p.state,p.source,JSON.stringify([...new Set(p.faults)]),Number(p.physicalReadinessKnown),new Date(p.observedAt).toISOString(),stamp);
  return sendJson(res,200,{data:reconcileBusinessDeviceHealth(db,config,restaurantId)});
}
