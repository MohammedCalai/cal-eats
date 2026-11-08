import {randomUUID} from "node:crypto";
import {withTransaction} from "../db/index.js";
import {HttpError} from "../http.js";

const profileRequired="STRIPE_CONNECT_PLATFORM_PROFILE_REQUIRED";
const clock=config=>config.now().toISOString();
const leaseError=()=>new HttpError(409,"ACCOUNT_SETUP_IN_PROGRESS","Bank account setup is already in progress. Please wait a moment, then refresh.");
const platformError=()=>new HttpError(409,"ACCOUNT_SETUP_PLATFORM_MISMATCH","Your bank setup belongs to a different verified payment connection. Contact Cal-Eats support before continuing.");

export function claimAccountSetupAttempt(db,config,{restaurantId,ownerEmail}){
  const mode=config.paymentProviderMode,platformId=config.stripePlatformAccountId;
  if(!["stripe_test","stripe_live"].includes(mode)||!/^acct_[A-Za-z0-9]+$/.test(platformId??""))throw new Error("Connected account setup requires an exact Stripe mode and platform account");
  return withTransaction(db,()=>{
    const previous=db.prepare("SELECT * FROM provider_account_setup_attempts WHERE restaurant_id=? AND provider_mode=? ORDER BY attempt_no DESC LIMIT 1").get(restaurantId,mode);
    if(previous&&previous.platform_account_id!==platformId)throw platformError();
    const account=db.prepare("SELECT * FROM provider_accounts WHERE restaurant_id=?").get(restaurantId);
    if(account?.provider_reference){if(account.provider_mode!==mode)throw new HttpError(409,"STRIPE_MODE_MISMATCH","Restaurant banking belongs to another payment mode.");return {account};}
    const now=clock(config),leaseOwner=randomUUID(),leaseExpiresAt=new Date(Date.parse(now)+120000).toISOString();
    if(previous?.status==="in_flight"&&previous.lease_expires_at>now)throw leaseError();
    // A specific, durably recorded profile rejection proves this attempt did
    // not create an account. No timeout, generic error or empty binding does.
    const advance=previous?.status==="profile_rejected"&&previous.outcome_code===profileRequired;
    if(previous&&!advance){
      if(previous.status==="succeeded")throw new HttpError(409,"ACCOUNT_SETUP_RECONCILIATION_REQUIRED","Your completed bank setup needs a connection review. Contact Cal-Eats support.");
      // Stripe can expire idempotency records after 24 hours. An ambiguous old
      // request must be reviewed instead of possibly creating a second account.
      if(Date.parse(now)-Date.parse(previous.created_at)>=23*3600000)throw new HttpError(409,"ACCOUNT_SETUP_RECONCILIATION_REQUIRED","Your earlier bank setup needs a connection review before it can be retried. Contact Cal-Eats support.");
      db.prepare("UPDATE provider_account_setup_attempts SET status='in_flight',lease_owner=?,lease_expires_at=?,updated_at=? WHERE restaurant_id=? AND provider_mode=? AND attempt_no=?").run(leaseOwner,leaseExpiresAt,now,restaurantId,mode,previous.attempt_no);
      return {...previous,status:"in_flight",lease_owner:leaseOwner,lease_expires_at:leaseExpiresAt};
    }
    const attemptNo=previous?previous.attempt_no+1:0,base=`connect-account:${mode}:${restaurantId}`,key=attemptNo?`${base}:attempt:${attemptNo}`:base;
    db.prepare("INSERT INTO provider_account_setup_attempts(restaurant_id,provider_mode,attempt_no,idempotency_key,owner_email,platform_account_id,status,lease_owner,lease_expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'in_flight',?,?,?,?)").run(restaurantId,mode,attemptNo,key,ownerEmail,platformId,leaseOwner,leaseExpiresAt,now,now);
    return {restaurant_id:restaurantId,provider_mode:mode,attempt_no:attemptNo,idempotency_key:key,owner_email:ownerEmail,platform_account_id:platformId,status:"in_flight",lease_owner:leaseOwner,lease_expires_at:leaseExpiresAt,created_at:now};
  });
}

function ownedAttempt(db,config,attempt){
  const row=db.prepare("SELECT * FROM provider_account_setup_attempts WHERE restaurant_id=? AND provider_mode=? AND attempt_no=?").get(attempt.restaurant_id,attempt.provider_mode,attempt.attempt_no);
  if(row&&(row.platform_account_id!==config.stripePlatformAccountId||row.platform_account_id!==attempt.platform_account_id||row.provider_mode!==config.paymentProviderMode))throw platformError();
  if(!row||row.status!=="in_flight"||row.lease_owner!==attempt.lease_owner||row.lease_expires_at<=clock(config))throw leaseError();
  return row;
}

export function recordAccountSetupFailure(db,config,attempt,code){
  const profile=code===profileRequired,safeCode=profile?profileRequired:code==="STRIPE_BANK_SETUP_UNAVAILABLE"?code:"STRIPE_ACCOUNT_CREATION_UNCONFIRMED";
  withTransaction(db,()=>{
    ownedAttempt(db,config,attempt);
    db.prepare("UPDATE provider_account_setup_attempts SET status=?,lease_owner=NULL,lease_expires_at=NULL,outcome_code=?,updated_at=? WHERE restaurant_id=? AND provider_mode=? AND attempt_no=?").run(profile?"profile_rejected":"unconfirmed",safeCode,clock(config),attempt.restaurant_id,attempt.provider_mode,attempt.attempt_no);
  });
}

// The account binding's existing save transaction calls this. A lost lease
// rolls back both the binding and completion proof, without provider retries.
export function completeAccountSetupAttempt(db,config,attempt,accountId){
  ownedAttempt(db,config,attempt);
  db.prepare("UPDATE provider_account_setup_attempts SET status='succeeded',lease_owner=NULL,lease_expires_at=NULL,outcome_code=NULL,provider_reference=?,updated_at=? WHERE restaurant_id=? AND provider_mode=? AND attempt_no=?").run(accountId,clock(config),attempt.restaurant_id,attempt.provider_mode,attempt.attempt_no);
}
