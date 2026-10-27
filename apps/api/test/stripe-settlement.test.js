import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrateDatabase } from "../src/db/index.js";
import { queueEligibleStripeTransfers } from "../src/payments/stripe-settlement.js";
import { queueStripeTransferReversal } from "../src/marketplace.js";
import { buildFinanceSummary } from "../src/marketplace-reporting.js";

const stamp = "2026-10-27T12:00:00.000Z";
const config = { paymentProviderMode: "stripe_test", stripePlatformAccountId: "acct_platform", now: () => new Date(stamp) };
function fixture() {
  const db = openDatabase(":memory:"); migrateDatabase(db);
  db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES('customer','Fixture','fixture@example.invalid','unused','customer',?)").run(stamp);
  db.prepare("INSERT INTO restaurants(id,name,status,created_at) VALUES('restaurant','Fixture kitchen','approved',?)").run(stamp);
  db.prepare(`INSERT INTO orders(id,restaurant_id,restaurant_name,customer_id,status,subtotal_minor,delivery_fee_minor,total_minor,
    commission_minor,payment_method,payment_status,fulfillment,idempotency_key,request_hash,created_at,updated_at)
    VALUES('order','restaurant','Fixture kitchen','customer','accepted',2000,0,2000,140,'card','stripe_captured','collection','fixture','fixture',?,?)`).run(stamp, stamp);
  db.prepare("INSERT INTO stripe_order_payments(order_id,provider_mode,payment_intent_id,latest_charge_id,status,created_at,updated_at) VALUES('order','stripe_test','pi_fixture','ch_fixture','captured',?,?)").run(stamp, stamp);
  db.prepare("INSERT INTO provider_accounts VALUES('account','restaurant','stripe_test','enabled',?, '[]','acct_restaurant',?,?)").run(JSON.stringify(["transfers", "card_payments"]), stamp, stamp);
  db.prepare("INSERT INTO stripe_account_readiness VALUES('restaurant','stripe_test','acct_restaurant',1,1,?)").run(stamp);
  db.prepare("INSERT INTO marketplace_operations VALUES('eligible','order:order:settlement-eligible','restaurant','order','settlement_eligibility','confirmed',1860,'GBP','stripe_test',NULL,NULL,'{}',?,?)").run(stamp, stamp);
  return db;
}

test("Stripe settlement queues once only after persisted completion and captured payment", () => {
  const db = fixture();
  try {
    assert.equal(queueEligibleStripeTransfers(db, config).queued, 0);
    db.exec("UPDATE orders SET status='completed'; UPDATE stripe_order_payments SET status='authorized'");
    assert.equal(queueEligibleStripeTransfers(db, config).queued, 0);
    db.exec("UPDATE stripe_order_payments SET status='captured'");
    assert.equal(queueEligibleStripeTransfers(db, config).queued, 1);
    assert.equal(queueEligibleStripeTransfers(db, config).queued, 0);
    const job = db.prepare("SELECT * FROM marketplace_worker_jobs WHERE kind='stripe_transfer'").get();
    const snapshot = JSON.parse(job.payload);
    assert.equal(snapshot.amountMinor, 1860);
    assert.equal(snapshot.commissionMinor, 140);
    assert.equal(snapshot.accountId, "acct_restaurant");
    assert.equal(snapshot.platformAccountId, "acct_platform");
    assert.equal(snapshot.sourceCharge, "ch_fixture");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM journal_postings").get().n, 0);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

test("settlement holds cross-mode accounts and open disputes, then uses net refunds and reversed commission", () => {
  const db = fixture();
  try {
    db.exec("UPDATE orders SET status='completed'; UPDATE provider_accounts SET provider_mode='stripe_live'");
    assert.equal(queueEligibleStripeTransfers(db, config).queued, 0);
    db.exec("UPDATE provider_accounts SET provider_mode='stripe_test'");
    db.prepare(`INSERT INTO refund_cases(id,reference,order_id,restaurant_id,customer_id,status,reason,item_ids,description,issue_hash,
      requested_amount_minor,monthly_review_flag,created_at,updated_at)
      VALUES('case','fixture','order','restaurant','customer','awaiting_restaurant','quality','[]','Fixture','fixture',500,0,?,?)`).run(stamp, stamp);
    assert.equal(queueEligibleStripeTransfers(db, config).queued, 0);
    db.prepare("INSERT INTO refunds(id,order_id,actor_user_id,idempotency_key,request_hash,food_amount_minor,delivery_amount_minor,reason,mode,commission_reversal_minor,created_at) VALUES('case-case','order','customer','refund','refund',500,0,'Fixture','stripe_card',35,?)").run(stamp);
    db.prepare("UPDATE refund_cases SET resolved_at=?,status='refunded' WHERE id='case'").run(stamp);
    assert.equal(queueEligibleStripeTransfers(db, config).queued, 1);
    const snapshot = JSON.parse(db.prepare("SELECT payload FROM marketplace_worker_jobs WHERE kind='stripe_transfer'").get().payload);
    assert.equal(snapshot.refundsMinor, 500);
    assert.equal(snapshot.commissionMinor, 105);
    assert.equal(snapshot.amountMinor, 1395);
    db.exec("UPDATE marketplace_operations SET status='confirmed',provider_reference='tr_fixture' WHERE kind='merchant_transfer'; UPDATE refund_cases SET execution_status='confirmed',provider_mode='stripe_test' WHERE id='case'");
    assert.equal(queueStripeTransferReversal(db,{caseId:"case",now:stamp}),null);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM marketplace_worker_jobs WHERE kind='stripe_transfer_reversal'").get().n,0);
  } finally { db.close(); }
});

test("a restaurant transfer is reserved once and is distinct from a confirmed bank payout", () => {
  const db=fixture();
  try {
    db.exec("UPDATE orders SET status='completed'");
    assert.equal(buildFinanceSummary(db,"restaurant").availableMinor,1860);
    queueEligibleStripeTransfers(db,config);
    let summary=buildFinanceSummary(db,"restaurant");
    assert.equal(summary.availableMinor,0);
    assert.equal(summary.pendingTransfersMinor,1860);
    assert.equal(summary.bankPaidMinor,0);
    db.exec("UPDATE marketplace_operations SET status='confirmed',provider_reference='tr_fixture' WHERE kind='merchant_transfer'");
    db.prepare("INSERT INTO stripe_connected_payouts VALUES('po_fixture','restaurant','acct_restaurant',1000,'paid',?,NULL,?,?)").run(stamp,stamp,stamp);
    summary=buildFinanceSummary(db,"restaurant");
    assert.equal(summary.paidTransfersMinor,1860);
    assert.equal(summary.bankPaidMinor,1000);
    assert.equal(summary.availableMinor,0);
    assert.equal(summary.providerCostsPendingCount,1);
  } finally {db.close();}
});
