import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { payoutApiProvenanceMigration55 } from "../src/payout-api-provenance-migration.js";
import { recordVerifiedPayoutApiRead } from "../src/financial-environment.js";
import { bankPayoutFinancePredicate } from "../src/marketplace-reporting.js";
import { journeyFixture } from "./helpers.js";

const stamp="2026-11-08T12:00:00.000Z";
const config=mode=>({paymentProviderMode:mode,stripePlatformAccountId:"acct_platform",paymentProvider:{mode}});
const args=(payoutId,amountMinor)=>({restaurantId:"restaurant",accountId:"acct_connected",payoutId,amountMinor,currency:"GBP",verifiedAt:stamp});
function fixture(){
  const db=new DatabaseSync(":memory:");db.exec("PRAGMA foreign_keys=ON");
  db.exec("CREATE TABLE restaurants(id TEXT PRIMARY KEY);INSERT INTO restaurants VALUES('restaurant');CREATE TABLE stripe_connected_payouts(id TEXT PRIMARY KEY,restaurant_id TEXT REFERENCES restaurants(id),provider_account_id TEXT,amount_minor INTEGER,status TEXT);CREATE TABLE provider_events(provider TEXT,object_type TEXT,event_type TEXT,object_id TEXT,provider_account_reference TEXT,restaurant_id TEXT,status TEXT,error TEXT);CREATE TABLE provider_accounts(restaurant_id TEXT,provider_mode TEXT,provider_reference TEXT);INSERT INTO provider_accounts VALUES('restaurant','stripe_live','acct_connected')");
  for(const [id,amount]of [["po_old",500],["po_api_live",700],["po_api_test",900],["po_signed",1100]])db.prepare("INSERT INTO stripe_connected_payouts VALUES(?,'restaurant','acct_connected',?,'paid')").run(id,amount);
  const facts=JSON.stringify(db.prepare("SELECT * FROM stripe_connected_payouts ORDER BY id").all());
  db.exec(payoutApiProvenanceMigration55.sql);
  const total=scope=>db.prepare(`SELECT COALESCE(SUM(p.amount_minor),0) amount FROM stripe_connected_payouts p WHERE ${bankPayoutFinancePredicate("p",scope)}`).get().amount;
  return {db,facts,total};
}

test("migration never promotes old bank rows; immutable API proof is exact, idempotent and independent of the current account binding",()=>{
  const {db,facts,total}=fixture();try{
    assert.equal(db.prepare("SELECT COUNT(*) n FROM stripe_payout_api_provenance").get().n,0);assert.equal(total("live"),0);
    const first=recordVerifiedPayoutApiRead(db,config("stripe_live"),args("po_api_live",700));assert.equal(first.created,true);assert.equal(total("live"),700);
    const again=recordVerifiedPayoutApiRead(db,config("stripe_live"),{...args("po_api_live",700),verifiedAt:"2026-11-09T12:00:00.000Z"});assert.equal(again.created,false);assert.equal(again.verified_at,stamp);
    recordVerifiedPayoutApiRead(db,config("stripe_test"),args("po_api_test",900));assert.equal(total("live"),700);
    db.prepare("INSERT INTO provider_events VALUES('stripe_live','payout','payout.paid','po_signed','acct_connected','restaurant','completed',NULL)").run();assert.equal(total("live"),1800,"Signed-event evidence still qualifies without any API-read row");
    assert.equal(total("testing"),1400);assert.equal(JSON.stringify(db.prepare("SELECT * FROM stripe_connected_payouts ORDER BY id").all()),facts);
    assert.throws(()=>db.exec("UPDATE stripe_payout_api_provenance SET provider_mode='stripe_live' WHERE payout_id='po_api_test'"),/immutable/);
    assert.throws(()=>db.exec("DELETE FROM stripe_payout_api_provenance"),/immutable/);
    for(const changed of [ {...args("po_api_live",700),currency:"USD"},{...args("po_api_live",701)},{...args("po_api_live",700),accountId:"acct_other"},{...args("po_api_live",700),restaurantId:"other"},{...args("po_api_live",700),verifiedAt:"invalid"}])assert.throws(()=>recordVerifiedPayoutApiRead(db,config("stripe_live"),changed),error=>error.code==="STRIPE_PAYOUT_PROVENANCE_MISMATCH");
    assert.throws(()=>recordVerifiedPayoutApiRead(db,{...config("stripe_live"),stripePlatformAccountId:"acct_other_platform"},args("po_api_live",700)),error=>error.code==="STRIPE_PAYOUT_PROVENANCE_MISMATCH");
    assert.throws(()=>recordVerifiedPayoutApiRead(db,config("stripe_test"),args("po_api_live",700)),error=>error.code==="STRIPE_PAYOUT_PROVENANCE_MISMATCH");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM stripe_payout_api_provenance").get().n,2);assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
  }finally{db.close();}
});

