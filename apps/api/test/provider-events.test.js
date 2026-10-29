import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { journeyFixture } from "./helpers.js";
import { applyProviderEventsMigration } from "../src/payments/provider-events-migration.js";
import { PROVIDER_EVENT_WEBHOOK_PATH, routeProviderEventWebhook, runProviderEventReconciliation } from "../src/payments/provider-events.js";

const SECRET = "whsec_provider_events_test_only";
const NOW_SECONDS = 1_767_225_600;

function connectOrderPayment(db) {
  const restaurant=db.prepare("SELECT id,name FROM restaurants ORDER BY created_at LIMIT 1").get();
  const customer=db.prepare("SELECT id FROM users WHERE role='customer' LIMIT 1").get();
  const id=randomUUID(),stamp=new Date(NOW_SECONDS*1000).toISOString();
  db.prepare("INSERT INTO orders(id,restaurant_id,restaurant_name,customer_id,status,subtotal_minor,delivery_fee_minor,total_minor,commission_minor,payment_method,payment_status,fulfillment,idempotency_key,request_hash,created_at,updated_at) VALUES(?,?,?,?,'placed',600,0,600,42,'card','stripe_pending','collection',?,?,?,?)").run(id,restaurant.id,restaurant.name,customer.id,`fixture:${id}`,id,stamp,stamp);
  db.prepare("INSERT INTO stripe_order_payments(order_id,provider_mode,checkout_session_id,payment_intent_id,status,created_at,updated_at) VALUES(?,'stripe_test','cs_order_events','pi_order_events','pending',?,?)").run(id,stamp,stamp);
  return {id,restaurantId:restaurant.id,facts:{ok:true,status:"confirmed",paymentState:"authorized",providerReference:"pi_order_events",paymentIntentId:"pi_order_events",amountMinor:600,currency:"GBP",orderId:id,restaurantId:restaurant.id,captureMethod:"manual",latestChargeId:"ch_order_events"}};
}

test("PaymentIntent and refund events map through the order payment without regressing captured or refunded facts", async () => {
  const f=await journeyFixture();
  try {
    const payment=connectOrderPayment(f.db);let state="authorized";
    const config=providerConfig({retrievePayment:async()=>({...payment.facts,paymentState:state})});
    await deliver(f.db,config,stripeEvent({id:"evt_order_authorized",type:"payment_intent.amount_capturable_updated",object:{id:"pi_order_events",object:"payment_intent"},account:null}));
    assert.equal((await runProviderEventReconciliation(f.db,config)).completed,1);
    assert.equal(f.db.prepare("SELECT payment_status FROM orders WHERE id=?").get(payment.id).payment_status,"stripe_authorized");
    assert.ok(f.db.prepare("SELECT merchant_visible_at FROM orders WHERE id=?").get(payment.id).merchant_visible_at);
    state="captured";
    await deliver(f.db,config,stripeEvent({id:"evt_order_captured",created:NOW_SECONDS+1,object:{id:"pi_order_events",object:"payment_intent"},account:null}));
    assert.equal((await runProviderEventReconciliation(f.db,config)).completed,1);
    assert.equal(f.db.prepare("SELECT status FROM stripe_order_payments WHERE order_id=?").get(payment.id).status,"captured");
    f.db.prepare("UPDATE orders SET payment_status='stripe_refunded' WHERE id=?").run(payment.id);
    await deliver(f.db,config,stripeEvent({id:"evt_order_refund",type:"refund.updated",created:NOW_SECONDS+2,object:{id:"re_order_events",object:"refund",payment_intent:"pi_order_events"},account:null}));
    assert.equal((await runProviderEventReconciliation(f.db,config)).completed,1);
    assert.equal(f.db.prepare("SELECT payment_status FROM orders WHERE id=?").get(payment.id).payment_status,"stripe_refunded");
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM refunds WHERE order_id=?").get(payment.id).n,0,"A PI event cannot finalize a refund");
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM marketplace_operations WHERE order_id=?").get(payment.id).n,0,"Payment event observation cannot fabricate ledger operations");
  } finally { await f.close(); }
});

