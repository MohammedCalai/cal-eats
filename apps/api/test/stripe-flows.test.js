import test from "node:test";
import assert from "node:assert/strict";
import { migrateDatabase, openDatabase } from "../src/db/index.js";
import { queueEligibleStripeTransfers } from "../src/payments/stripe-settlement.js";
import { runStripeConnectWorker } from "../src/payments/stripe-connect.js";

const stamp = "2026-10-27T12:00:00.000Z";

function fixture(adapter) {
  const db = openDatabase(":memory:");
  migrateDatabase(db);
  db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES('customer','Fixture','fixture@example.invalid','unused','customer',?)").run(stamp);
  db.prepare("INSERT INTO restaurants(id,name,status,created_at) VALUES('restaurant','Fixture kitchen','approved',?)").run(stamp);
  db.prepare(`INSERT INTO orders(id,restaurant_id,restaurant_name,customer_id,status,subtotal_minor,delivery_fee_minor,total_minor,
    commission_minor,payment_method,payment_status,fulfillment,idempotency_key,request_hash,created_at,updated_at)
    VALUES('order','restaurant','Fixture kitchen','customer','completed',2000,0,2000,140,'card','stripe_captured','collection','fixture','fixture',?,?)`).run(stamp, stamp);
  db.prepare("INSERT INTO stripe_order_payments(order_id,provider_mode,payment_intent_id,latest_charge_id,status,created_at,updated_at) VALUES('order','stripe_test','pi_fixture','ch_fixture','captured',?,?)").run(stamp, stamp);
  db.prepare("INSERT INTO provider_accounts VALUES('account','restaurant','stripe_test','enabled',?,'[]','acct_restaurant',?,?)").run(JSON.stringify(["transfers", "card_payments"]), stamp, stamp);
  db.prepare("INSERT INTO stripe_account_readiness VALUES('restaurant','stripe_test','acct_restaurant',1,1,?)").run(stamp);
  db.prepare("INSERT INTO marketplace_operations VALUES('eligible','order:order:settlement-eligible','restaurant','order','settlement_eligibility','confirmed',1860,'GBP','stripe_test',NULL,NULL,'{}',?,?)").run(stamp, stamp);
  const config = {
    paymentProviderMode: "stripe_test",
    stripePlatformAccountId: "acct_platform",
    paymentProviderWebhookSecret: "whsec_platform",
    paymentProviderConnectWebhookSecret: "whsec_connect",
    stripeProvider: adapter,
    orderExpiryMinutes: 15,
    now: () => new Date(stamp),
  };
  return { db, config };
}

test("worker revalidates an immutable transfer snapshot before provider I/O", async () => {
  let transfers = 0;
  const adapter = {
    retrievePlatformAccount: async () => ({ providerReference: "acct_platform", status: "confirmed" }),
    createTransfer: async () => { transfers += 1; return { status: "confirmed", providerReference: "tr_fixture" }; },
  };
  const { db, config } = fixture(adapter);
  try {
    assert.equal(queueEligibleStripeTransfers(db, config).queued, 1);
    db.prepare("UPDATE orders SET total_minor=1900 WHERE id='order'").run();
    const result = await runStripeConnectWorker(db, config);
    assert.equal(result.failed, 1);
    assert.equal(transfers, 0);
    assert.equal(db.prepare("SELECT status FROM marketplace_operations WHERE kind='merchant_transfer'").get().status, "held");
  } finally { db.close(); }
});

test("worker reclaims an expired lease and retrieves a referenced transfer without posting twice", async () => {
  let creates = 0;
  let retrieves = 0;
  const adapter = {
    retrievePlatformAccount: async () => ({ providerReference: "acct_platform", status: "confirmed" }),
    createTransfer: async () => { creates += 1; return { status: "confirmed", providerReference: "tr_duplicate" }; },
    retrieveTransfer: async ({ transferId }) => { retrieves += 1; return { status: "confirmed", providerReference: transferId, amountMinor:1860, currency:"GBP", destinationAccountId:"acct_restaurant", sourceTransactionId:"ch_fixture", transferGroup:"order:order" }; },
  };
  const { db, config } = fixture(adapter);
  try {
    queueEligibleStripeTransfers(db, config);
    db.prepare("UPDATE marketplace_operations SET provider_reference='tr_existing' WHERE kind='merchant_transfer'").run();
    db.prepare("UPDATE marketplace_worker_jobs SET status='claimed',lease_owner='dead-worker',lease_expires_at='2020-01-01T00:00:00.000Z' WHERE kind='stripe_transfer'").run();
    const result = await runStripeConnectWorker(db, config, { workerId: "recovery-worker" });
    assert.equal(result.completed, 1);
    assert.equal(retrieves, 1);
    assert.equal(creates, 0);
    assert.equal(db.prepare("SELECT status FROM marketplace_worker_jobs WHERE kind='stripe_transfer'").get().status, "completed");
  } finally { db.close(); }
});