test("API proof cannot contradict completed signed event scope or qualify a payout after its stored binding changes",()=>{
  const {db,total}=fixture();try{
    db.prepare("INSERT INTO provider_events VALUES('stripe_test','payout','payout.paid','po_old','acct_connected','restaurant','completed',NULL)").run();
    assert.throws(()=>recordVerifiedPayoutApiRead(db,config("stripe_live"),args("po_old",500)),error=>error.code==="STRIPE_PAYOUT_PROVENANCE_MISMATCH");
    assert.equal(total("live"),0);
    recordVerifiedPayoutApiRead(db,config("stripe_live"),args("po_api_live",700));assert.equal(total("live"),700);
    // Isolated tamper fixture proves reporting rechecks exact immutable amount.
    db.prepare("UPDATE stripe_connected_payouts SET amount_minor=701 WHERE id='po_api_live'").run();assert.equal(total("live"),0);
    assert.throws(()=>recordVerifiedPayoutApiRead(db,config("stripe_live"),args("po_api_live",701)),error=>error.code==="STRIPE_PAYOUT_PROVENANCE_MISMATCH");
  }finally{db.close();}
});

test("scoped owner payout refresh stores verified API mode without inventing a webhook or changing other bank rows",async()=>{
  const f=await journeyFixture();try{
    const owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),shop=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0];let calls=0;
    const adapter={mode:"stripe_test",retrievePlatformAccount:async()=>({ok:true,status:"confirmed",providerReference:"acct_platform",mode:"stripe_test"}),listPayouts:async()=>{calls++;return{ok:true,items:[{providerReference:"po_api_fixture",amountMinor:700,currency:"GBP",paymentState:"paid",arrivalAt:stamp}],hasMore:false};}};
    Object.assign(f.config,{paymentProviderMode:"stripe_test",stripePlatformAccountId:"acct_platform",paymentProviderWebhookSecret:"whsec_fixture",paymentProviderConnectWebhookSecret:"whsec_connect",stripeProvider:adapter,paymentProvider:adapter});
    f.db.prepare("INSERT OR REPLACE INTO provider_accounts VALUES(?,?,'stripe_test','enabled','[]','[]','acct_connected',?,?)").run(randomUUID(),shop.id,stamp,stamp);
    f.db.prepare("INSERT INTO stripe_connected_payouts VALUES('po_legacy_fixture',?,'acct_connected',300,'paid',?,NULL,?,?)").run(shop.id,stamp,stamp,stamp);
    const endpoint=`/api/restaurant/restaurants/${shop.id}/finance/stripe/payouts`;
    const first=await f.json(endpoint,{cookie:owner});assert.equal(first.status,200,first.text);const proof=f.db.prepare("SELECT * FROM stripe_payout_api_provenance").all();assert.equal(proof.length,1);assert.equal(proof[0].provider_mode,"stripe_test");assert.equal(proof[0].amount_minor,700);assert.equal(proof[0].platform_account_id,"acct_platform");assert.equal(proof[0].source,"stripe_payouts_api_read");
    assert.equal((await f.json(endpoint,{cookie:owner})).status,200);assert.equal(calls,2);assert.deepEqual(f.db.prepare("SELECT * FROM stripe_payout_api_provenance").all(),proof);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM provider_events").get().n,0,"An API read must not manufacture a signed provider event");
    assert.equal(f.db.prepare("SELECT amount_minor FROM stripe_connected_payouts WHERE id='po_legacy_fixture'").get().amount_minor,300);
    assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(),[]);
  }finally{await f.close();}
});
