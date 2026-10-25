import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createStripeTestAdapter, parseStripeWebhook, STRIPE_API_VERSION, StripeTestConfigurationError, verifyStripeWebhook } from "../src/payments/stripe-test.js";

const KEY = "sk_test_unit_only_not_a_real_key";
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("configuration is test-only and rejects live or custom production transport", () => {
  assert.throws(() => createStripeTestAdapter({ secretKey: "sk_live_forbidden" }), StripeTestConfigurationError);
  assert.throws(() => createStripeTestAdapter({ secretKey: KEY, mode: "live" }), /non-test/);
  assert.throws(() => createStripeTestAdapter({ secretKey: KEY, baseUrl: "https://stripe.invalid" }), /injected test fetch/);
  assert.throws(() => createStripeTestAdapter({ secretKey: KEY, baseUrl: "https://stripe.invalid", allowTestTransport:true }), /injected test fetch/);
});

test("mutations pin version, require idempotency and encode manual authorization", async () => {
  let captured;
  const adapter = createStripeTestAdapter({ secretKey: KEY, allowTestTransport: true, baseUrl: "https://stripe.invalid", fetchImpl: async (url, init) => {
    captured = { url: String(url), init };
    return jsonResponse({ id: "pi_test123", livemode: false, status: "requires_capture" });
  }});
  await assert.rejects(adapter.authorizePayment({ amountMinor: 1200, paymentMethodId: "pm_test123", transferGroup: "order-group", orderId: "order-1" }), /idempotencyKey/);
  const result = await adapter.authorizePayment({ amountMinor: 1200, paymentMethodId: "pm_test123", transferGroup: "order-group", orderId: "order-1", idempotencyKey: "authorize-order-1" });
  assert.deepEqual(result, { ok: true, providerCostMinor: undefined, status: "confirmed", paymentState:"authorized", providerReference: "pi_test123", latestChargeId:undefined, availableOn:undefined, errorCode: undefined });
  assert.equal(captured.init.headers["Stripe-Version"], STRIPE_API_VERSION);
  assert.equal(captured.init.headers["Idempotency-Key"], "authorize-order-1");
  assert.equal(captured.init.redirect, "error");
  assert.match(String(captured.init.body), /capture_method=manual/);
  assert.match(String(captured.init.body), /amount=1200/);
  assert.match(String(captured.init.body), /latest_charge.balance_transaction/);
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test("network ambiguity is unknown rather than a false failure", async () => {
  const adapter = createStripeTestAdapter({ secretKey: KEY, allowTestTransport: true, baseUrl: "https://stripe.invalid", fetchImpl: async () => { throw new TypeError("socket closed"); } });
  const result = await adapter.capturePayment({ paymentIntentId: "pi_test123", idempotencyKey: "capture-order-1" });
  assert.equal(result.ok, false);
  assert.equal(result.status, "unknown");
  assert.equal(result.providerReference, "pi_test123");
  assert.equal(result.errorCode, "STRIPE_NETWORK_AMBIGUOUS");
});

test("retryable HTTP failures are unknown and definitive card errors are failed", async () => {
  const responses = [jsonResponse({ error: { type: "api_error", code: "api_error" } }, 500), jsonResponse({ error: { type: "card_error", code: "card_declined" } }, 402)];
  const adapter = createStripeTestAdapter({ secretKey: KEY, allowTestTransport: true, baseUrl: "https://stripe.invalid", fetchImpl: async () => responses.shift() });
  assert.equal((await adapter.capturePayment({ paymentIntentId: "pi_test123", idempotencyKey: "capture-one" })).status, "unknown");
  const declined = await adapter.capturePayment({ paymentIntentId: "pi_test123", idempotencyKey: "capture-two" });
  assert.equal(declined.status, "failed");
  assert.equal(declined.errorCode, "card_declined");
});

test("live-mode objects are rejected even with a test-key configuration", async () => {
  const adapter = createStripeTestAdapter({ secretKey: KEY, allowTestTransport: true, baseUrl: "https://stripe.invalid", fetchImpl: async () => jsonResponse({ id: "acct_test123", livemode: true }) });
  await assert.rejects(adapter.refreshConnectedAccount({ accountId: "acct_test123" }), StripeTestConfigurationError);
});

test("money responses require explicit test mode and cancellation is a confirmed operation", async () => {
  const responses=[jsonResponse({id:"pi_test123",status:"succeeded"}),jsonResponse({id:"pi_test123",livemode:false,status:"canceled"})];
  const adapter=createStripeTestAdapter({secretKey:KEY,allowTestTransport:true,baseUrl:"https://stripe.invalid",fetchImpl:async()=>responses.shift()});
  await assert.rejects(adapter.retrievePayment({paymentIntentId:"pi_test123"}),/unverified or live-mode/);
  const cancelled=await adapter.cancelPayment({paymentIntentId:"pi_test123",idempotencyKey:"cancel-order-1"});
  assert.equal(cancelled.status,"confirmed");
  assert.equal(cancelled.paymentState,"cancelled");
});

test("retrieval surfaces expanded provider fee and availability", async () => {
  const adapter=createStripeTestAdapter({secretKey:KEY,allowTestTransport:true,baseUrl:"https://stripe.invalid",fetchImpl:async()=>jsonResponse({id:"pi_test123",livemode:false,status:"succeeded",latest_charge:{id:"ch_test123",balance_transaction:{fee:44,available_on:1_700_000_500}}})});
  const result=await adapter.retrievePayment({paymentIntentId:"pi_test123"});
  assert.equal(result.paymentState,"captured");
  assert.equal(result.latestChargeId,"ch_test123");
  assert.equal(result.providerCostMinor,44);
  assert.equal(result.availableOn,"2023-11-14T22:21:40.000Z");
});

test("transfers require captured source transaction and payouts are account scoped", async () => {
  const calls=[];
  const adapter=createStripeTestAdapter({secretKey:KEY,allowTestTransport:true,baseUrl:"https://stripe.invalid",fetchImpl:async(url,init)=>{calls.push({url:String(url),init});return calls.length===1?jsonResponse({id:"tr_test123",livemode:false,source_transaction:"ch_test123"}):jsonResponse({object:"list",data:[{id:"po_test123",livemode:false,status:"paid",amount:900,arrival_date:1_700_000_500}],has_more:false})}});
  await assert.rejects(adapter.createTransfer({amountMinor:900,destinationAccountId:"acct_test123",transferGroup:"order-group",operationKey:"transfer-order-1",idempotencyKey:"transfer-order-1"}),/ch reference/);
  const transfer=await adapter.createTransfer({amountMinor:900,destinationAccountId:"acct_test123",sourceTransactionId:"ch_test123",transferGroup:"order-group",operationKey:"transfer-order-1",idempotencyKey:"transfer-order-1"});
  assert.equal(transfer.sourceTransactionId,"ch_test123");
  assert.match(String(calls[0].init.body),/source_transaction=ch_test123/);
  const payouts=await adapter.listPayouts({accountId:"acct_test123",limit:10});
  assert.equal(calls[1].init.headers["Stripe-Account"],"acct_test123");
  assert.equal(payouts.items[0].paymentState,"paid");
  assert.equal(payouts.items[0].status,"confirmed");
});

test("connected account result exposes capability and requirement state", async () => {
  const adapter = createStripeTestAdapter({ secretKey: KEY, allowTestTransport: true, baseUrl: "https://stripe.invalid", fetchImpl: async () => jsonResponse({ id: "acct_test123", livemode: false, charges_enabled: false, payouts_enabled: false, capabilities: { transfers: "active", card_payments: "pending" }, requirements: { currently_due: ["company.tax_id"], past_due: [] } }) });
  const result = await adapter.refreshConnectedAccount({ accountId: "acct_test123" });
  assert.equal(result.status, "pending");
  assert.deepEqual(result.capabilities, ["transfers"]);
  assert.deepEqual(result.requirements, ["company.tax_id"]);
});

test("webhook verification uses raw bytes, timestamp tolerance and rejects live events", () => {
  const secret = "whsec_test_only_secret";
  const timestamp = 1_700_000_000;
  const body = Buffer.from(JSON.stringify({ id: "evt_test", type: "payment_intent.succeeded", livemode: false, data: { object: { id: "pi_test123" } } }));
  const signature = createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`${timestamp}.`), body])).digest("hex");
  const header = `t=${timestamp},v1=${signature}`;
  assert.equal(verifyStripeWebhook({ rawBody: body, signatureHeader: header, secret, nowSeconds: timestamp }), true);
  assert.equal(verifyStripeWebhook({ rawBody: Buffer.from(`${body} `), signatureHeader: header, secret, nowSeconds: timestamp }), false);
  assert.equal(verifyStripeWebhook({ rawBody: body, signatureHeader: header, secret, nowSeconds: timestamp + 301 }), false);
  assert.throws(() => verifyStripeWebhook({ rawBody: body, signatureHeader: header, secret, nowSeconds: Number.NaN }), /invalid/);
  assert.throws(() => verifyStripeWebhook({ rawBody: body, signatureHeader: header, secret, nowSeconds: timestamp, toleranceSeconds: 0 }), /invalid/);
  assert.equal(parseStripeWebhook({ rawBody: body, signatureHeader: header, secret, nowSeconds: timestamp }).id, "evt_test");
  const live = Buffer.from(JSON.stringify({ id: "evt_live", type: "payment_intent.succeeded", livemode: true, data: { object: {} } }));
  const liveSig = createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`${timestamp}.`), live])).digest("hex");
  assert.throws(() => parseStripeWebhook({ rawBody: live, signatureHeader: `t=${timestamp},v1=${liveSig}`, secret, nowSeconds: timestamp }), StripeTestConfigurationError);
});