test("order PaymentIntent reconciliation rejects incorrect financial and tenant facts", async () => {
  const f=await journeyFixture();
  try {
    const payment=connectOrderPayment(f.db);let facts=payment.facts;
    const config=providerConfig({retrievePayment:async()=>facts});
    for(const [index,override] of [{amountMinor:601},{restaurantId:"different-restaurant"},{orderId:"different-order"},{captureMethod:"automatic"},{paymentIntentId:"pi_wrong"}].entries()) {
      facts={...payment.facts,...override};
      const eventId=`evt_order_bad_${index}`;
      await deliver(f.db,config,stripeEvent({id:eventId,object:{id:"pi_order_events",object:"payment_intent"},account:null}));
      assert.equal((await runProviderEventReconciliation(f.db,config)).failed,1);
      assert.equal(f.db.prepare("SELECT error FROM provider_events WHERE provider_event_id=?").get(eventId).error,"PAYMENT_ORDER_BINDING_MISMATCH");
    }
    assert.equal(f.db.prepare("SELECT status FROM stripe_order_payments WHERE order_id=?").get(payment.id).status,"pending");
    assert.equal(f.db.prepare("SELECT payment_status FROM orders WHERE id=?").get(payment.id).payment_status,"stripe_pending");
  } finally { await f.close(); }
});

test("a PaymentIntent order binding cannot cross a connected-account event scope", async () => {
  const f=await journeyFixture();
  try {
    connectOrderPayment(f.db);
    const config=providerConfig({retrievePayment:async()=>assert.fail("Conflicting account must not be queried")});
    const delivered=await deliver(f.db,config,stripeEvent({id:"evt_wrong_order_account",object:{id:"pi_order_events",object:"payment_intent"},account:"acct_other_restaurant"}));
    assert.equal(delivered.status,200);
    assert.equal(f.db.prepare("SELECT status,error FROM provider_events WHERE provider_event_id='evt_wrong_order_account'").get().error,"TENANT_MAPPING_CONFLICT");
  } finally { await f.close(); }
});

function signed(event, timestamp = NOW_SECONDS) {
  const rawBody = Buffer.from(JSON.stringify(event));
  const signature = createHmac("sha256", SECRET).update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody])).digest("hex");
  return { rawBody, signature: `t=${timestamp},v1=${signature}` };
}

function stripeEvent({ id = "evt_test_1", type = "payment_intent.succeeded", created = NOW_SECONDS, livemode = false, object = { id: "pi_test_1", object: "payment_intent" }, account = "acct_test_1" } = {}) {
  return { id, type, created, livemode, account, data: { object } };
}

async function deliver(db, config, event, { timestamp = NOW_SECONDS, signature, contentType = "application/json" } = {}) {
  const body = signed(event, timestamp);
  const req = Readable.from([body.rawBody]);
  Object.assign(req, { method: "POST", headers: { "content-type": contentType, "stripe-signature": signature ?? body.signature } });
  let response;
  const res = {
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(chunk) { response = { status: this.statusCode, body: JSON.parse(String(chunk)) }; }
  };
  const handled = await routeProviderEventWebhook({ req, res, url: new URL(PROVIDER_EVENT_WEBHOOK_PATH, "http://localhost"), db, config });
  assert.equal(handled, true);
  return response;
}

function providerConfig(adapter, now = new Date(NOW_SECONDS * 1000)) {
  return { paymentProviderMode: "stripe_test", paymentProvider: adapter, paymentProviderWebhookSecret: SECRET, now: () => now };
}

