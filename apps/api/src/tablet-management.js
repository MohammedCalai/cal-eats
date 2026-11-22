import {randomUUID} from 'node:crypto';
import {withTransaction} from './db/index.js';
import {HttpError} from './http.js';
import {createTabletManagementGraphAdapter,tabletManagementReadiness} from './tablet-management-graph.js';
const workers=new WeakMap(),adapters=new WeakMap();
const iso=value=>new Date(value).toISOString();
const jobDto=row=>row?{id:row.id,status:row.status,attempts:row.attempts,requestedAt:row.requested_at,finishedAt:row.finished_at,errorCode:row.error_code,availableAt:row.available_at}:null;
const safe=code=>typeof code==='string'&&/^GRAPH_[A-Z0-9_]{1,80}$/.test(code)?code:'GRAPH_COLLECTION_FAILED';
export function tabletManagementState(db,config,row){
 const ready=tabletManagementReadiness(config.tabletManagement,row),observation=db.prepare('SELECT * FROM tablet_management_observations WHERE tablet_id=? ORDER BY collected_at DESC,rowid DESC LIMIT 1').get(row.id),job=db.prepare('SELECT * FROM tablet_management_refresh_jobs WHERE tablet_id=? ORDER BY requested_at DESC,rowid DESC LIMIT 1').get(row.id);
 const evidence=observation?JSON.parse(observation.evidence_json):null,matches=observation?.record_revision===row.revision;
 const fresh=evidence&&matches&&config.now().getTime()-Date.parse(observation.collected_at)<900000;
 return{state:fresh?'observed':evidence?'stale':'unavailable',configured:Boolean(config.tabletManagement?.enabled),source:evidence?'microsoft_graph':null,lastContactAt:evidence?.contactAt??null,evidence,evidenceMatchesCurrentRevision:Boolean(matches),latestRefresh:jobDto(job),refreshReady:ready.ready,refreshBlockReason:ready.reason};
}
export function queueTabletManagementRefresh(db,config,row,actorId){
 const ready=tabletManagementReadiness(config.tabletManagement,row);if(!ready.ready)throw new HttpError(409,'TABLET_MANAGEMENT_NOT_READY',ready.reason);
 const at=config.now().toISOString(),existing=db.prepare("SELECT * FROM tablet_management_refresh_jobs WHERE tablet_id=? AND status IN('queued','running')").get(row.id);
 if(existing&&existing.record_revision===row.revision)return jobDto(existing);
 if(existing)db.prepare("UPDATE tablet_management_refresh_jobs SET status='cancelled',finished_at=?,error_code='GRAPH_INVENTORY_CHANGED',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?").run(at,at,existing.id);
 const recent=db.prepare('SELECT * FROM tablet_management_refresh_jobs WHERE tablet_id=? AND record_revision=? AND requested_at>? ORDER BY rowid DESC LIMIT 1').get(row.id,row.revision,iso(config.now().getTime()-30000));if(recent)return jobDto(recent);
 const id=randomUUID();db.prepare("INSERT INTO tablet_management_refresh_jobs(id,tablet_id,record_revision,requested_by,requested_at,status,available_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?)").run(id,row.id,row.revision,actorId,at,at,at);
 return jobDto(db.prepare('SELECT * FROM tablet_management_refresh_jobs WHERE id=?').get(id));
}
async function collect(db,config,{adapter,limit=2,workerId=randomUUID()}={}){
 if(!Number.isInteger(limit)||limit<1||limit>10)throw new TypeError('Tablet collection limit must be1–10');
 const result={completed:0,failed:0,cancelled:0,retried:0};
 if(!config.tabletManagement?.enabled&&!adapter)return{...result,disabled:true};
 const at=config.now().toISOString();
 withTransaction(db,()=>db.prepare("UPDATE tablet_management_refresh_jobs SET status=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,available_at=CASE WHEN attempts<3 THEN ? ELSE NULL END,finished_at=CASE WHEN attempts>=3 THEN ? ELSE NULL END,error_code='GRAPH_READ_LEASE_EXPIRED',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE status='running' AND lease_expires_at<=?").run(at,at,at,at));
 if(!adapters.has(config))adapters.set(config,adapter??createTabletManagementGraphAdapter(config.tabletManagement,{now:()=>config.now().getTime()}));const transport=adapter??adapters.get(config);
 for(let i=0;i<limit;i++){
  const job=withTransaction(db,()=>{const now=config.now().toISOString(),candidate=db.prepare("SELECT * FROM tablet_management_refresh_jobs WHERE status='queued' AND available_at<=? ORDER BY available_at,rowid LIMIT 1").get(now);if(!candidate)return null;const saved=db.prepare("UPDATE tablet_management_refresh_jobs SET status='running',attempts=attempts+1,lease_owner=?,lease_expires_at=?,updated_at=? WHERE id=? AND status='queued'").run(workerId,iso(config.now().getTime()+180000),now,candidate.id);return saved.changes?{...candidate,attempts:candidate.attempts+1}:null;});if(!job)break;
  const current=()=>{const row=db.prepare('SELECT * FROM admin_tablets WHERE id=? AND archived_at IS NULL').get(job.tablet_id);const actor=db.prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND account_enabled=1 AND principal_kind='human'").get(job.requested_by);return row&&row.revision===job.record_revision&&actor?row:null;};
  const owned=()=>Boolean(db.prepare("SELECT 1 FROM tablet_management_refresh_jobs WHERE id=? AND status='running' AND lease_owner=? AND lease_expires_at>?").get(job.id,workerId,config.now().toISOString()));
  let evidence,error,row=current();
  if(!row)error={code:'GRAPH_INVENTORY_OR_ADMIN_CHANGED',cancel:true};
  else try{const cached=db.prepare('SELECT run_state_id FROM tablet_management_observations WHERE tablet_id=? AND record_revision=? AND script_id=? AND run_state_id IS NOT NULL ORDER BY collected_at DESC LIMIT 1').get(row.id,row.revision,row.startup_profile_id);evidence=await transport.collect(row,{cachedRunStateId:cached?.run_state_id??null});}catch(caught){error=caught;}
  withTransaction(db,()=>{
   if(!owned())return;
   const now=config.now().toISOString(),fresh=current();
   if(!fresh){error={code:'GRAPH_INVENTORY_OR_ADMIN_CHANGED',cancel:true};evidence=null;}
   if(evidence){
    // Only the private server collector reaches this boundary; there is no form/webhook setter for evidence.
    if(evidence.identityMatched!==true||evidence.source!=='microsoft_graph'||evidence.applicationPresenceVerified!==false||evidence.physicalStartupVerified!==false){error={code:'GRAPH_EVIDENCE_INVALID'};evidence=null;}
   }
   if(evidence){
    db.prepare('INSERT INTO tablet_management_observations(id,tablet_id,record_revision,refresh_job_id,source,collected_at,contact_at,intune_device_id,entra_device_id,serial_number,script_id,script_sha256,run_state_id,execution_at,execution_status,execution_changed,evidence_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),row.id,row.revision,job.id,'microsoft_graph',now,evidence.contactAt,row.intune_managed_device_id,row.entra_device_id,row.serial_number,evidence.scriptRef,evidence.scriptSha256,evidence.runStateId,evidence.execution?.observedAt??null,evidence.execution?.status??null,typeof evidence.execution?.changed==='boolean'?Number(evidence.execution.changed):null,JSON.stringify({...evidence,collectedAt:now}));
    db.prepare("UPDATE tablet_management_refresh_jobs SET status='completed',finished_at=?,error_code=NULL,available_at=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?").run(now,now,job.id);result.completed++;
   }else{
    const retry=Boolean(error?.retry&&job.attempts<3),status=error?.cancel?'cancelled':retry?'queued':'failed';
    db.prepare('UPDATE tablet_management_refresh_jobs SET status=?,available_at=?,finished_at=?,error_code=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?').run(status,retry?iso(config.now().getTime()+Math.min(300000,30000*2**(job.attempts-1))):null,retry?null:now,safe(error?.code),now,job.id);result[retry?'retried':status]++;
   }
  });
 }
 return result;
}
export function runTabletManagementRefresh(db,config,options){if(workers.has(db))return workers.get(db);const work=collect(db,config,options).finally(()=>workers.delete(db));workers.set(db,work);return work;}
