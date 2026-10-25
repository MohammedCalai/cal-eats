import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { buildFinanceSummary, filterCaseCommunications, inDateRange, parseLondonDateRange, statementCsv } from "../src/marketplace-reporting.js";

test("London date ranges use exact DST boundaries and reject impossible dates", () => {
  const spring = parseLondonDateRange(new URL("http://local/?from=2026-03-29&to=2026-03-29"));
  assert.deepEqual(spring, { from: "2026-03-29T00:00:00.000Z", toExclusive: "2026-03-29T23:00:00.000Z" });
  assert.equal(inDateRange({ created_at: "2026-03-29T22:59:59.999Z" }, spring), true);
  assert.equal(inDateRange({ created_at: "2026-03-29T23:00:00.000Z" }, spring), false);
  const autumn = parseLondonDateRange(new URL("http://local/?from=2026-10-25&to=2026-10-25"));
  assert.deepEqual(autumn, { from: "2026-10-24T23:00:00.000Z", toExclusive: "2026-10-26T00:00:00.000Z" });
  assert.throws(() => parseLondonDateRange(new URL("http://local/?from=2026-02-30")), /invalid/i);
});

function financeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE orders(id TEXT,restaurant_id TEXT,status TEXT,payment_method TEXT,total_minor INTEGER,commission_minor INTEGER,created_at TEXT);
    CREATE TABLE refunds(id TEXT,order_id TEXT,food_amount_minor INTEGER,delivery_amount_minor INTEGER,commission_reversal_minor INTEGER,created_at TEXT);
    CREATE TABLE marketplace_operations(operation_key TEXT,restaurant_id TEXT,kind TEXT,status TEXT,amount_minor INTEGER,currency TEXT,provider_mode TEXT,created_at TEXT,order_id TEXT);
    CREATE TABLE payout_batches(restaurant_id TEXT,status TEXT,amount_minor INTEGER,scheduled_for TEXT);
    CREATE TABLE cash_collections(restaurant_id TEXT,status TEXT,amount_minor INTEGER,created_at TEXT);
  `);
  return db;
}

test("finance flows respect the London range while balances remain point-in-time", () => {
  const db = financeDb();
  db.prepare("INSERT INTO orders VALUES(?,?,?,?,?,?,?)").run("old","r","completed","mock_card",1000,100,"2026-03-29T10:00:00.000Z");
  db.prepare("INSERT INTO orders VALUES(?,?,?,?,?,?,?)").run("day","r","completed","mock_card",2000,200,"2026-03-29T12:00:00.000Z");
  db.prepare("INSERT INTO orders VALUES(?,?,?,?,?,?,?)").run("held-card","r","completed","mock_card",500,50,"2026-03-29T13:00:00.000Z");
  db.prepare("INSERT INTO marketplace_operations VALUES(?,?,?,?,?,?,?,?,?)").run("commission-day","r","commission","confirmed",200,"GBP","local_simulator","2026-03-29T12:01:00.000Z","day");
  db.prepare("INSERT INTO marketplace_operations VALUES(?,?,?,?,?,?,?,?,?)").run("capture-day","r","payment_capture","confirmed",2000,"GBP","local_simulator","2026-03-29T12:00:00.000Z","day");
  db.prepare("INSERT INTO marketplace_operations VALUES(?,?,?,?,?,?,?,?,?)").run("cash-accepted","r","cash_order_accepted","confirmed",1200,"GBP","local_simulator","2026-03-29T12:00:15.000Z","cash");
  db.prepare("INSERT INTO marketplace_operations VALUES(?,?,?,?,?,?,?,?,?)").run("cash-day","r","cash_sale_recorded","held",1200,"GBP","local_simulator","2026-03-29T12:00:30.000Z","cash");
  db.prepare("INSERT INTO marketplace_operations VALUES(?,?,?,?,?,?,?,?,?)").run("cost-day","r","provider_cost","confirmed",50,"GBP","local_simulator","2026-03-29T12:01:00.000Z","day");
  db.prepare("INSERT INTO marketplace_operations VALUES(?,?,?,?,?,?,?,?,?)").run("order:day:settlement-eligible","r","settlement_eligibility","confirmed",1800,"GBP","local_simulator","2026-03-29T12:02:00.000Z","day");
  db.prepare("INSERT INTO marketplace_operations VALUES(?,?,?,?,?,?,?,?,?)").run("capture-held","r","payment_capture","confirmed",500,"GBP","local_simulator","2026-03-29T13:00:00.000Z","held-card");
  db.prepare("INSERT INTO marketplace_operations VALUES(?,?,?,?,?,?,?,?,?)").run("commission-held","r","commission","confirmed",50,"GBP","local_simulator","2026-03-29T13:00:01.000Z","held-card");
  db.prepare("INSERT INTO marketplace_operations VALUES(?,?,?,?,?,?,?,?,?)").run("order:held-card:settlement-eligible","r","settlement_eligibility","held",450,"GBP","local_simulator","2026-03-29T13:00:02.000Z","held-card");
  db.prepare("INSERT INTO refunds VALUES(?,?,?,?,?,?)").run("refund","day",100,0,10,"2026-03-30T10:00:00.000Z");
  db.prepare("INSERT INTO payout_batches VALUES(?,?,?,?)").run("r","paid",500,"2026-03-30T00:00:00.000Z");
  db.prepare("INSERT INTO payout_batches VALUES(?,?,?,?)").run("r","in_transit",300,"2026-03-30T00:00:00.000Z");
  const summary = buildFinanceSummary(db,"r",new URL("http://local/?from=2026-03-29&to=2026-03-29"));
  assert.equal(summary.grossSalesMinor,4700);
  assert.equal(summary.cashCollectedMinor,1200);
  assert.equal(summary.historicalGrossSalesMinor,1000);
  assert.equal(summary.historicalCommissionMinor,100);
  assert.equal(summary.historicalNetEarningsMinor,900);
  assert.equal(summary.refundsMinor,0);
  assert.equal(summary.commissionMinor,350);
  assert.equal(summary.providerCostMinor,50);
  assert.equal(summary.availableMinor,1810); // completed balance less paid and in-transit transfers
  assert.equal(summary.heldMinor,450);
  assert.equal(summary.paidTransfersMinor,500);
  assert.equal(summary.inTransitTransfersMinor,300);
  db.close();
});

test("case communications are isolated by their explicit audience", () => {
  const messages=[{id:"public",audience:"public"},{id:"customer",audience:"customer"},{id:"restaurant",audience:"restaurant"},{id:"admin",audience:"admin"},{id:"internal",audience:"internal"}];
  const events=[{kind:"submitted"},{kind:"ask_restaurant",details:'{"audience":"restaurant"}'},{kind:"customer_replied"},{kind:"request_information"}];
  assert.deepEqual(filterCaseCommunications({messages,events,viewerRole:"customer"}).messages.map(x=>x.id),["public","customer"]);
  assert.deepEqual(filterCaseCommunications({messages,events,viewerRole:"restaurant"}).messages.map(x=>x.id),["public","restaurant"]);
  assert.equal(filterCaseCommunications({messages,events,viewerRole:"admin"}).messages.length,5);
  assert.deepEqual(filterCaseCommunications({messages,events,viewerRole:"customer"}).events.map(x=>x.kind),["submitted","request_information"]);
  assert.deepEqual(filterCaseCommunications({messages,events,viewerRole:"restaurant"}).events.map(x=>x.kind),["submitted","ask_restaurant"]);
});

test("statement CSV escapes formulas and embedded quotes as inert CSV fields", () => {
  const csv=statementCsv([{operation_key:"=cmd",kind:'a"b',status:"confirmed",amount_minor:1,currency:"GBP",provider_mode:"local",created_at:"now"}]);
  assert.match(csv,/"'=cmd"/);
  assert.match(csv,/"a""b"/);
});
