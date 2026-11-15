import {randomUUID} from "node:crypto";
import {requireRestaurantOwner} from "./auth/authorization.js";
import {withTransaction} from "./db/index.js";
import {HttpError,exactObject,readJson,sendJson} from "./http.js";

const SOURCES=[{jobs:"device_print_jobs",tokens:"printer_job_claim_tokens",testReceipt:false},{jobs:"printer_test_jobs",tokens:"printer_test_job_claim_tokens",testReceipt:true}];
const dto=row=>row?{id:row.id,status:row.status,detail:row.detail??null,spoolerJobId:row.spooler_job_id??null,createdAt:row.created_at,updatedAt:row.updated_at}:null;
export function latestPrinterTestReceipt(db,printerId){return dto(db.prepare("SELECT id,status,detail,spooler_job_id,created_at,updated_at FROM printer_test_jobs WHERE printer_id=? ORDER BY created_at DESC,id DESC LIMIT 1").get(printerId));}

export function samplePrinterReceipt(restaurantName,now){
  return{testReceipt:true,format:"cal-eats-receipt-v1",orderNumber:"TEST-PRINT",restaurantName,createdAt:now,fulfillment:"delivery",customerName:"Sample Customer",deliveryAddress:"10 Sample Street, Sample Town, TE57 1NG",items:[{name:"Chicken Tikka Masala",quantity:2,unitPriceMinor:950,totalMinor:1900,modifiers:[],allergens:[]},{name:"Rice",quantity:1,unitPriceMinor:350,totalMinor:350,modifiers:[],allergens:[]},{name:"Naan",quantity:1,unitPriceMinor:250,totalMinor:250,modifiers:[],allergens:[]}],subtotalMinor:2500,deliveryFeeMinor:250,totalMinor:2750,currency:"GBP",orderNotes:"PRINTER TEST - SAMPLE ONLY. DO NOT PREPARE OR DELIVER.",paymentStatus:"TEST - no payment"};
}

export async function createPrinterTestReceipt({req,res,db,config,session,restaurantId,printerId}){
  const owner=requireRestaurantOwner(db,session,restaurantId),body=await readJson(req,config.bodyLimit);exactObject(body,["requestId"]);
  if(typeof body.requestId!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId))throw new HttpError(400,"VALIDATION_ERROR","A valid test request ID is required.");
  const requestId=body.requestId.toLowerCase(),now=config.now().toISOString();
  const result=withTransaction(db,()=>{
    const restaurant=db.prepare("SELECT name FROM restaurants WHERE id=? AND archived_at IS NULL AND status='approved' AND suspended=0").get(restaurantId);
    const printer=db.prepare("SELECT * FROM restaurant_printers WHERE id=? AND restaurant_id=? AND revoked_at IS NULL").get(printerId,restaurantId);
    if(!restaurant||!printer)throw new HttpError(404,"NOT_FOUND","Active restaurant printer not found.");
    if(!printer.enabled)throw new HttpError(409,"PRINTER_DISABLED","Enable this printer before sending a test receipt.");
    const previous=db.prepare("SELECT id,status FROM printer_test_jobs WHERE printer_id=? AND request_id=?").get(printerId,requestId);if(previous)return{...previous,replay:true};
    const recent=new Date(Date.parse(now)-60000).toISOString();
    if(!db.prepare("SELECT 1 FROM printer_devices WHERE printer_id=? AND restaurant_id=? AND revoked_at IS NULL AND last_seen_at>=? AND printer_reachable=1 AND printer_checked_at>=?").get(printerId,restaurantId,recent,recent))throw new HttpError(409,"PRINTER_DEVICE_REQUIRED","The printer is not connected. Check the Windows printer setup and make sure the printer is switched on before trying again.");
    if(db.prepare("SELECT 1 FROM printer_test_jobs WHERE printer_id=? AND status IN ('queued','claimed','dispatched')").get(printerId))throw new HttpError(409,"PRINTER_TEST_PENDING","A printer test is already waiting or printing. Wait for its result before sending another.");
    const id=`test-print-${randomUUID()}`;
    db.prepare("INSERT INTO printer_test_jobs(id,printer_id,restaurant_id,request_id,requested_by_user_id,receipt,status,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?,?)").run(id,printerId,restaurantId,requestId,owner.id,JSON.stringify(samplePrinterReceipt(restaurant.name,now)),new Date(Date.parse(now)+5*60000).toISOString(),now,now);
    db.prepare("INSERT INTO audit_events(id,actor_user_id,entity_type,entity_id,action,details,created_at) VALUES(?,?,?,?,?,?,?)").run(randomUUID(),owner.id,"printer",printerId,"printer_test_receipt_requested",JSON.stringify({testReceipt:true,testJobId:id}),now);
    return{id,status:"queued",replay:false};
  });
  return sendJson(res,result.replay?200:201,{data:{id:result.id,status:result.status,testReceipt:true}});
}