test("a pending refund is retrieved to confirmation and finalized exactly once", async () => {
  let refundPosts = 0;
  let refundRetrieves = 0;
  const adapter = {
    retrievePlatformAccount: async () => ({ providerReference: "acct_platform", status: "confirmed" }),
    refundPayment: async () => { refundPosts += 1; return { status: "pending", providerReference: "re_fixture" }; },
    retrieveRefund: async ({ refundId }) => { refundRetrieves += 1; return { status: "confirmed", providerReference: refundId, amountMinor:500, currency:"GBP", paymentIntentId:"pi_fixture", orderId:"order", restaurantId:"restaurant" }; },
  };
  const { db, config } = fixture(adapter);
  try {
    db.prepare(`INSERT INTO refund_cases(id,reference,order_id,restaurant_id,customer_id,status,reason,item_ids,description,issue_hash,
      requested_amount_minor,approved_amount_minor,remedy,execution_status,provider_mode,monthly_review_flag,created_at,updated_at)
      VALUES('case','RC-FIXTURE','order','restaurant','customer','refund_processing','quality','[]','Fixture refund','fixture-refund',500,500,'refund','pending','stripe_test',0,?,?)`).run(stamp, stamp);
    db.prepare(`INSERT INTO marketplace_operations(id,operation_key,restaurant_id,order_id,kind,status,amount_minor,currency,provider_mode,metadata,created_at,updated_at)
      VALUES('refund-op','refund-case:case:stripe','restaurant','order','order_refund','pending',500,'GBP','stripe_test','{}',?,?)`).run(stamp, stamp);
    db.prepare(`INSERT INTO marketplace_worker_jobs(id,kind,entity_id,operation_key,status,attempts,payload,available_at,created_at,updated_at)
      VALUES('refund-job','stripe_refund','case','refund-case:case:stripe','queued',0,?,'2020-01-01T00:00:00.000Z',?,?)`).run(JSON.stringify({ caseId: "case", paymentIntentId: "pi_fixture", amountMinor: 500 }), stamp, stamp);

    const pending = await runStripeConnectWorker(db, config, { workerId: "refund-worker" });
    assert.equal(pending.retried, 1);
    assert.equal(refundPosts, 1);
    assert.equal(db.prepare("SELECT execution_status FROM refund_cases WHERE id='case'").get().execution_status, "provider_pending");

    db.prepare("UPDATE marketplace_worker_jobs SET available_at='2020-01-01T00:00:00.000Z' WHERE id='refund-job'").run();
    const confirmed = await runStripeConnectWorker(db, config, { workerId: "refund-worker-2" });
    assert.equal(confirmed.completed, 1);
    assert.equal(refundRetrieves, 1);
    assert.equal(refundPosts, 1);
    assert.equal(db.prepare("SELECT execution_status FROM refund_cases WHERE id='case'").get().execution_status, "confirmed");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM refunds WHERE order_id='order' AND mode='stripe_card'").get().n, 1);
  } finally { db.close(); }
});

test("abandoned unfilled Stripe checkout is expired before rejecting the local order", async () => {
  let expired=false,expirations=0;
  const adapter={
    retrievePlatformAccount:async()=>({providerReference:"acct_platform",status:"confirmed"}),
    retrieveCheckoutSession:async()=>({status:"confirmed",paymentState:expired?"expired":"pending",amountMinor:2000,currency:"GBP",orderId:"order",restaurantId:"restaurant",paymentIntentId:null}),
    expireCheckoutSession:async()=>{expirations+=1;expired=true;return{status:"confirmed",paymentState:"expired"};}
  };
  const {db,config}=fixture(adapter);
  try {
    db.exec("UPDATE orders SET status='placed',payment_status='stripe_pending',created_at='2026-10-27T10:00:00.000Z'; UPDATE stripe_order_payments SET status='pending',checkout_session_id='cs_fixture',payment_intent_id=NULL,latest_charge_id=NULL");
    await runStripeConnectWorker(db,config);
    assert.equal(expirations,1);
    assert.equal(db.prepare("SELECT status FROM orders WHERE id='order'").get().status,"rejected");
    assert.equal(db.prepare("SELECT desired_status,state FROM stripe_order_decisions WHERE order_id='order'").get().state,"confirmed");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM marketplace_operations WHERE kind='merchant_transfer'").get().n,0);
  } finally {db.close();}
});
