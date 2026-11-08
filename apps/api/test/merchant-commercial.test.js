import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { merchantCommercialMigration } from "../src/merchant-commercial-migration.js";
import { legalContentSha256 } from "../src/customer-legal-archive.js";
import { approvedMerchantCommission, initializeMerchantCommercial, loadMerchantCommercialConfig, merchantCommercialStatus, resolveMerchantCommercialTerms, routeMerchantCommercial } from "../src/merchant-commercial.js";
import { journeyFixture } from "./helpers.js";
import { paymentLaunchReport } from "../src/payment-launch.js";

// Fictional approval used only in an in-memory test. It is never activated.
export function merchantManifest(version="2026-01-01-v1",text="Fictional local commercial schedule. Normal commission is 7% after restaurant discounts plus charged delivery; platform pays processing costs; weekly Monday payouts depend on available funds.") {
  return {enabled:true,document:{approved:true,version,text,sha256:legalContentSha256(text),approvedAt:"2025-12-01T00:00:00.000Z",effectiveAt:"2026-01-01T00:00:00.000Z",approvalReference:"Fictional in-memory unit approval only"},commission:{rateBasisPoints:700,base:"food_plus_delivery",processingFeesPaidBy:"platform"},payoutSchedule:{interval:"weekly",weeklyAnchor:"monday"}};
}
function fixture(input=merchantManifest()) {
  const db=new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,account_enabled INTEGER);CREATE TABLE restaurants(id TEXT PRIMARY KEY,name TEXT);CREATE TABLE restaurant_memberships(restaurant_id TEXT,user_id TEXT,permission TEXT);CREATE TABLE orders(id TEXT PRIMARY KEY);CREATE TABLE audit_events(id TEXT,actor_user_id TEXT,entity_type TEXT,entity_id TEXT,action TEXT,details TEXT,created_at TEXT);INSERT INTO users VALUES('owner','restaurant',1),('staff','restaurant',1),('other','restaurant',1),('admin','admin',1),('customer','customer',1);INSERT INTO restaurants VALUES('a','Restaurant A'),('b','Restaurant B');INSERT INTO restaurant_memberships VALUES('a','owner','owner'),('a','staff','staff'),('b','other','owner');`);
  db.exec(merchantCommercialMigration.sql);
  const config={merchantCommercial:loadMerchantCommercialConfig(input),bodyLimit:16384,now:()=>new Date("2026-01-02T12:00:00.000Z")};
  initializeMerchantCommercial(db,config);
  async function call({id="owner",role="restaurant",restaurant="a",method="GET",body,suffix=""}={}) {
    const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(req,{method,headers:{"content-type":"application/json"}});
    let response;
    const res={writeHead(status){this.status=status;},end(text){response={status:this.status,body:JSON.parse(text)};}};
    try{await routeMerchantCommercial({req,res,url:new URL(`https://fixture.invalid/api/restaurant/restaurants/${restaurant}/merchant-agreement${suffix}`),db,config,session:{user:{id,role}}});return response;}
    catch(error){return{status:error.status||500,code:error.code};}
  }
  const accept=()=>call({method:"POST",suffix:"/accept",body:{version:config.merchantCommercial.document?.version,sha256:config.merchantCommercial.document?.sha256,accepted:true}});
  return {db,config,call,accept,close:()=>db.close()};
}

test("merchant agreement remains disabled by default and cannot activate drafts or development pricing",async()=>{
  const f=fixture({enabled:false});try{
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM merchant_commercial_documents").get().n,0);
    assert.equal((await f.call()).body.data.enabled,false);
    assert.equal((await f.accept()).code,"MERCHANT_AGREEMENT_NOT_ACTIVE");
  }finally{f.close();}
  for(const change of [{approved:false},{version:"development-v1"},{version:"draft-v1"},{demoOnly:true},{developmentAssumption:true},{sha256:"a".repeat(64)}])assert.throws(()=>loadMerchantCommercialConfig({...merchantManifest(),document:{...merchantManifest().document,...change}}));
  assert.throws(()=>loadMerchantCommercialConfig(merchantManifest("2026-01-01-v1","UNAPPROVED DRAFT: do not publish")));
  assert.throws(()=>loadMerchantCommercialConfig({...merchantManifest(),commission:{rateBasisPoints:700,base:"food",processingFeesPaidBy:"platform"}}));
});