function connectPayment(db, restaurantId, reference = "pi_test_1", accountReference = "acct_test_1") {
  const now = new Date(NOW_SECONDS * 1000).toISOString();
  db.prepare("INSERT INTO provider_accounts(id,restaurant_id,provider_mode,status,capabilities,requirements,provider_reference,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(restaurant_id) DO UPDATE SET provider_mode=excluded.provider_mode,provider_reference=excluded.provider_reference,updated_at=excluded.updated_at")
    .run(randomUUID(), restaurantId, "stripe_test", "pending", "[]", "[]", accountReference, now, now);
  const id = randomUUID();
  db.prepare("INSERT INTO marketplace_operations(id,operation_key,restaurant_id,order_id,kind,status,amount_minor,currency,provider_mode,provider_reference,error,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, `provider-event:${id}`, restaurantId, null, "payment_capture", "pending", 1250, "GBP", "stripe_test", reference, null, "{}", now, now);
  return id;
}

test("webhook rejects missing, stale, and live signatures before any durable write", async () => {
  const f = await journeyFixture();
  try {
    applyProviderEventsMigration(f.db);
    const config = providerConfig({ retrievePayment: async () => assert.fail("must not call provider") });
    await assert.rejects(deliver(f.db, config, stripeEvent(), { signature: "" }), (error) => error.code === "INVALID_PROVIDER_SIGNATURE");
    await assert.rejects(deliver(f.db, config, stripeEvent(), { timestamp: NOW_SECONDS - 301 }), (error) => error.code === "INVALID_PROVIDER_SIGNATURE");
    await assert.rejects(deliver(f.db, config, stripeEvent({ livemode: true })), (error) => error.code === "LIVE_PROVIDER_EVENT_REJECTED");
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM provider_events").get().count, 0);
  } finally { await f.close(); }
});

test("webhook durably deduplicates identical events and rejects event ID payload substitution", async () => {
  const f = await journeyFixture();
  try {
    applyProviderEventsMigration(f.db);
    const config = providerConfig({ retrievePayment: async () => assert.fail("unmatched event must not call provider") });
    const event = stripeEvent({ id: "evt_unmatched_1", object: { id: "pi_unmatched_1", object: "payment_intent" }, account: undefined });
    const first = await deliver(f.db, config, event);
    assert.deepEqual(first.body.data, { received: true, eventId: "evt_unmatched_1", status: "delayed", replayed: false });
    const replay = await deliver(f.db, config, event);
    assert.equal(replay.body.data.replayed, true);
    await assert.rejects(deliver(f.db, config, { ...event, type: "payment_intent.processing" }), (error) => error.code === "PROVIDER_EVENT_CONFLICT");
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM provider_events").get().count, 1);
    const stored = f.db.prepare("SELECT normalized_payload,payload_fingerprint FROM provider_events").get();
    assert.equal(stored.payload_fingerprint.length, 64);
    assert.equal(stored.normalized_payload.includes("livemode"), false);
  } finally { await f.close(); }
});

test("reconciliation retrieves outside transactions, confirms captured funds, and ignores an older event", async () => {
  const f = await journeyFixture();
  try {
    applyProviderEventsMigration(f.db);
    const restaurantId = f.db.prepare("SELECT id FROM restaurants ORDER BY created_at LIMIT 1").get().id;
    const operationId = connectPayment(f.db, restaurantId);
    let calls = 0;
    const adapter = { async retrievePayment({ paymentIntentId }) {
      calls += 1;
      assert.equal(f.db.isTransaction, false);
      assert.equal(paymentIntentId, "pi_test_1");
      return { ok: true, status: "confirmed", paymentState: "captured", providerReference: paymentIntentId, latestChargeId: "ch_test_1", providerCostMinor: 44, availableOn: "2026-01-02T00:00:00.000Z" };
    } };
    const config = providerConfig(adapter);
    await deliver(f.db, config, stripeEvent({ id: "evt_capture_new", created: NOW_SECONDS }));
    const first = await runProviderEventReconciliation(f.db, config, { workerId: "worker-first" });
    assert.equal(first.completed, 1);
    const operation = f.db.prepare("SELECT status,metadata FROM marketplace_operations WHERE id=?").get(operationId);
    assert.equal(operation.status, "confirmed");
    assert.equal(JSON.parse(operation.metadata).paymentState, "captured");

    await deliver(f.db, config, stripeEvent({ id: "evt_capture_old", type: "payment_intent.payment_failed", created: NOW_SECONDS - 60 }));
    const old = await runProviderEventReconciliation(f.db, config, { workerId: "worker-second" });
    assert.equal(old.ignored, 1);
    assert.equal(calls, 1);
    assert.equal(f.db.prepare("SELECT status FROM marketplace_operations WHERE id=?").get(operationId).status, "confirmed");
    assert.equal((await deliver(f.db, config, stripeEvent({ id: "evt_capture_new", created: NOW_SECONDS }))).body.data.replayed, true);
  } finally { await f.close(); }
});

test("ambiguous retrieval is retried after restart without changing financial state", async () => {
  const f = await journeyFixture();
  try {
    applyProviderEventsMigration(f.db);
    const restaurantId = f.db.prepare("SELECT id FROM restaurants ORDER BY created_at LIMIT 1").get().id;
    const operationId = connectPayment(f.db, restaurantId, "pi_test_retry", "acct_test_retry");
    let now = new Date(NOW_SECONDS * 1000);
    let calls = 0;
    const adapter = { async retrievePayment() {
      calls += 1;
      if (calls === 1) return { ok: false, status: "unknown", errorCode: "TEST_OFFLINE" };
      return { ok: true, status: "confirmed", paymentState: "captured", providerReference: "pi_test_retry", latestChargeId: "ch_test_retry" };
    } };
    const config = { ...providerConfig(adapter), now: () => now };
    await deliver(f.db, config, stripeEvent({ id: "evt_retry_1", object: { id: "pi_test_retry", object: "payment_intent" }, account: "acct_test_retry" }));
    const offline = await runProviderEventReconciliation(f.db, config, { workerId: "before-restart", baseBackoffMs: 10 });
    assert.equal(offline.delayed, 1);
    assert.equal(f.db.prepare("SELECT status FROM marketplace_operations WHERE id=?").get(operationId).status, "pending");
    now = new Date(now.getTime() + 60_000);
    const recovered = await runProviderEventReconciliation(f.db, config, { workerId: "after-restart", baseBackoffMs: 10 });
    assert.equal(recovered.completed, 1);
    assert.equal(calls, 2);
    assert.equal(f.db.prepare("SELECT status FROM marketplace_operations WHERE id=?").get(operationId).status, "confirmed");
  } finally { await f.close(); }
});

test("Connect account and bank payout events persist authoritative readiness and payout state",async()=>{
  const f=await journeyFixture();
  try{
    applyProviderEventsMigration(f.db);
    const restaurantId=f.db.prepare("SELECT id FROM restaurants ORDER BY created_at LIMIT 1").get().id;
    const now=new Date(NOW_SECONDS*1000).toISOString();
    f.db.prepare(`INSERT INTO provider_accounts(id,restaurant_id,provider_mode,status,capabilities,requirements,provider_reference,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(restaurant_id) DO UPDATE SET provider_mode=excluded.provider_mode,provider_reference=excluded.provider_reference,updated_at=excluded.updated_at`)
      .run(randomUUID(),restaurantId,"stripe_test","pending","[]","[]","acct_connect_events",now,now);
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM provider_accounts WHERE provider_mode='stripe_test' AND provider_reference='acct_connect_events'").get().count,1);
    const adapter={
      async refreshConnectedAccount({accountId}){assert.equal(accountId,"acct_connect_events");return{ok:true,status:"confirmed",providerReference:accountId,chargesEnabled:true,payoutsEnabled:false,capabilities:["card_payments"],requirements:[]};},
      async retrievePayout({payoutId,accountId}){assert.equal(payoutId,"po_connect_events");assert.equal(accountId,"acct_connect_events");return{ok:true,status:"pending",paymentState:"pending",providerReference:payoutId,amountMinor:4321,arrivalAt:"2026-01-03T00:00:00.000Z"};}
    };
    const config=providerConfig(adapter);
    await deliver(f.db,config,stripeEvent({id:"evt_account_ready",type:"account.updated",object:{id:"acct_connect_events",object:"account"},account:"acct_connect_events"}));
    const accountSummary=await runProviderEventReconciliation(f.db,config,{workerId:"account-worker"});
    assert.equal(accountSummary.completed,1,JSON.stringify({accountSummary,event:f.db.prepare("SELECT status,error FROM provider_events WHERE provider_event_id='evt_account_ready'").get()}));
    assert.deepEqual({...f.db.prepare("SELECT provider_account_id,charges_enabled,payouts_enabled FROM stripe_account_readiness WHERE restaurant_id=? AND provider_mode='stripe_test'").get(restaurantId)},{provider_account_id:"acct_connect_events",charges_enabled:1,payouts_enabled:0});
    await deliver(f.db,config,stripeEvent({id:"evt_payout_pending",type:"payout.updated",object:{id:"po_connect_events",object:"payout"},account:"acct_connect_events"}));
    assert.equal((await runProviderEventReconciliation(f.db,config,{workerId:"payout-worker"})).completed,1);
    assert.deepEqual({...f.db.prepare("SELECT restaurant_id,provider_account_id,amount_minor,status,arrival_at,failure FROM stripe_connected_payouts WHERE id=?").get("po_connect_events")},{restaurant_id:restaurantId,provider_account_id:"acct_connect_events",amount_minor:4321,status:"pending",arrival_at:"2026-01-03T00:00:00.000Z",failure:null});
  }finally{await f.close();}
});

test("local simulator mode never accepts events or invokes an injected adapter", async () => {
  const f = await journeyFixture();
  try {
    applyProviderEventsMigration(f.db);
    const adapter = { retrievePayment: async () => assert.fail("must remain inert") };
    const config = { paymentProviderMode: "local_simulator", paymentProvider: adapter, paymentProviderWebhookSecret: SECRET, now: () => new Date(NOW_SECONDS * 1000) };
    await assert.rejects(deliver(f.db, config, stripeEvent()), (error) => error.code === "PROVIDER_WEBHOOK_DISABLED");
    assert.deepEqual(await runProviderEventReconciliation(f.db, config), { claimed: 0, completed: 0, delayed: 0, failed: 0, unmatched: 0, ignored: 0, skipped: "provider_disabled" });
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM provider_events").get().count, 0);
  } finally { await f.close(); }
});
