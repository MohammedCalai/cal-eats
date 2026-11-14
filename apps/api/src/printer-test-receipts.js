import {randomUUID} from "node:crypto";
import {requireRestaurantOwner} from "./auth/authorization.js";
import {withTransaction} from "./db/index.js";
import {HttpError,exactObject,readJson,sendJson} from "./http.js";

const SOURCES=[{jobs:"device_print_jobs",tokens:"printer_job_claim_tokens",testReceipt:false},{jobs:"printer_test_jobs",tokens:"printer_test_job_claim_tokens",testReceipt:true}];
const dto=row=>row?{id:row.id,status:row.status,detail:row.detail??null,createdAt:row.created_at,updatedAt:row.updated_at}:null;
export function latestPrinterTestReceipt(db,printerId){return dto(db.prepare("SELECT id,status,detail,created_at,updated_at FROM printer_test_jobs WHERE printer_id=? ORDER BY created_at DESC,id DESC LIMIT 1").get(printerId));}

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
    if(db.prepare("SELECT 1 FROM printer_test_jobs WHERE printer_id=? AND status IN ('queued','claimed')").get(printerId))throw new HttpError(409,"PRINTER_TEST_PENDING","A printer test is already waiting or printing. Wait for its result before sending another.");
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
export function claimNextPrinterJob(db,device,{now,lease,tokenHash}){
  db.prepare("UPDATE printer_test_jobs SET status='failed',detail='This test expired before the printer was ready. Send a new test.',updated_at=? WHERE printer_id=? AND status='queued' AND expires_at<=?").run(now,device.printer_id,now);
  const stale=new Date(Date.parse(now)-86400000).toISOString();
  db.prepare("UPDATE device_print_jobs SET status='failed',detail='This receipt is more than 24 hours old. Use a labelled manual reprint if needed.',updated_at=? WHERE printer_id=? AND status='queued' AND created_at<?").run(now,device.printer_id,stale);
  for(const source of SOURCES)db.prepare(`UPDATE ${source.jobs} SET status='uncertain',detail='Connection was interrupted during printing. Check the paper before requesting a labelled reprint.',lease_expires_at=NULL,updated_at=? WHERE printer_id=? AND status='claimed' AND lease_expires_at<=?`).run(now,device.printer_id,now);
  const own=[];
  for(const source of SOURCES){const job=db.prepare(`SELECT * FROM ${source.jobs} WHERE printer_id=? AND status='claimed' AND lease_expires_at>? AND claimed_by_device_id=? ORDER BY created_at,id LIMIT 1`).get(device.printer_id,now,device.id);if(job)own.push({job,source});}
  // Replaying the device's current claim takes precedence across both sources.
  // Otherwise a newly queued order could cause a diagnostic to be dispatched
  // twice or leave a device holding two simultaneous unacknowledged jobs.
  if(own.length){own.sort((a,b)=>a.job.created_at.localeCompare(b.job.created_at)||Number(a.source.testReceipt)-Number(b.source.testReceipt)||a.job.id.localeCompare(b.job.id));const picked=own[0];db.prepare(`INSERT INTO ${picked.source.tokens}(job_id,device_id,token_hash,created_at) VALUES(?,?,?,?)`).run(picked.job.id,device.id,tokenHash,now);return picked;}
  // One physical printer may have several registered computers. Never dispatch
  // another receipt while any other computer holds an unexpired claim.
  if(SOURCES.some(source=>db.prepare(`SELECT 1 FROM ${source.jobs} WHERE printer_id=? AND status='claimed' AND lease_expires_at>?`).get(device.printer_id,now)))return null;
  // Only after every currently eligible real-order job do diagnostics enter
  // the normal transport. Terminal failed/uncertain jobs never auto-reprint.
  for(const source of SOURCES){
    const job=db.prepare(`SELECT * FROM ${source.jobs} WHERE printer_id=? AND status='queued' ORDER BY created_at,id LIMIT 1`).get(device.printer_id);if(!job)continue;
    const changed=db.prepare(`UPDATE ${source.jobs} SET status='claimed',attempt=attempt+1,claim_token_hash=?,lease_expires_at=?,claimed_by_device_id=?,updated_at=? WHERE id=? AND (status='queued' OR (status='claimed' AND lease_expires_at<=?))`).run(tokenHash,lease,device.id,now,job.id,now);if(!changed.changes)continue;
    db.prepare(`INSERT INTO ${source.tokens}(job_id,device_id,token_hash,created_at) VALUES(?,?,?,?)`).run(job.id,device.id,tokenHash,now);
    return{job:db.prepare(`SELECT * FROM ${source.jobs} WHERE id=?`).get(job.id),source};
  }
  return null;
}

export function acknowledgePrinterJob(db,device,{id,tokenHash,outcome,detail,now}){
  for(const source of SOURCES){
    const row=db.prepare(`SELECT * FROM ${source.jobs} WHERE id=? AND printer_id=?`).get(id,device.printer_id);if(!row)continue;
    const issued=db.prepare(`SELECT 1 FROM ${source.tokens} WHERE job_id=? AND device_id=? AND token_hash=?`).get(id,device.id,tokenHash);if(!issued)throw new HttpError(401,"INVALID_CLAIM_TOKEN","Claim token is invalid");
    if(row.status==='claimed'&&row.lease_expires_at<=now){
      db.prepare(`UPDATE ${source.jobs} SET status='uncertain',detail='Connection was interrupted during printing. Check the paper before requesting a labelled reprint.',lease_expires_at=NULL,updated_at=? WHERE id=?`).run(now,id);
      return{job:db.prepare(`SELECT * FROM ${source.jobs} WHERE id=?`).get(id),source,expired:true};
    }
    if(["printed","failed","uncertain"].includes(row.status)){if(row.status===outcome)return{job:row,source};throw new HttpError(409,"JOB_ALREADY_ACKNOWLEDGED","Print job was already acknowledged");}
    db.prepare(`UPDATE ${source.jobs} SET status=?,detail=?,lease_expires_at=NULL,updated_at=? WHERE id=?`).run(outcome,detail,now,id);
    return{job:db.prepare(`SELECT * FROM ${source.jobs} WHERE id=?`).get(id),source};
  }
  throw new HttpError(404,"NOT_FOUND","Resource not found");
}