/** These helpers run within the existing device claim/ack transaction. Table
 * names are fixed server constants. The device authentication, lease duration,
 * token entropy and acknowledgement replay rules remain shared with orders. */
function serviceAudit(db,device,jobId,action,details,now){
  const terminal=device.ordering_terminal_id&&db.prepare("SELECT registered_by FROM ordering_terminals WHERE id=?").get(device.ordering_terminal_id);
  if(!terminal)return; // Historical rows have no invented human/device identity.
  db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(),terminal.registered_by,"printer_job",jobId,action,JSON.stringify({actorType:"printer_service",terminalId:device.ordering_terminal_id,deviceId:device.id,...details}),now);
}
function obsolete(db,source,row,now){
  if(source.testReceipt)return row.expires_at<=now?"This sample expired before submission. Request a new sample if needed.":null;
  const order=db.prepare("SELECT status FROM orders WHERE id=?").get(row.order_id);
  if(!order||order.status==='rejected'||(!row.manual_reprint&&order.status==='completed'))return "The order no longer needs this pending kitchen receipt. History was retained; request an explicit labelled reprint if needed.";
  return null; // Intentional placed receipts and future schedules do not expire by age.
}
export function reconcilePrinterQueue(db,device,now){
  for(const source of SOURCES){
    const expiredQueued=source.testReceipt?"expires_at<=?":"EXISTS(SELECT 1 FROM orders o WHERE o.id="+source.jobs+".order_id AND (o.status='rejected' OR (o.status='completed' AND "+source.jobs+".manual_reprint=0)))";
    const pending=db.prepare(`SELECT * FROM ${source.jobs} WHERE printer_id=? AND (status IN ('claimed','dispatched') OR (status='queued' AND ${expiredQueued})) ORDER BY CASE WHEN status IN ('claimed','dispatched') THEN 0 ELSE 1 END,created_at,id LIMIT 200`).all(device.printer_id,...(source.testReceipt?[now]:[]));
    for(const row of pending){
      const reason=obsolete(db,source,row,now);
      // A legacy claimed row may already have printed without a marker. Only
      // new, provably pre-submission work can be safely cancelled or retried.
      if(reason&&(row.status==='queued'||row.status==='dispatched'&&!row.submission_started_at)){
        db.prepare(`UPDATE ${source.jobs} SET status='cancelled',lease_expires_at=NULL,detail=?,updated_at=? WHERE id=?`).run(reason,now,row.id);
        db.prepare(`DELETE FROM ${source.tokens} WHERE job_id=?`).run(row.id);
        serviceAudit(db,device,row.id,"print_job_cancelled_before_submission",{priorStatus:row.status,reason},now);continue;
      }
      if(!['claimed','dispatched'].includes(row.status)||row.status!=='claimed'&&(!row.lease_expires_at||row.lease_expires_at>now))continue;
      if(row.status==='dispatched'&&!row.submission_started_at){
        const retry=row.attempt<3,next=new Date(Date.parse(now)+5000*2**Math.max(0,row.attempt-1)).toISOString();
        db.prepare(`UPDATE ${source.jobs} SET status=?,claim_token_hash=NULL,claimed_by_device_id=NULL,lease_expires_at=NULL,available_at=?,detail=?,updated_at=? WHERE id=?`).run(retry?'queued':'failed',retry?next:null,retry?'Dispatch lease expired before submission; a bounded retry is waiting.':'Dispatch failed before submission after three attempts. Check the tablet before requesting a labelled reprint.',now,row.id);
        // Prior-attempt tokens may never authorize a late submit or ack after
        // another worker has acquired the safely retried job.
        db.prepare(`DELETE FROM ${source.tokens} WHERE job_id=?`).run(row.id);
        serviceAudit(db,device,row.id,retry?"print_job_pre_submission_retry":"print_job_pre_submission_failed",{attempt:row.attempt,availableAt:retry?next:null},now);
      }else{
        db.prepare(`UPDATE ${source.jobs} SET status='uncertain',detail='The connection ended after submission may have begun. Check the receipt; this job was not automatically retried.',lease_expires_at=NULL,updated_at=? WHERE id=?`).run(now,row.id);
        serviceAudit(db,device,row.id,"print_job_submission_uncertain",{priorStatus:row.status,submissionStartedAt:row.submission_started_at??null},now);
      }
    }
  }
}
export function claimNextPrinterJob(db,device,{now,lease,tokenHash}){
  reconcilePrinterQueue(db,device,now);
  const own=[];
  for(const source of SOURCES){const job=db.prepare(`SELECT * FROM ${source.jobs} WHERE printer_id=? AND status IN ('claimed','dispatched') AND lease_expires_at>? AND claimed_by_device_id=? ORDER BY created_at,id LIMIT 1`).get(device.printer_id,now,device.id);if(job)own.push({job,source});}
  // Replaying the device's current claim takes precedence across both sources.
  // Otherwise a newly queued order could cause a diagnostic to be dispatched
  // twice or leave a device holding two simultaneous unacknowledged jobs.
  if(own.length){own.sort((a,b)=>a.job.created_at.localeCompare(b.job.created_at)||Number(a.source.testReceipt)-Number(b.source.testReceipt)||a.job.id.localeCompare(b.job.id));const picked=own[0];db.prepare(`INSERT INTO ${picked.source.tokens}(job_id,device_id,token_hash,created_at) VALUES(?,?,?,?)`).run(picked.job.id,device.id,tokenHash,now);return picked;}
  // One physical printer may have several registered computers. Never dispatch
  // another receipt while any other computer holds an unexpired claim.
  if(SOURCES.some(source=>db.prepare(`SELECT 1 FROM ${source.jobs} WHERE printer_id=? AND status IN ('claimed','dispatched') AND lease_expires_at>?`).get(device.printer_id,now)))return null;
  // Only after every currently eligible real-order job do diagnostics enter
  // the normal transport. Terminal failed/uncertain jobs never auto-reprint.
  for(const source of SOURCES){
    const eligible=source.testReceipt?"expires_at>?":"EXISTS(SELECT 1 FROM orders o WHERE o.id="+source.jobs+".order_id AND o.status<>'rejected' AND (o.status<>'completed' OR "+source.jobs+".manual_reprint=1))";
    const job=db.prepare(`SELECT * FROM ${source.jobs} WHERE printer_id=? AND status='queued' AND (available_at IS NULL OR available_at<=?) AND ${eligible} ORDER BY created_at,id LIMIT 1`).get(device.printer_id,now,...(source.testReceipt?[now]:[]));if(!job)continue;
    const changed=db.prepare(`UPDATE ${source.jobs} SET status='dispatched',attempt=attempt+1,claim_token_hash=?,lease_expires_at=?,claimed_by_device_id=?,terminal_device_id=?,submission_started_at=NULL,spooler_job_id=NULL,available_at=NULL,updated_at=? WHERE id=? AND status='queued'`).run(tokenHash,lease,device.id,device.ordering_terminal_id??null,now,job.id);if(!changed.changes)continue;
    db.prepare(`INSERT INTO ${source.tokens}(job_id,device_id,token_hash,created_at) VALUES(?,?,?,?)`).run(job.id,device.id,tokenHash,now);
    serviceAudit(db,device,job.id,"print_job_dispatched",{attempt:job.attempt+1,testReceipt:source.testReceipt},now);
    return{job:db.prepare(`SELECT * FROM ${source.jobs} WHERE id=?`).get(job.id),source};
  }
  return null;
}

