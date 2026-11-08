import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {accountSetupAttemptMigration57} from "../src/payments/account-setup-attempt-migration.js";
import {claimAccountSetupAttempt,recordAccountSetupFailure,completeAccountSetupAttempt} from "../src/payments/account-setup-attempts.js";

function fixture(){
  const db=new DatabaseSync(":memory:");db.exec("PRAGMA foreign_keys=ON;CREATE TABLE restaurants(id TEXT PRIMARY KEY);INSERT INTO restaurants VALUES('restaurant');CREATE TABLE provider_accounts(restaurant_id TEXT,provider_mode TEXT,provider_reference TEXT);");db.exec(accountSetupAttemptMigration57.sql);
  let time=Date.parse("2026-01-01T00:00:00.000Z");const config={paymentProviderMode:"stripe_live",stripePlatformAccountId:"acct_platform",now:()=>new Date(time)};
  return{db,config,claim:email=>claimAccountSetupAttempt(db,config,{restaurantId:"restaurant",ownerEmail:email??"owner@example.invalid"}),advance:ms=>{time+=ms;},close:()=>db.close()};
}

test("only a recorded exact profile rejection advances an immutable account-creation identity",()=>{
  const f=fixture();try{
    const initial=f.claim();assert.equal(initial.idempotency_key,"connect-account:stripe_live:restaurant");assert.equal(initial.platform_account_id,"acct_platform");
    assert.throws(()=>f.claim(),error=>error.code==="ACCOUNT_SETUP_IN_PROGRESS");
    recordAccountSetupFailure(f.db,f.config,initial,"STRIPE_ACCOUNT_CREATION_UNCONFIRMED");const retry=f.claim("changed@example.invalid");assert.equal(retry.idempotency_key,initial.idempotency_key);assert.equal(retry.owner_email,initial.owner_email);
    recordAccountSetupFailure(f.db,f.config,retry,"STRIPE_CONNECT_PLATFORM_PROFILE_REQUIRED");const fresh=f.claim("changed@example.invalid");assert.equal(fresh.idempotency_key,"connect-account:stripe_live:restaurant:attempt:1");assert.equal(fresh.owner_email,"changed@example.invalid");
    const old=f.db.prepare("SELECT * FROM provider_account_setup_attempts WHERE attempt_no=0").get();assert.equal(old.status,"profile_rejected");assert.equal(old.outcome_code,"STRIPE_CONNECT_PLATFORM_PROFILE_REQUIRED");
    assert.throws(()=>f.db.exec("UPDATE provider_account_setup_attempts SET platform_account_id='acct_changed'"),/immutable/);
  }finally{f.close();}
});

test("expired leases retry the same key, fence late results and stop stale ambiguous retries before expiry of provider idempotency",()=>{
  const f=fixture();try{
    const initial=f.claim();f.advance(121000);const reclaimed=f.claim();assert.equal(reclaimed.idempotency_key,initial.idempotency_key);assert.notEqual(reclaimed.lease_owner,initial.lease_owner);
    assert.throws(()=>recordAccountSetupFailure(f.db,f.config,initial,"STRIPE_CONNECT_PLATFORM_PROFILE_REQUIRED"),error=>error.code==="ACCOUNT_SETUP_IN_PROGRESS");
    recordAccountSetupFailure(f.db,f.config,reclaimed,"STRIPE_ACCOUNT_CREATION_UNCONFIRMED");f.advance(23*3600000);
    const before=JSON.stringify(f.db.prepare("SELECT * FROM provider_account_setup_attempts").all());assert.throws(()=>f.claim(),error=>error.code==="ACCOUNT_SETUP_RECONCILIATION_REQUIRED");assert.equal(JSON.stringify(f.db.prepare("SELECT * FROM provider_account_setup_attempts").all()),before);
  }finally{f.close();}
});

test("platform changes cannot resume, reject or complete an earlier platform's account attempt",()=>{
  const f=fixture();try{
    const initial=f.claim(),before=JSON.stringify(f.db.prepare("SELECT * FROM provider_account_setup_attempts").all());f.config.stripePlatformAccountId="acct_changed";
    for(const action of[()=>f.claim(),()=>recordAccountSetupFailure(f.db,f.config,initial,"STRIPE_CONNECT_PLATFORM_PROFILE_REQUIRED"),()=>completeAccountSetupAttempt(f.db,f.config,initial,"acct_restaurant")])assert.throws(action,error=>error.code==="ACCOUNT_SETUP_PLATFORM_MISMATCH");
    assert.equal(JSON.stringify(f.db.prepare("SELECT * FROM provider_account_setup_attempts").all()),before);
  }finally{f.close();}
});
