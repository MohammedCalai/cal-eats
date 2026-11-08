import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { financialEnvironmentMigration } from "../src/financial-environment-migration.js";
import { financialEnvironmentScope, orderEnvironmentPredicate, orderFinancialEnvironment, recordOrderFinancialEnvironment, requireOrderFinancialEnvironment } from "../src/financial-environment.js";
import { runMarketplaceWorker } from "../src/marketplace.js";
import { buildFinanceSummary } from "../src/marketplace-reporting.js";
import { journeyFixture } from "./helpers.js";

function legacyDatabase() {
  const db=new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE orders(id TEXT PRIMARY KEY,payment_method TEXT,contract_demo_only INTEGER,total_minor INTEGER,status TEXT);CREATE TABLE stripe_order_payments(order_id TEXT PRIMARY KEY REFERENCES orders(id),provider_mode TEXT,payment_intent_id TEXT);
  INSERT INTO orders VALUES('card-test','card',0,400,'completed'),('card-live','card',0,400,'completed'),('mock','mock_card',0,400,'completed'),('demo-cash','cash',1,400,'completed'),('unproven-cash','cash',0,400,'completed'),('unproven-voucher','voucher',0,400,'completed'),('unproven-card','card',0,400,'placed');
  INSERT INTO stripe_order_payments VALUES('card-test','stripe_test','pi_test'),('card-live','stripe_live','pi_live');`);
  return db;
}

test("migration classifies only proven legacy environments and preserves every financial/order value",()=>{
  const db=legacyDatabase();try{
    const orders=db.prepare("SELECT * FROM orders ORDER BY id").all(),payments=db.prepare("SELECT * FROM stripe_order_payments ORDER BY order_id").all();
    db.exec(financialEnvironmentMigration.sql);
    const expected={"card-test":"stripe_test","card-live":"stripe_live",mock:"local_simulator","demo-cash":"local_simulator","unproven-cash":"unknown","unproven-voucher":"unknown","unproven-card":"unknown"};
    for(const [id,environment]of Object.entries(expected))assert.equal(orderFinancialEnvironment(db,id),environment,id);
    assert.deepEqual(db.prepare("SELECT * FROM orders ORDER BY id").all(),orders);assert.deepEqual(db.prepare("SELECT * FROM stripe_order_payments ORDER BY order_id").all(),payments);
    assert.throws(()=>db.exec("UPDATE order_financial_environments SET environment='stripe_live' WHERE order_id='demo-cash'"),/immutable/);
    assert.throws(()=>db.exec("DELETE FROM order_financial_environments"),/immutable/);
    assert.deepEqual(db.prepare(`SELECT o.id FROM orders o WHERE ${orderEnvironmentPredicate("o","live")} ORDER BY o.id`).all().map(row=>row.id),["card-live"]);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM orders o WHERE ${orderEnvironmentPredicate("o","testing")}`).get().n,6);
    assert.throws(()=>orderEnvironmentPredicate("o);DROP TABLE orders;--","live"));assert.throws(()=>orderEnvironmentPredicate("o","all"));
  }finally{db.close();}
});

test("every new order snapshots its creation environment and later config changes cannot promote it",()=>{
  const db=legacyDatabase();try{
    db.exec(financialEnvironmentMigration.sql);
    for(const mode of ["local_simulator","stripe_test","stripe_live"]){
      const order={id:`new-${mode}`,created_at:"2026-01-01T12:00:00.000Z",payment_method:"cash"};
      db.prepare("INSERT INTO orders VALUES(?,'cash',0,400,'placed')").run(order.id);
      recordOrderFinancialEnvironment(db,order,{paymentProviderMode:mode});recordOrderFinancialEnvironment(db,order,{paymentProviderMode:mode});
      assert.equal(orderFinancialEnvironment(db,order.id),mode);
      assert.throws(()=>recordOrderFinancialEnvironment(db,order,{paymentProviderMode:mode==="stripe_live"?"stripe_test":"stripe_live"}),/cannot be changed/);
    }
    assert.equal(financialEnvironmentScope({paymentProviderMode:"stripe_live"}),"live");assert.equal(financialEnvironmentScope({paymentProviderMode:"stripe_test"}),"testing");
    assert.equal(requireOrderFinancialEnvironment(db,{id:"demo-cash",payment_method:"cash"},{paymentProviderMode:"stripe_test"}),"local_simulator");
    assert.throws(()=>requireOrderFinancialEnvironment(db,{id:"demo-cash",payment_method:"cash"},{paymentProviderMode:"stripe_live"}),error=>error.code==="ORDER_FINANCIAL_ENVIRONMENT_MISMATCH");
    assert.throws(()=>requireOrderFinancialEnvironment(db,{id:"unproven-cash",payment_method:"cash"},{paymentProviderMode:"stripe_live"}),error=>error.code==="ORDER_FINANCIAL_ENVIRONMENT_UNPROVEN");
    assert.equal(requireOrderFinancialEnvironment(db,{id:"card-live",payment_method:"card"},{paymentProviderMode:"stripe_live"}),"stripe_live");
  }finally{db.close();}
});

