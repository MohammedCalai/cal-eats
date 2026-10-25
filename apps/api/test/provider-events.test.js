import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { journeyFixture } from "./helpers.js";
import { applyProviderEventsMigration } from "../src/payments/provider-events-migration.js";
import { PROVIDER_EVENT_WEBHOOK_PATH, routeProviderEventWebhook, runProviderEventReconciliation } from "../src/payments/provider-events.js";

const SECRET = "whsec_provider_events_test_only";
const NOW_SECONDS = 1_767_225_600;

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