test("only an active actual owner in this restaurant can view or accept the exact document",async()=>{
  const f=fixture();try{
    for(const actor of [{id:"admin",role:"admin"},{id:"customer",role:"customer"},{id:"staff",role:"restaurant"},{id:"other",role:"restaurant"},{id:"admin",role:"restaurant"}])assert.notEqual((await f.call(actor)).status,200);
    assert.equal((await f.call()).body.data.restaurantName,"Restaurant A");
    const d=f.config.merchantCommercial.document;
    assert.equal((await f.call({method:"POST",suffix:"/accept",body:{version:d.version,sha256:d.sha256,accepted:false}})).code,"MERCHANT_AGREEMENT_ACCEPTANCE_REQUIRED");
    assert.equal((await f.call({method:"POST",suffix:"/accept",body:{version:"old-version",sha256:d.sha256,accepted:true}})).code,"MERCHANT_AGREEMENT_CHANGED");
    assert.equal((await f.call({method:"POST",suffix:"/accept",body:{version:d.version,sha256:"0".repeat(64),accepted:true}})).code,"MERCHANT_AGREEMENT_CHANGED");
    assert.equal((await f.accept()).status,200);assert.equal((await f.accept()).status,200);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM merchant_commercial_acceptances").get().n,1);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_events").get().n,1);
    assert.equal(approvedMerchantCommission(f.db,f.config,"a").demoOnly,false);
    assert.equal(approvedMerchantCommission(f.db,f.config,"b"),null);
    assert.equal(merchantCommercialStatus(f.db,f.config,"a","owner").acceptedByCurrentOwner,true);
  }finally{f.close();}
});

test("version changes require fresh acceptance; archives and evidence cannot be replaced",async()=>{
  const f=fixture();try{
    await f.accept();const original=f.db.prepare("SELECT * FROM merchant_commercial_acceptances").get();
    f.config.merchantCommercial=loadMerchantCommercialConfig(merchantManifest("2026-01-01-v2","Fictional updated local commercial schedule with the same approved monetary facts."));initializeMerchantCommercial(f.db,f.config);
    assert.equal(approvedMerchantCommission(f.db,f.config,"a"),null);
    await f.accept();assert.equal(f.db.prepare("SELECT COUNT(*) n FROM merchant_commercial_acceptances").get().n,2);
    assert.deepEqual(f.db.prepare("SELECT * FROM merchant_commercial_acceptances WHERE id=?").get(original.id),original);
    assert.throws(()=>f.db.exec("UPDATE merchant_commercial_documents SET text_content='replacement'"),/immutable/);
    assert.throws(()=>f.db.exec("DELETE FROM merchant_commercial_acceptances"),/immutable/);
    f.config.merchantCommercial=loadMerchantCommercialConfig(merchantManifest("2026-01-01-v2","Different bytes pretending to be the same version."));assert.throws(()=>initializeMerchantCommercial(f.db,f.config),/cannot be replaced/);
  }finally{f.close();}
});

test("future agreements cannot be accepted and an audit failure rolls back acceptance",async()=>{
  const future=merchantManifest();future.document.effectiveAt="2027-01-01T00:00:00.000Z";
  const f=fixture(future);try{assert.equal((await f.call()).body.data.canAccept,false);assert.equal((await f.accept()).code,"MERCHANT_AGREEMENT_NOT_EFFECTIVE");assert.equal(approvedMerchantCommission(f.db,f.config,"a"),null);}finally{f.close();}
  const g=fixture();try{g.db.exec("CREATE TRIGGER fail_merchant_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'fixture failure');END;");assert.equal((await g.accept()).status,500);assert.equal(g.db.prepare("SELECT COUNT(*) n FROM merchant_commercial_acceptances").get().n,0);}finally{g.close();}
});

test("genuine existing real pricing survives; development policies never become real acceptance",()=>{
  const real={accepted_at:"2026-01-01",rate_bps:700,commission_base:"food_plus_delivery",version:"real-v1",development_assumption:0};
  const agreement={rateBasisPoints:700,base:"food_plus_delivery",policyVersion:"new-v1",demoOnly:false,acceptanceId:"accepted"};
  assert.equal(resolveMerchantCommercialTerms({policy:real,agreement}).policyVersion,"real-v1");
  const development={...real,development_assumption:1};
  assert.equal(resolveMerchantCommercialTerms({policy:development}).demoOnly,true);
  assert.equal(resolveMerchantCommercialTerms({policy:development,agreement}).policyVersion,"new-v1");
  assert.equal(resolveMerchantCommercialTerms({contract:{accepted_at:"2026-01-01",rate_bps:700,policy_version:"legacy-real",demo_only:0}}).demoOnly,false);
  assert.equal(resolveMerchantCommercialTerms({}).accepted,false);
});