export function markPrinterJobSubmitting(db,device,{id,tokenHash,now}){
  for(const source of SOURCES){
    const row=db.prepare(`SELECT * FROM ${source.jobs} WHERE id=? AND printer_id=?`).get(id,device.printer_id);if(!row)continue;
    const issued=db.prepare(`SELECT 1 FROM ${source.tokens} WHERE job_id=? AND device_id=? AND token_hash=?`).get(id,device.id,tokenHash);
    if(!issued||row.claimed_by_device_id!==device.id)throw new HttpError(401,"INVALID_CLAIM_TOKEN","Claim token is invalid");
    if(!['claimed','dispatched'].includes(row.status)||row.lease_expires_at<=now)throw new HttpError(409,"PRINT_CLAIM_EXPIRED","The printer claim is no longer active. No receipt may be submitted.");
    const reason=obsolete(db,source,row,now);if(reason){db.prepare(`UPDATE ${source.jobs} SET status='cancelled',lease_expires_at=NULL,detail=?,updated_at=? WHERE id=?`).run(reason,now,id);serviceAudit(db,device,id,"print_job_cancelled_before_submission",{priorStatus:row.status,reason},now);return{job:db.prepare(`SELECT * FROM ${source.jobs} WHERE id=?`).get(id),source,obsolete:true};}
    if(!row.submission_started_at){db.prepare(`UPDATE ${source.jobs} SET status='dispatched',submission_started_at=?,updated_at=? WHERE id=?`).run(now,now,id);serviceAudit(db,device,id,"print_job_submission_started",{attempt:row.attempt},now);}
    return{job:db.prepare(`SELECT * FROM ${source.jobs} WHERE id=?`).get(id),source};
  }
  throw new HttpError(404,"NOT_FOUND","Resource not found");
}
export function acknowledgePrinterJob(db,device,{id,tokenHash,outcome,detail,spoolerJobId=null,legacyPrinted=false,now}){
  for(const source of SOURCES){
    const row=db.prepare(`SELECT * FROM ${source.jobs} WHERE id=? AND printer_id=?`).get(id,device.printer_id);if(!row)continue;
    const issued=db.prepare(`SELECT 1 FROM ${source.tokens} WHERE job_id=? AND device_id=? AND token_hash=?`).get(id,device.id,tokenHash);if(!issued)throw new HttpError(401,"INVALID_CLAIM_TOKEN","Claim token is invalid");
    if(row.claimed_by_device_id!==device.id)throw new HttpError(401,"INVALID_CLAIM_TOKEN","Claim token is invalid");
    if(['claimed','dispatched'].includes(row.status)&&row.lease_expires_at<=now){
      db.prepare(`UPDATE ${source.jobs} SET status='uncertain',detail='Connection was interrupted during printing. Check the paper before requesting a labelled reprint.',lease_expires_at=NULL,updated_at=? WHERE id=?`).run(now,id);
      return{job:db.prepare(`SELECT * FROM ${source.jobs} WHERE id=?`).get(id),source,expired:true};
    }
    if(["printed","submitted","failed","uncertain","cancelled"].includes(row.status)){if((row.status===outcome||row.status==='printed'&&outcome==='submitted')&&(!spoolerJobId||!row.spooler_job_id||spoolerJobId===row.spooler_job_id))return{job:row,source};throw new HttpError(409,"JOB_ALREADY_ACKNOWLEDGED","Print job was already acknowledged");}
    if(!['claimed','dispatched'].includes(row.status))throw new HttpError(409,"PRINT_CLAIM_INVALID","The printer job is not dispatched");
    if(outcome==='submitted'&&!row.submission_started_at&&!legacyPrinted)throw new HttpError(409,"PRINT_SUBMISSION_REQUIRED","The printer must record submission before reporting an accepted receipt");
    db.prepare(`UPDATE ${source.jobs} SET status=?,detail=?,spooler_job_id=?,lease_expires_at=NULL,updated_at=? WHERE id=?`).run(outcome,detail,spoolerJobId,now,id);
    serviceAudit(db,device,id,"print_job_acknowledged",{outcome,legacyReportedPrinted:legacyPrinted,spoolerJobId},now);
    return{job:db.prepare(`SELECT * FROM ${source.jobs} WHERE id=?`).get(id),source};
  }
  throw new HttpError(404,"NOT_FOUND","Resource not found");
}
