import {createHash,randomUUID} from "node:crypto";
import {withTransaction} from "./db/index.js";
import {requireRole,requireRestaurantOwner} from "./auth/authorization.js";
import {HttpError,exactObject,readJson,sendJson} from "./http.js";
import {requireLiveBankingCredential} from "./auth/password-change.js";

export const adjustmentHash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const error=(code,message,status=409)=>new HttpError(status,code,message);
export function londonDay(date){const p=Object.fromEntries(new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/London",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`;}
export function londonWeek(date){const day=londonDay(date),d=new Date(`${day}T00:00:00Z`);d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));return d.toISOString().slice(0,10);}
function week(value){if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(`${value}T00:00:00Z`))||new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)!==value||new Date(`${value}T00:00:00Z`).getUTCDay()!==1)throw error("VALIDATION_ERROR","Choose a Monday for the effective week",400);return value;}
function feature(config){if(config.businessPaymentAdjustmentsEnabled!==true)throw error("PAYMENT_ADJUSTMENTS_DISABLED","Payment adjustments await activation after review",503);if(!["stripe_test","stripe_live"].includes(config.paymentProviderMode)||!/^acct_/.test(config.stripePlatformAccountId??""))throw error("PAYMENT_ADJUSTMENTS_UNCONFIGURED","Payment connection is not ready",503);}
function idempotency(value){if(typeof value!=="string"||value.length<8||value.length>200||/[\r\n\0]/.test(value))throw error("VALIDATION_ERROR","A valid Idempotency-Key is required",400);return value;}
function audit(db,row,kind,{amountMinor=0,orderId=null,actorId=null,details={}},stamp){db.prepare("INSERT INTO business_payment_adjustment_events VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(),row.id,kind,amountMinor,orderId,actorId,JSON.stringify(details),stamp);}
export function assertAdjustmentAccount(db,config,row){
  const a=db.prepare("SELECT * FROM provider_accounts WHERE restaurant_id=? AND provider_mode=? AND provider_reference=? AND status='enabled'").get(row.restaurant_id,row.provider_mode,row.destination_account_id);
  const ready=a&&db.prepare("SELECT * FROM stripe_account_readiness WHERE restaurant_id=? AND provider_mode=? AND provider_account_id=? AND charges_enabled=1 AND payouts_enabled=1").get(row.restaurant_id,row.provider_mode,row.destination_account_id);
  let capabilities;try{capabilities=JSON.parse(a?.capabilities??"null");}catch{}
  if(row.provider_mode!==config.paymentProviderMode||row.platform_account_id!==config.stripePlatformAccountId||!a||!ready||!Array.isArray(capabilities)||!capabilities.includes("transfers")||!capabilities.includes("card_payments"))throw error("PAYMENT_ADJUSTMENT_ACCOUNT_MISMATCH","The reviewed restaurant payment account is not ready");
  return a;
}
function requireAdmin(session){return requireRole(session,"admin");}
export function createBusinessPaymentAdjustment(db,config,session,input,key){
  const actor=requireAdmin(session);feature(config);exactObject(input,["restaurantId","direction","amountMinor","reason","effectiveWeekStart"]);key=idempotency(key);
  if(config.paymentProviderMode==="stripe_live")requireLiveBankingCredential(db,actor.id);
  if(typeof input.restaurantId!=="string"||!["credit","deduction"].includes(input.direction)||!Number.isSafeInteger(input.amountMinor)||input.amountMinor<1||input.amountMinor>1000000||typeof input.reason!=="string"||input.reason.trim().length<10||input.reason.trim().length>500||/[\0]/.test(input.reason))throw error("VALIDATION_ERROR","Choose a restaurant, an amount up to £10,000 and a clear reason of 10–500 characters",400);
  const effectiveWeekStart=week(input.effectiveWeekStart),terms={restaurantId:input.restaurantId,direction:input.direction,amountMinor:input.amountMinor,reason:input.reason.trim(),effectiveWeekStart},hash=adjustmentHash(terms),stamp=config.now().toISOString();
  return withTransaction(db,()=>{
    const existing=db.prepare("SELECT * FROM business_payment_adjustments WHERE created_by_user_id=? AND creation_key=?").get(actor.id,key);
    if(existing){if(existing.payload_hash!==hash)throw error("IDEMPOTENCY_CONFLICT","This request key was already used for different adjustment details");return existing;}
    if(effectiveWeekStart<londonWeek(config.now()))throw error("VALIDATION_ERROR","Adjustments start this week or a future week",400);
    const account=db.prepare("SELECT * FROM provider_accounts WHERE restaurant_id=?").get(terms.restaurantId);
    if(!account)throw error("PAYMENT_ADJUSTMENT_ACCOUNT_MISMATCH","Restaurant bank setup is required");
    const row={id:randomUUID(),restaurant_id:terms.restaurantId,provider_mode:config.paymentProviderMode,platform_account_id:config.stripePlatformAccountId,destination_account_id:account.provider_reference};assertAdjustmentAccount(db,config,row);
    const reference=`ADJ-${row.id.slice(0,8).toUpperCase()}`;
    db.prepare(`INSERT INTO business_payment_adjustments(id,reference,restaurant_id,direction,amount_minor,currency,reason,effective_week_start,provider_mode,platform_account_id,destination_account_id,status,created_by_user_id,creation_key,payload_hash,created_at,updated_at) VALUES(?,?,?,?,?,'GBP',?,?,?,?,?,'draft',?,?,?,?,?)`).run(row.id,reference,terms.restaurantId,terms.direction,terms.amountMinor,terms.reason,effectiveWeekStart,row.provider_mode,row.platform_account_id,row.destination_account_id,actor.id,key,hash,stamp,stamp);
    const saved=db.prepare("SELECT * FROM business_payment_adjustments WHERE id=?").get(row.id);audit(db,saved,"created",{actorId:actor.id,details:{payloadHash:hash}},stamp);return saved;
  });
}
export function reviewBusinessPaymentAdjustment(db,config,session,id,input){
  const actor=requireAdmin(session);feature(config);exactObject(input,["decision","note"]);
  if(config.paymentProviderMode==="stripe_live")requireLiveBankingCredential(db,actor.id);
  if(!["approve","reject"].includes(input.decision)||typeof input.note!=="string"||input.note.trim().length<3||input.note.trim().length>500)throw error("VALIDATION_ERROR","Record a review note",400);
  return withTransaction(db,()=>{const row=db.prepare("SELECT * FROM business_payment_adjustments WHERE id=?").get(id);if(!row)throw error("NOT_FOUND","Adjustment not found",404);assertAdjustmentAccount(db,config,row);if(row.status!=="draft")throw error("ADJUSTMENT_ALREADY_REVIEWED","Only a draft can be reviewed");const stamp=config.now().toISOString();db.prepare("UPDATE business_payment_adjustments SET status=?,reviewed_by_user_id=?,review_note=?,reviewed_at=?,updated_at=? WHERE id=?").run(input.decision==="approve"?"reviewed":"rejected",actor.id,input.note.trim(),stamp,stamp,id);audit(db,row,input.decision==="approve"?"reviewed":"rejected",{actorId:actor.id,details:{note:input.note.trim(),payloadHash:row.payload_hash}},stamp);return db.prepare("SELECT * FROM business_payment_adjustments WHERE id=?").get(id);});
}
export function confirmBusinessPaymentAdjustment(db,config,session,id,key){
  const actor=requireAdmin(session);feature(config);key=idempotency(key);
  if(config.paymentProviderMode==="stripe_live")requireLiveBankingCredential(db,actor.id);
  return withTransaction(db,()=>{const row=db.prepare("SELECT * FROM business_payment_adjustments WHERE id=?").get(id);if(!row)throw error("NOT_FOUND","Adjustment not found",404);assertAdjustmentAccount(db,config,row);if(row.status==="confirmed"){if(row.confirmation_key!==key)throw error("IDEMPOTENCY_CONFLICT","This adjustment was already confirmed");return row;}if(row.status!=="reviewed"||!row.reviewed_by_user_id||!row.reviewed_at)throw error("ADJUSTMENT_REVIEW_REQUIRED","Review this adjustment before confirming it");const stamp=config.now().toISOString();db.prepare("UPDATE business_payment_adjustments SET status='confirmed',confirmed_by_user_id=?,confirmation_key=?,confirmed_at=?,updated_at=? WHERE id=?").run(actor.id,key,stamp,stamp,id);audit(db,row,"confirmed",{actorId:actor.id,details:{payloadHash:row.payload_hash}},stamp);
    if(row.direction==="credit"){
      const operationKey=`business-adjustment:${row.provider_mode}:${row.id}`,payload={adjustmentId:row.id,restaurantId:row.restaurant_id,amountMinor:row.amount_minor,currency:"GBP",providerMode:row.provider_mode,platformAccountId:row.platform_account_id,accountId:row.destination_account_id,transferGroup:`adjustment:${row.id}`,operationKey},body=JSON.stringify(payload);
      db.prepare("INSERT INTO business_payment_credit_jobs(adjustment_id,operation_key,payload,payload_hash,status,available_at,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?,?)").run(id,operationKey,body,adjustmentHash(payload),stamp,stamp,stamp);
      db.prepare("INSERT INTO marketplace_operations VALUES(?,?,?,NULL,'business_adjustment_credit','pending',?,'GBP',?,NULL,NULL,?,?,?)").run(randomUUID(),operationKey,row.restaurant_id,row.amount_minor,row.provider_mode,body,stamp,stamp);
    }return db.prepare("SELECT * FROM business_payment_adjustments WHERE id=?").get(id);
  });
}

// Called only inside the new settlement transaction. A saved transfer job is
// never resized: its provider idempotency key continues to identify one payload.
export function reserveSettlementAdjustments(db,config,payload){
  if(config.businessPaymentAdjustmentsEnabled!==true)return payload;
  const existing=db.prepare("SELECT 1 FROM business_payment_settlements s WHERE order_id=? AND NOT EXISTS(SELECT 1 FROM business_payment_settlement_cancellations c WHERE c.operation_key=s.operation_key)").get(payload.orderId);if(existing)throw error("SETTLEMENT_ALREADY_RESERVED","A settlement was already reserved");
  const revisions=db.prepare("SELECT COUNT(*) n FROM business_payment_settlements WHERE order_id=?").get(payload.orderId).n,operationKey=`stripe-transfer:${payload.providerMode}:${payload.orderId}${revisions?`:revision:${revisions}`:""}`;
  const rows=db.prepare(`SELECT a.*,COALESCE((SELECT SUM(x.amount_minor-x.restored_minor-x.released_minor) FROM business_payment_adjustment_allocations x WHERE x.adjustment_id=a.id),0) allocated FROM business_payment_adjustments a WHERE restaurant_id=? AND direction='deduction' AND status='confirmed' AND provider_mode=? AND platform_account_id=? AND destination_account_id=? AND effective_week_start<=? ORDER BY effective_week_start,confirmed_at,id`).all(payload.restaurantId,payload.providerMode,payload.platformAccountId,payload.accountId,londonDay(config.now()));
  let remaining=payload.amountMinor;const allocations=[],stamp=config.now().toISOString();
  for(const row of rows){const amountMinor=Math.min(remaining,row.amount_minor-row.allocated);if(amountMinor<=0)continue;assertAdjustmentAccount(db,config,row);const id=randomUUID();db.prepare("INSERT INTO business_payment_adjustment_allocations(id,adjustment_id,order_id,settlement_operation_key,amount_minor,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(id,row.id,payload.orderId,operationKey,amountMinor,stamp,stamp);allocations.push({id,adjustmentId:row.id,amountMinor});remaining-=amountMinor;audit(db,row,"deduction_reserved",{amountMinor,orderId:payload.orderId},stamp);if(!remaining)break;}
  if(!allocations.length&&!revisions)return payload;
  const next={...payload,settlementOperationKey:operationKey,originalNetMinor:payload.amountMinor,deductionMinor:payload.amountMinor-remaining,amountMinor:remaining,adjustmentAllocations:allocations};
  const hash=adjustmentHash(next);next.settlementHash=hash;
  db.prepare("INSERT INTO business_payment_settlements VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(next.orderId,next.restaurantId,next.providerMode,next.platformAccountId,next.accountId,operationKey,next.originalNetMinor,next.deductionMinor,next.amountMinor,JSON.stringify(next.refundIds),hash,stamp);return next;
}
export function validateSettlementAdjustment(db,payload){
  const row=db.prepare("SELECT * FROM business_payment_settlements WHERE order_id=? AND operation_key=?").get(payload.orderId,payload.settlementOperationKey??"");
  if(!row){if(payload.settlementHash||payload.deductionMinor||payload.adjustmentAllocations||db.prepare("SELECT 1 FROM business_payment_settlements WHERE order_id=?").get(payload.orderId))throw error("STRIPE_RESULT_MISMATCH","Missing deduction settlement snapshot");return 0;}
  const {settlementHash,...terms}=payload;
  const allocations=db.prepare("SELECT * FROM business_payment_adjustment_allocations WHERE order_id=? AND settlement_operation_key=? ORDER BY rowid").all(payload.orderId,row.operation_key);
  if(settlementHash!==row.snapshot_hash||adjustmentHash(terms)!==row.snapshot_hash||payload.amountMinor!==row.transfer_minor||payload.originalNetMinor!==row.original_net_minor||payload.deductionMinor!==row.deduction_minor||payload.providerMode!==row.provider_mode||payload.platformAccountId!==row.platform_account_id||payload.accountId!==row.destination_account_id||payload.restaurantId!==row.restaurant_id||allocations.reduce((n,x)=>n+x.amount_minor,0)!==row.deduction_minor||JSON.stringify(allocations.map(x=>({id:x.id,adjustmentId:x.adjustment_id,amountMinor:x.amount_minor})))!==JSON.stringify(payload.adjustmentAllocations))throw error("STRIPE_RESULT_MISMATCH","Deduction settlement snapshot does not match the reviewed allocation");
  return row.deduction_minor;
}
export function assertAdjustedSettlementDispatch(db,config,payload,operationKey,job,workerId){
  if(!payload.settlementHash)return;
  withTransaction(db,()=>{
    validateSettlementAdjustment(db,payload);
    if(payload.settlementOperationKey!==operationKey||db.prepare("SELECT 1 FROM business_payment_settlement_cancellations WHERE operation_key=?").get(operationKey))throw error("STRIPE_TRANSFER_INELIGIBLE","This unsent settlement was cancelled");
    if(!db.prepare("SELECT 1 FROM marketplace_worker_jobs WHERE id=? AND status='claimed' AND lease_owner=? AND lease_expires_at>?").get(job.id,workerId,config.now().toISOString()))throw error("WORKER_LEASE_LOST","Settlement worker lease was lost");
    const dispatch=db.prepare("SELECT * FROM business_payment_settlement_dispatches WHERE operation_key=?").get(operationKey);
    if(dispatch&&(dispatch.snapshot_hash!==payload.settlementHash||config.now().getTime()-Date.parse(dispatch.dispatched_at)>=20*3600000))throw error("STRIPE_TRANSFER_RECONCILIATION_REQUIRED","An earlier transfer needs confirmation before another provider request");
    db.prepare("INSERT OR IGNORE INTO business_payment_settlement_dispatches VALUES(?,?,?)").run(operationKey,payload.settlementHash,config.now().toISOString());
  });
}
export function cancelRefundedUndispatchedSettlement(db,orderId,stamp){
  if(!db.isTransaction)return withTransaction(db,()=>cancelRefundedUndispatchedSettlement(db,orderId,stamp));
  const s=db.prepare("SELECT * FROM business_payment_settlements s WHERE order_id=? AND NOT EXISTS(SELECT 1 FROM business_payment_settlement_cancellations c WHERE c.operation_key=s.operation_key) ORDER BY s.rowid DESC LIMIT 1").get(orderId);if(!s)return false;
  const op=db.prepare("SELECT * FROM marketplace_operations WHERE operation_key=?").get(s.operation_key),job=db.prepare("SELECT * FROM marketplace_worker_jobs WHERE operation_key=?").get(s.operation_key);
  if(!op||!job||op.status==="confirmed"||op.provider_reference||db.prepare("SELECT 1 FROM business_payment_settlement_dispatches WHERE operation_key=?").get(s.operation_key))return false;
  const order=db.prepare("SELECT total_minor,commission_minor FROM orders WHERE id=?").get(orderId),refund=db.prepare("SELECT COALESCE(SUM(food_amount_minor+delivery_amount_minor),0) n,COALESCE(SUM(commission_reversal_minor),0) c FROM refunds WHERE order_id=?").get(orderId),net=order.total_minor-refund.n-Math.max(0,order.commission_minor-refund.c);if(net===s.original_net_minor)return false;
  db.prepare("INSERT INTO business_payment_settlement_cancellations VALUES(?,'CONFIRMED_REFUND_BEFORE_DISPATCH',?,?)").run(s.operation_key,s.snapshot_hash,stamp);
  db.prepare("UPDATE marketplace_operations SET status='cancelled',error='SETTLEMENT_CANCELLED_BEFORE_DISPATCH',updated_at=? WHERE operation_key=?").run(stamp,s.operation_key);
  db.prepare("UPDATE marketplace_worker_jobs SET status='completed',error='SETTLEMENT_CANCELLED_BEFORE_DISPATCH',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE operation_key=?").run(stamp,s.operation_key);
  for(const row of db.prepare("SELECT * FROM business_payment_adjustment_allocations WHERE settlement_operation_key=?").all(s.operation_key)){
    if(row.applied_minor||row.restored_minor)throw error("SETTLEMENT_CANCELLATION_INVALID","Applied earnings cannot be released without reconciliation");
    const amountMinor=row.amount_minor-row.released_minor;if(!amountMinor)continue;db.prepare("UPDATE business_payment_adjustment_allocations SET released_minor=amount_minor,updated_at=? WHERE id=?").run(stamp,row.id);const a=db.prepare("SELECT * FROM business_payment_adjustments WHERE id=?").get(row.adjustment_id);audit(db,a,"deduction_released",{amountMinor,orderId,details:{cancelledOperationKey:s.operation_key,proof:"no_dispatch_record"}},stamp);
  }return true;
}
function journal(db,{operationKey,restaurantId,orderId=null,amountMinor,kind,reference,providerMode,debit,credit,stamp}){
  if(!amountMinor||db.prepare("SELECT 1 FROM journal_postings WHERE operation_key=?").get(operationKey))return;
  db.prepare("INSERT OR IGNORE INTO marketplace_operations VALUES(?,?,?,?,?,'confirmed',?,'GBP',?,NULL,NULL,?,?,?)").run(randomUUID(),operationKey,restaurantId,orderId,kind,amountMinor,providerMode,JSON.stringify({adjustmentId:reference}),stamp,stamp);
  const op=db.prepare("SELECT * FROM marketplace_operations WHERE operation_key=?").get(operationKey);
  if(op.restaurant_id!==restaurantId||op.order_id!==orderId||op.amount_minor!==amountMinor||op.provider_mode!==providerMode||op.kind!==kind)throw error("PAYMENT_ADJUSTMENT_LEDGER_MISMATCH","Adjustment journal does not match its saved instruction");
  const group=randomUUID();for(const [account,direction]of[[debit,"debit"],[credit,"credit"]])db.prepare("INSERT INTO journal_postings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(),group,operationKey,restaurantId,orderId,account,direction,amountMinor,"GBP",kind,reference,providerMode,stamp);
}
export function applySettlementAdjustments(db,payload,stamp){
  if(!db.isTransaction)return withTransaction(db,()=>applySettlementAdjustments(db,payload,stamp));
  if(!validateSettlementAdjustment(db,payload))return;
  for(const entry of payload.adjustmentAllocations){const row=db.prepare("SELECT * FROM business_payment_adjustment_allocations WHERE id=?").get(entry.id);if(row.applied_minor)continue;const adjustment=db.prepare("SELECT * FROM business_payment_adjustments WHERE id=?").get(row.adjustment_id);db.prepare("UPDATE business_payment_adjustment_allocations SET applied_minor=amount_minor,applied_at=?,updated_at=? WHERE id=? AND applied_minor=0").run(stamp,stamp,row.id);journal(db,{operationKey:`adjustment-applied:${row.id}`,restaurantId:payload.restaurantId,orderId:payload.orderId,amountMinor:row.amount_minor,kind:"business_adjustment_deduction",reference:row.adjustment_id,providerMode:payload.providerMode,debit:"merchant_available",credit:"platform_adjustment_recovery",stamp});audit(db,adjustment,"deduction_applied",{amountMinor:row.amount_minor,orderId:payload.orderId},stamp);}
}
// Refunds first restore deductions back to future earnings, then recover only
// the remainder from the actual transfer. Original commission is never edited.
export function restoreRefundedSettlementAdjustments(db,orderId,stamp){
  if(!db.isTransaction)return withTransaction(db,()=>restoreRefundedSettlementAdjustments(db,orderId,stamp));
  cancelRefundedUndispatchedSettlement(db,orderId,stamp);
  const snapshot=db.prepare("SELECT * FROM business_payment_settlements s WHERE order_id=? AND NOT EXISTS(SELECT 1 FROM business_payment_settlement_cancellations c WHERE c.operation_key=s.operation_key) ORDER BY s.rowid DESC LIMIT 1").get(orderId);if(!snapshot)return 0;
  const included=new Set(JSON.parse(snapshot.refund_ids));const refunds=db.prepare("SELECT * FROM refunds WHERE order_id=? ORDER BY rowid").all(orderId).filter(x=>!included.has(x.id));
  const recovery=refunds.reduce((n,x)=>n+x.food_amount_minor+x.delivery_amount_minor-x.commission_reversal_minor,0),target=Math.min(snapshot.deduction_minor,Math.max(0,recovery));let restored=db.prepare("SELECT COALESCE(SUM(restored_minor),0) n FROM business_payment_adjustment_allocations WHERE settlement_operation_key=?").get(snapshot.operation_key).n,remaining=target-restored;
  for(const row of db.prepare("SELECT * FROM business_payment_adjustment_allocations WHERE settlement_operation_key=? ORDER BY rowid").all(snapshot.operation_key)){const amountMinor=Math.min(remaining,row.applied_minor-row.restored_minor);if(amountMinor<=0)continue;db.prepare("UPDATE business_payment_adjustment_allocations SET restored_minor=restored_minor+?,restored_at=?,updated_at=? WHERE id=?").run(amountMinor,stamp,stamp,row.id);const adjustment=db.prepare("SELECT * FROM business_payment_adjustments WHERE id=?").get(row.adjustment_id);journal(db,{operationKey:`adjustment-restored:${row.id}:${row.restored_minor+amountMinor}`,restaurantId:snapshot.restaurant_id,orderId,amountMinor,kind:"business_adjustment_restoration",reference:row.adjustment_id,providerMode:snapshot.provider_mode,debit:"platform_adjustment_recovery",credit:"merchant_recovery",stamp});audit(db,adjustment,"deduction_restored",{amountMinor,orderId,details:{cumulativeRefundRecoveryMinor:recovery}},stamp);remaining-=amountMinor;restored+=amountMinor;}
  return restored;
}
export function adjustedRefundRecoveryMinor(db,orderId,refundId,originalAmount){
  const snapshot=db.prepare("SELECT * FROM business_payment_settlements s WHERE order_id=? AND NOT EXISTS(SELECT 1 FROM business_payment_settlement_cancellations c WHERE c.operation_key=s.operation_key) ORDER BY s.rowid DESC LIMIT 1").get(orderId);if(!snapshot)return originalAmount;
  const included=new Set(JSON.parse(snapshot.refund_ids));if(included.has(refundId))return 0;
  let preceding=0;for(const row of db.prepare("SELECT * FROM refunds WHERE order_id=? ORDER BY rowid").all(orderId)){if(included.has(row.id))continue;const net=Math.max(0,row.food_amount_minor+row.delivery_amount_minor-row.commission_reversal_minor);if(row.id===refundId)return net-(Math.min(snapshot.deduction_minor,preceding+net)-Math.min(snapshot.deduction_minor,preceding));preceding+=net;}throw error("REFUND_NOT_FOUND","Refund recovery needs a saved refund");
}

export async function routeBusinessPaymentAdjustments({req,res,url,db,config,session}){
  const match=/^\/api\/(admin|owner)\/business-payment-adjustments(?:\/([^/]+)\/(review|confirm))?(\/export\.csv)?$/.exec(url.pathname);if(!match)return false;
  const admin=match[1]==="admin";if(admin)requireAdmin(session);else{if(req.method!=="GET")throw error("FORBIDDEN","Owner adjustments are read only",403);requireRole(session,"restaurant","admin");}
  if(req.method==="GET"){
    const restaurantId=url.searchParams.get("restaurantId");if(!admin){if(!restaurantId)throw error("VALIDATION_ERROR","Choose a restaurant",400);requireRestaurantOwner(db,session,restaurantId);}
    const {listBusinessPaymentAdjustments,exportBusinessPaymentAdjustmentsCsv}=await import("./business-payment-adjustment-reporting.js");
    const result=listBusinessPaymentAdjustments(db,{restaurantId,providerMode:config.paymentProviderMode,platformAccountId:config.stripePlatformAccountId,weekStart:url.searchParams.get("weekStart")||undefined,page:match[4]?1:Number(url.searchParams.get("page")||1),pageSize:match[4]?10000:Number(url.searchParams.get("pageSize")||25),exportMode:Boolean(match[4]),includeDrafts:admin,now:config.now()});
    if(match[4]){const csv=exportBusinessPaymentAdjustmentsCsv(result.items,{asOf:result.positionGeneratedAt});res.writeHead(200,{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":"attachment; filename=business-payment-adjustments.csv"});res.end(csv);return true;}
    sendJson(res,200,{data:{...result,enabled:config.businessPaymentAdjustmentsEnabled===true}});return true;
  }
  if(!admin||req.method!=="POST")return false;
  const input=await readJson(req,config.bodyLimit);let row;
  if(!match[2])row=createBusinessPaymentAdjustment(db,config,session,input,req.headers["idempotency-key"]);
  else if(match[3]==="review")row=reviewBusinessPaymentAdjustment(db,config,session,match[2],input);
  else{exactObject(input,[]);row=confirmBusinessPaymentAdjustment(db,config,session,match[2],req.headers["idempotency-key"]);}
  sendJson(res,200,{data:{id:row.id,status:row.status,reference:row.reference}});return true;
}

export function confirmBusinessCredit(db,row,job,result,stamp){
  if(row.applied_minor===row.amount_minor)return;
  db.prepare("UPDATE business_payment_adjustments SET applied_minor=amount_minor,applied_at=?,updated_at=? WHERE id=? AND status='confirmed' AND applied_minor=0").run(stamp,stamp,row.id);
  db.prepare("UPDATE marketplace_operations SET status='confirmed',provider_reference=?,error=NULL,updated_at=? WHERE operation_key=?").run(result.providerReference,stamp,job.operation_key);
  journal(db,{operationKey:job.operation_key,restaurantId:row.restaurant_id,amountMinor:row.amount_minor,kind:"business_adjustment_credit",reference:row.id,providerMode:row.provider_mode,debit:"platform_adjustment_funding",credit:"connected_account_funds",stamp});audit(db,row,"credit_applied",{amountMinor:row.amount_minor,details:{providerReference:result.providerReference}},stamp);
  db.prepare("UPDATE business_payment_credit_jobs SET status='confirmed',provider_reference=?,last_error=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE adjustment_id=?").run(result.providerReference,stamp,row.id);
}
export function assertBusinessCreditResult(db,config,row,job,result){
  const payload=JSON.parse(job.payload);assertAdjustmentAccount(db,config,row);
  if(adjustmentHash(payload)!==job.payload_hash||payload.adjustmentId!==row.id||payload.restaurantId!==row.restaurant_id||payload.providerMode!==row.provider_mode||payload.platformAccountId!==row.platform_account_id||payload.accountId!==row.destination_account_id||payload.amountMinor!==row.amount_minor||payload.operationKey!==job.operation_key||payload.transferGroup!==`adjustment:${row.id}`||row.status!=="confirmed"||row.direction!=="credit")throw error("PAYMENT_ADJUSTMENT_BINDING_MISMATCH","Credit does not match the reviewed instruction");
  if(result&&(result.ok===false||result.status!=="confirmed"||result.amountMinor!==row.amount_minor||String(result.currency).toUpperCase()!=="GBP"||!/^tr_/.test(result.providerReference??"")||result.destinationAccountId!==row.destination_account_id||result.sourceTransactionId!=null||result.transferGroup!==payload.transferGroup||result.operationKey!==job.operation_key||result.adjustmentId!==row.id||result.restaurantId!==row.restaurant_id))throw error("PAYMENT_ADJUSTMENT_RESULT_MISMATCH","Payment confirmation does not match the reviewed credit");return payload;
}