test("real owner acceptance feeds new-order snapshots and readiness while saved orders and commission-free controls stay intact",async()=>{
  const f=await journeyFixture({merchantCommercial:merchantManifest(),orderAlertEmail:{mode:"off"}});
  try{
    const owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),customer=await f.login("customer@calai.local","LocalCustomer!4310"),admin=await f.login("admin@calai.local","LocalAdmin!4310");
    const restaurant=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0],item=(await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0],path=`/api/restaurant/restaurants/${restaurant.id}/merchant-agreement`;
    const body={restaurantId:restaurant.id,items:[{menuItemId:item.id,quantity:1}],paymentMethod:"mock_card",fulfillment:"collection"};
    const place=key=>f.json("/api/orders",{method:"POST",cookie:customer,headers:{"Idempotency-Key":key},body});
    const prior=await place("merchant-before-acceptance");assert.equal(prior.status,201,prior.text);
    const beforeOrder=f.db.prepare("SELECT * FROM orders WHERE id=?").get(prior.body.data.id),beforeContracts=f.db.prepare("SELECT * FROM contracts ORDER BY id").all(),beforePolicies=f.db.prepare("SELECT * FROM commission_policies ORDER BY id").all();
    assert.equal(paymentLaunchReport(f.db,f.config).restaurants.items.find(row=>row.id===restaurant.id).termsApproved,false);
    const d=(await f.json(path,{cookie:owner})).body.data.document;
    const accepted=await f.json(`${path}/accept`,{method:"POST",cookie:owner,body:{version:d.version,sha256:d.sha256,accepted:true}});assert.equal(accepted.status,200,accepted.text);
    assert.deepEqual(f.db.prepare("SELECT * FROM contracts ORDER BY id").all(),beforeContracts);assert.deepEqual(f.db.prepare("SELECT * FROM commission_policies ORDER BY id").all(),beforePolicies);
    assert.equal(paymentLaunchReport(f.db,f.config).restaurants.items.find(row=>row.id===restaurant.id).termsApproved,true);
    const placed=await place("merchant-after-acceptance");assert.equal(placed.status,201,placed.text);
    assert.equal(placed.body.data.contract.demoOnly,false);assert.equal(placed.body.data.contract.policyVersion,d.version);assert.equal(placed.body.data.commissionMinor,Math.round(placed.body.data.totalMinor*.07));
    const snapshot=f.db.prepare("SELECT * FROM order_merchant_commercial_snapshots WHERE order_id=?").get(placed.body.data.id);assert.equal(snapshot.document_sha256,d.sha256);
    assert.equal(f.db.prepare("SELECT * FROM order_merchant_commercial_snapshots WHERE order_id=?").get(prior.body.data.id),undefined);
    assert.equal((await f.json(`/api/admin/restaurants/${restaurant.id}/commission`,{method:"PATCH",cookie:admin,body:{action:"disable",expectedRevision:0}})).status,200);
    const free=await place("merchant-free-commission");assert.equal(free.status,201,free.text);assert.equal(free.body.data.commissionMinor,0);
    assert.deepEqual(f.db.prepare("SELECT * FROM orders WHERE id=?").get(prior.body.data.id),beforeOrder);
    const quote=await f.json("/api/orders/quote",{method:"POST",cookie:customer,body});assert.equal(quote.status,200,quote.text);assert.equal(quote.body.data.commissionMinor,0);
    f.config.merchantCommercial=loadMerchantCommercialConfig(merchantManifest("2026-01-01-v2","Fictional successor commercial schedule for a fresh owner acceptance."));initializeMerchantCommercial(f.db,f.config);
    assert.equal(paymentLaunchReport(f.db,f.config).restaurants.items.find(row=>row.id===restaurant.id).termsApproved,false);
    assert.deepEqual(f.db.prepare("SELECT * FROM order_merchant_commercial_snapshots WHERE order_id=?").get(placed.body.data.id),snapshot);
  }finally{await f.close();}
});