test("live handover preserves fictional cash, pauses simulator payouts and excludes their balances without changing history",async()=>{
  const f=await journeyFixture({orderAlertEmail:{mode:"off"}});
  try{
    const owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),customer=await f.login("customer@calai.local","LocalCustomer!4310");
    const restaurant=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0],item=(await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
    f.db.prepare("UPDATE menu_items SET price_minor=400 WHERE id=?").run(item.id);
    const place=(key,paymentMethod)=>f.json("/api/orders",{method:"POST",cookie:customer,headers:{"Idempotency-Key":key},body:{restaurantId:restaurant.id,items:[{menuItemId:item.id,quantity:1}],paymentMethod,fulfillment:"collection"}});
    const cash=await place("environment-cash","cash"),mock=await place("environment-mock","mock_card"),pending=await place("environment-pending","cash");
    for(const result of[cash,mock,pending])assert.equal(result.status,201,result.text);
    for(const result of[cash,mock])for(const status of["accepted","preparing","ready","completed"]){const changed=await f.json(`/api/restaurant/orders/${result.body.data.id}/status`,{method:"PATCH",cookie:owner,body:{status}});assert.equal(changed.status,200,changed.text);}
    runMarketplaceWorker(f.db,f.config);
    const payout=f.db.prepare("SELECT * FROM payout_batches WHERE operation_key=?").get(`payout:${mock.body.data.id}`);assert.ok(payout);
    f.db.prepare("UPDATE marketplace_worker_jobs SET available_at='2020-01-01T00:00:00.000Z' WHERE kind='payout_reconcile' AND entity_id=?").run(payout.id);
    const history=()=>JSON.stringify({orders:f.db.prepare("SELECT * FROM orders ORDER BY id").all(),operations:f.db.prepare("SELECT * FROM marketplace_operations ORDER BY id").all(),ledger:f.db.prepare("SELECT * FROM journal_postings ORDER BY id").all(),payouts:f.db.prepare("SELECT * FROM payout_batches ORDER BY id").all(),jobs:f.db.prepare("SELECT * FROM marketplace_worker_jobs ORDER BY id").all()});
    const before=history();
    // Synthetic local handover only: this test never constructs a live adapter.
    f.config.paymentProviderMode="stripe_live";
    const live=buildFinanceSummary(f.db,restaurant.id,null,f.config),testing=buildFinanceSummary(f.db,restaurant.id,new URL("http://fixture.invalid?scope=testing"),f.config);
    assert.equal(live.grossSalesMinor,0);assert.equal(live.heldMinor,0);assert.equal(live.cashCommissionOutstandingMinor,0);assert.equal(testing.heldMinor,372);assert.equal(testing.cashCommissionOutstandingMinor,28);
    const worker=runMarketplaceWorker(f.db,f.config);assert.equal(worker.completed,0);assert.equal(worker.failed,0);
    const blocked=await f.json(`/api/restaurant/orders/${pending.body.data.id}/status`,{method:"PATCH",cookie:owner,body:{status:"accepted"}});assert.equal(blocked.status,409,blocked.text);assert.equal(blocked.body.error.code,"ORDER_FINANCIAL_ENVIRONMENT_MISMATCH");
    assert.equal(history(),before);
    const liveCsv=await f.request(`/api/restaurant/restaurants/${restaurant.id}/finance/statement.csv`,{cookie:owner});assert.equal(liveCsv.status,200);assert.equal(liveCsv.text.includes(cash.body.data.id),false);
    const testCsv=await f.request(`/api/restaurant/restaurants/${restaurant.id}/finance/statement.csv?scope=testing`,{cookie:owner});assert.equal(testCsv.status,200);assert.equal(testCsv.text.includes(cash.body.data.id),true);
  }finally{await f.close();}
});
