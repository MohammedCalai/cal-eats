import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { journeyFixture } from "./helpers.js";
import { buildFinanceSummary } from "../src/marketplace-reporting.js";
import { recordVerifiedPayoutApiRead } from "../src/financial-environment.js";
import { buildWeeklyStatementSnapshot, weeklyStatementPeriod, initializeBusinessWeeklyStatements, runBusinessWeeklyStatements } from "../src/business-weekly-statements.js";

const insert = (db,table,row) => db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(()=>"?").join(",")})`).run(...Object.values(row));
const financialFacts = db => JSON.stringify(Object.fromEntries(["orders","marketplace_operations","journal_postings","ledger_entries","payout_batches","stripe_connected_payouts","provider_events","order_financial_environments"].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));

test("live owner earnings and weekly totals exclude fictional cash/test cards and require actual payout-environment evidence", async () => {
  const f=await journeyFixture({now:()=>new Date("2026-10-21T12:00:00.000Z"),rateLimit:{attempts:100,windowMs:60000},businessStatements:{sendEnabled:false}});
  try {
    const owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),customer=await f.login("customer@calai.local","LocalCustomer!4310"),admin=await f.login("admin@calai.local","LocalAdmin!4310");
    const shop=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0],item=(await f.json(`/api/restaurants/${shop.id}/menu`)).body.data.items[0],root=`/api/restaurant/restaurants/${shop.id}`;
    f.db.prepare("UPDATE menu_items SET price_minor=400 WHERE id=?").run(item.id);
    const old=[];
    for(const paymentMethod of ["cash","mock_card"]){
      const placed=await f.json("/api/orders",{cookie:customer,method:"POST",headers:{"Idempotency-Key":`report-history-${paymentMethod}`},body:{restaurantId:shop.id,items:[{menuItemId:item.id,quantity:1}],paymentMethod,fulfillment:"collection"}});
      assert.equal(placed.status,201,placed.text);old.push(placed.body.data.id);
      for(const status of ["accepted","preparing","ready","completed"]){const r=await f.json(`/api/restaurant/orders/${placed.body.data.id}/status`,{cookie:owner,method:"PATCH",body:{status}});assert.equal(r.status,200,r.text);}
    }
    const template=f.db.prepare("SELECT * FROM orders WHERE id=?").get(old[0]),liveId=randomUUID(),stamp=f.config.now().toISOString();
    insert(f.db,"orders",{...template,id:liveId,idempotency_key:`fixture-live-${liveId}`,total_minor:1500,subtotal_minor:1500,gross_food_minor:1500,customer_payable_minor:1500,commission_minor:105,created_at:stamp,updated_at:stamp});
    insert(f.db,"order_financial_environments",{order_id:liveId,environment:"stripe_live",provenance:"isolated_reporting_fixture",source_reference:null,recorded_at:stamp});
    const verifiedPayout="po_reporting_verified",unverifiedPayout="po_reporting_unverified",account="acct_reporting_fixture";
    for(const [id,amount] of [[verifiedPayout,777],[unverifiedPayout,666]])insert(f.db,"stripe_connected_payouts",{id,restaurant_id:shop.id,provider_account_id:account,amount_minor:amount,status:"paid",arrival_at:stamp,failure:null,created_at:stamp,updated_at:stamp});
    // Isolated fixture provenance only; no provider, signing or bank call occurs.
    insert(f.db,"provider_events",{id:randomUUID(),provider:"stripe_live",provider_event_id:"evt_reporting_fixture",event_type:"payout.paid",object_type:"payout",object_id:verifiedPayout,provider_account_reference:account,restaurant_id:shop.id,payload_fingerprint:"fixture",normalized_payload:"{}",provider_created_at:stamp,status:"completed",available_at:stamp,created_at:stamp,updated_at:stamp});
    const before=financialFacts(f.db);f.config.paymentProviderMode="stripe_live";
    const live=buildFinanceSummary(f.db,shop.id,null,f.config),history=buildFinanceSummary(f.db,shop.id,new URL("https://fixture.invalid?scope=testing"),f.config);
    assert.equal(live.scope,"live");assert.equal(live.grossSalesMinor,1500);assert.equal(live.commissionMinor,105);assert.equal(live.cashCommissionOutstandingMinor,105);assert.equal(live.heldMinor,0);assert.equal(live.availableMinor,0);
    assert.equal(live.bankPaidMinor,777);assert.equal(live.bankPayoutUnverifiedCount,1);
    assert.equal(history.grossSalesMinor,800);assert.equal(history.commissionMinor,56);assert.equal(history.cashCommissionOutstandingMinor,28);assert.match(history.historyLabel,/Testing/);
    const dashboard=await f.json(`${root}/dashboard?period=this_week`,{cookie:owner});assert.equal(dashboard.status,200,dashboard.text);
    assert.equal(dashboard.body.data.finance.scope,"live");assert.equal(dashboard.body.data.finance.period.grossSalesMinor,1500);assert.equal(dashboard.body.data.finance.period.commissionMinor,105);assert.equal(dashboard.body.data.orders.items.length,1);assert.equal(dashboard.body.data.orders.items[0].id,liveId);
    const operations=await f.json(`${root}/dashboard?view=operations&period=this_week`,{cookie:owner});assert.equal(operations.body.data.orders.items.length,3,"Operational order history is not changed by financial filtering");
    assert.equal((await f.json(`${root}/finance/orders/${old[0]}/breakdown`,{cookie:owner})).status,404);
    assert.equal((await f.json(`${root}/finance/orders/${old[0]}/breakdown?scope=testing`,{cookie:owner})).body.data.scope,"testing");
    const exportLive=await f.request("/api/admin/dashboard/metrics.csv",{cookie:admin});assert.equal(exportLive.status,200,exportLive.text);assert.match(exportLive.text,/"grossSalesMinor","1500"/);assert.match(exportLive.text,/financialScope/);
    const exportHistory=await f.request("/api/admin/dashboard/metrics.csv?scope=testing",{cookie:admin});assert.match(exportHistory.text,/"grossSalesMinor","800"/);
    const orderExport=await f.request("/api/admin/dashboard/orders.csv",{cookie:admin});assert.equal(orderExport.status,200,orderExport.text);assert.ok(orderExport.text.includes(liveId));for(const id of old)assert.equal(orderExport.text.includes(id),false);
    const period=weeklyStatementPeriod("2026-10-26T09:00:00Z"),weekly=buildWeeklyStatementSnapshot(f.db,shop.id,period,f.config),testing=buildWeeklyStatementSnapshot(f.db,shop.id,period,{...f.config,paymentProviderMode:"stripe_test"});
    assert.equal(weekly.summary.scope,"live");assert.equal(weekly.summary.ordersPlaced,1);assert.equal(weekly.summary.grossSalesMinor,1500);assert.equal(weekly.summary.commissionMinor,105);assert.equal(weekly.summary.netEarningsMinor,1395);assert.equal(weekly.summary.cardSalesMinor,0);assert.equal(weekly.summary.bankPayoutRecordedMinor,777);
    for(const id of old)assert.equal(weekly.csv.includes(id),false);
    assert.equal(weekly.csv.includes(unverifiedPayout),false);assert.match(weekly.csv,/financialScope/);
    assert.equal(testing.summary.ordersPlaced,2);assert.equal(testing.summary.grossSalesMinor,800);assert.equal(testing.summary.cashSalesMinor,400);assert.equal(testing.summary.cardSalesMinor,400);assert.equal(testing.csv.includes(liveId),false);
    recordVerifiedPayoutApiRead(f.db,{...f.config,paymentProviderMode:"stripe_live",stripePlatformAccountId:"acct_platform",stripeProvider:{mode:"stripe_live"}},{restaurantId:shop.id,accountId:account,payoutId:unverifiedPayout,amountMinor:666,currency:"GBP",verifiedAt:stamp});
    assert.equal(buildFinanceSummary(f.db,shop.id,null,f.config).bankPaidMinor,1443,"Fresh verified API evidence qualifies before its webhook arrives");
    assert.equal(buildWeeklyStatementSnapshot(f.db,shop.id,period,f.config).summary.bankPayoutRecordedMinor,1443);
    assert.equal(financialFacts(f.db),before,"Reporting does not change historical financial facts");
    assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(),[]);
  } finally { await f.close(); }
});

test("a queued testing weekly statement cannot be sent after a live handover and remains downloadable only as testing history",async()=>{
  const f=await journeyFixture({now:()=>new Date("2026-10-21T12:00:00.000Z"),businessStatements:{sendEnabled:false}});
  try {
    const owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),shop=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0],ownerId=f.db.prepare("SELECT id FROM users WHERE email='restaurant@calai.local'").get().id;
    initializeBusinessWeeklyStatements(f.db,f.config);
    const period=weeklyStatementPeriod("2026-10-26T09:00:00Z"),snapshot=buildWeeklyStatementSnapshot(f.db,shop.id,period,f.config),id=randomUUID(),stamp=f.config.now().toISOString();
    insert(f.db,"business_weekly_statement_outbox",{id,restaurant_id:shop.id,user_id:ownerId,recipient:"restaurant@calai.local",week_from:period.fromDate,week_to:period.toDate,summary:JSON.stringify(snapshot.summary),csv:snapshot.csv,message_id:`<${id}@calai.info>`,mode:"local",status:"pending",queued_at:stamp,updated_at:stamp});
    f.config.paymentProviderMode="stripe_live";let sends=0;
    const result=await runBusinessWeeklyStatements(f.db,f.config,{adapter:async()=>{sends++;return{status:"sent"};}});
    assert.equal(sends,0);assert.equal(result.cancelled,1);
    const row=f.db.prepare("SELECT * FROM business_weekly_statement_outbox WHERE id=?").get(id);assert.equal(row.status,"cancelled");assert.equal(row.last_error,"STATEMENT_FINANCIAL_SCOPE_CHANGED");assert.equal(row.csv,snapshot.csv);assert.equal(row.summary,JSON.stringify(snapshot.summary));
    const root=`/api/restaurant/restaurants/${shop.id}/weekly-statements`;
    assert.equal((await f.json(root,{cookie:owner})).body.data.items.length,0);
    const history=await f.json(`${root}?scope=testing`,{cookie:owner});assert.equal(history.body.data.items.length,1);assert.match(history.body.data.items[0].historyLabel,/Testing/);
    assert.equal((await f.request(`${root}/${id}.csv`,{cookie:owner})).status,404);
    assert.equal((await f.request(history.body.data.items[0].downloadUrl,{cookie:owner})).text,snapshot.csv);
  } finally { await f.close(); }
});
