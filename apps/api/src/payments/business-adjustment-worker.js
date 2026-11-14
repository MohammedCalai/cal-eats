import {randomUUID} from "node:crypto";
import {withTransaction} from "../db/index.js";
import {ensureStripePlatform} from "./stripe-connect.js";
import {assertBusinessCreditResult,confirmBusinessCredit,londonDay} from "../business-payment-adjustments.js";

const fault=code=>Object.assign(new Error(code),{code});
const leases=new WeakMap();
export function runBusinessAdjustmentCredits(db,config,options={}){
  if(leases.has(db))return leases.get(db);
  const task=run(db,config,options).finally(()=>leases.delete(db));leases.set(db,task);return task;
}
async function run(db,config,{limit=10,workerId=randomUUID()}={}){
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new TypeError("Credit worker limit is invalid");
  const summary={claimed:0,confirmed:0,pending:0,held:0};if(config.businessPaymentAdjustmentsEnabled!==true)return summary;
  const adapter=config.stripeProvider??config.paymentProvider;if(!adapter||adapter.mode!==config.paymentProviderMode||typeof adapter.createAdjustmentTransfer!=="function"||typeof adapter.retrieveAvailableBalance!=="function")return summary;
  await ensureStripePlatform(config);
  for(let n=0;n<limit;n++){
    const stamp=config.now().toISOString();
    const job=withTransaction(db,()=>{
      const candidate=db.prepare(`SELECT j.* FROM business_payment_credit_jobs j JOIN business_payment_adjustments a ON a.id=j.adjustment_id WHERE a.provider_mode=? AND a.platform_account_id=? AND a.status='confirmed' AND a.effective_week_start<=? AND (j.status IN ('queued','unknown') AND j.available_at<=? OR j.status='claimed' AND j.lease_expires_at<=?) ORDER BY j.created_at,j.adjustment_id LIMIT 1`).get(config.paymentProviderMode,config.stripePlatformAccountId,londonDay(config.now()),stamp,stamp);
      if(!candidate)return null;
      // Stripe can expire an idempotency key after 24 hours. An unresolved
      // dispatch is held before then instead of risking a second transfer.
      if(candidate.attempts>=5||(candidate.dispatch_started_at&&!candidate.provider_reference&&config.now().getTime()-Date.parse(candidate.dispatch_started_at)>=20*3600000)){
        db.prepare("UPDATE business_payment_credit_jobs SET status='held',last_error='CREDIT_RECONCILIATION_REQUIRED',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE adjustment_id=?").run(stamp,candidate.adjustment_id);return {...candidate,held:true};
      }
      db.prepare("UPDATE business_payment_credit_jobs SET status='claimed',lease_owner=?,lease_expires_at=?,attempts=attempts+1,updated_at=? WHERE adjustment_id=?").run(workerId,new Date(config.now().getTime()+120000).toISOString(),stamp,candidate.adjustment_id);return db.prepare("SELECT * FROM business_payment_credit_jobs WHERE adjustment_id=?").get(candidate.adjustment_id);
    });
    if(!job)break;if(job.held){summary.held++;continue;}summary.claimed++;
    const row=db.prepare("SELECT * FROM business_payment_adjustments WHERE id=?").get(job.adjustment_id);
    try{
      const payload=assertBusinessCreditResult(db,config,row,job);
      let result;
      if(job.provider_reference)result=await adapter.retrieveTransfer({transferId:job.provider_reference});
      else{
        const account=await adapter.refreshConnectedAccount({accountId:row.destination_account_id});
        if(account?.ok===false||account.providerReference!==row.destination_account_id||!account.chargesEnabled||!account.payoutsEnabled)throw fault("PAYMENT_ADJUSTMENT_ACCOUNT_MISMATCH");
        if(!job.dispatch_started_at){
        const balance=await adapter.retrieveAvailableBalance();
        if(balance?.ok===false||balance.status!=="confirmed"||balance.mode!==row.provider_mode||balance.currency!=="GBP"||!Number.isSafeInteger(balance.availableMinor)||balance.availableMinor<0)throw fault("CREDIT_FUNDING_UNVERIFIED");
        const other=db.prepare(`SELECT COALESCE(SUM(a.amount_minor),0) n FROM business_payment_credit_jobs j JOIN business_payment_adjustments a ON a.id=j.adjustment_id WHERE a.provider_mode=? AND a.platform_account_id=? AND j.adjustment_id<>? AND (j.status='claimed' OR j.status IN ('unknown','held') AND j.dispatch_started_at IS NOT NULL) AND j.provider_reference IS NULL`).get(row.provider_mode,row.platform_account_id,row.id).n;
        const commitments=db.prepare("SELECT amount_minor,metadata FROM marketplace_operations WHERE provider_mode=? AND kind='merchant_transfer' AND status NOT IN ('confirmed','cancelled')").all(row.provider_mode).reduce((sum,x)=>{let m;try{m=JSON.parse(x.metadata);}catch{return sum;}return m.fundingSource==="platform_balance"&&m.platformAccountId===row.platform_account_id?sum+x.amount_minor:sum;},0);
        if(balance.availableMinor<row.amount_minor+other+commitments)throw fault("CREDIT_AWAITING_AVAILABLE_FUNDS");
        }
        withTransaction(db,()=>{assertLease(db,job,workerId,config.now().toISOString());assertBusinessCreditResult(db,config,row,job);db.prepare("UPDATE business_payment_credit_jobs SET dispatch_started_at=COALESCE(dispatch_started_at,?),updated_at=? WHERE adjustment_id=?").run(stamp,stamp,row.id);});
        result=await adapter.createAdjustmentTransfer({...payload,idempotencyKey:job.operation_key});
      }
      if(result?.status==="confirmed"&&result.ok!==false){
        assertBusinessCreditResult(db,config,row,job,result);
        withTransaction(db,()=>{assertLease(db,job,workerId,config.now().toISOString());confirmBusinessCredit(db,row,job,result,config.now().toISOString());});summary.confirmed++;
      }else{
        const reference=result?.providerReference??null;if(reference&&!/^tr_[A-Za-z0-9_]+$/.test(reference))throw fault("PAYMENT_ADJUSTMENT_RESULT_MISMATCH");
        withTransaction(db,()=>{assertLease(db,job,workerId,config.now().toISOString());db.prepare("UPDATE business_payment_credit_jobs SET status='unknown',provider_reference=COALESCE(?,provider_reference),available_at=?,last_error=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE adjustment_id=?").run(reference,new Date(config.now().getTime()+60000).toISOString(),result?.ok===false&&result.status==="failed"?"CREDIT_PROVIDER_REJECTED":"CREDIT_CONFIRMATION_PENDING",config.now().toISOString(),row.id);if(reference)db.prepare("UPDATE marketplace_operations SET provider_reference=COALESCE(?,provider_reference),status=CASE WHEN status='confirmed' THEN status ELSE 'unknown' END,updated_at=? WHERE operation_key=?").run(reference,config.now().toISOString(),job.operation_key);});summary.pending++;
      }
    }catch(e){
      const code=typeof e?.code==="string"&&/^[A-Z_]{3,80}$/.test(e.code)?e.code:"CREDIT_CONFIRMATION_PENDING",held=["PAYMENT_ADJUSTMENT_BINDING_MISMATCH","PAYMENT_ADJUSTMENT_RESULT_MISMATCH","PAYMENT_ADJUSTMENT_ACCOUNT_MISMATCH"].includes(code);
      withTransaction(db,()=>{if(!hasLease(db,job,workerId,config.now().toISOString()))return;db.prepare("UPDATE business_payment_credit_jobs SET status=?,available_at=?,last_error=?,lease_owner=NULL,lease_expires_at=NULL,attempts=CASE WHEN ? IN ('CREDIT_AWAITING_AVAILABLE_FUNDS','CREDIT_FUNDING_UNVERIFIED') AND dispatch_started_at IS NULL THEN MAX(0,attempts-1) ELSE attempts END,updated_at=? WHERE adjustment_id=?").run(held?"held":"unknown",new Date(config.now().getTime()+60000).toISOString(),code,code,config.now().toISOString(),row.id);db.prepare("UPDATE marketplace_operations SET status=?,error=?,updated_at=? WHERE operation_key=? AND status<>'confirmed'").run(held?"held":"unknown",code,config.now().toISOString(),job.operation_key);});summary[held?"held":"pending"]++;
    }
  }return summary;
}
function hasLease(db,job,workerId,stamp){return Boolean(db.prepare("SELECT 1 FROM business_payment_credit_jobs WHERE adjustment_id=? AND status='claimed' AND lease_owner=? AND lease_expires_at>?").get(job.adjustment_id,workerId,stamp));}
function assertLease(db,job,workerId,stamp){if(!hasLease(db,job,workerId,stamp))throw fault("CREDIT_WORKER_LEASE_LOST");}
