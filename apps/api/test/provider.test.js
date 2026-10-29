import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createStripeAdapter, createStripeTestAdapter, parseStripeWebhook, STRIPE_API_VERSION, StripeTestConfigurationError, verifyStripeWebhook } from "../src/payments/stripe-test.js";

const KEY = "sk_test_unit_only_not_a_real_key";
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("Stripe hosted Checkout preserves its provider fragment on create and retrieval", async () => {
  const checkoutUrl = "https://checkout.stripe.com/c/pay/cs_test_fragment#fidkdWxOYHwnPyd1blpxYHZxWjA0";
  const adapter = createStripeTestAdapter({ secretKey: KEY, fetchImpl: async () => jsonResponse({
    id: "cs_test_fragment", object: "checkout.session", livemode: false,
    status: "open", amount_total: 1200, currency: "gbp", url: checkoutUrl,
    metadata: { order_id: "order-1", restaurant_id: "restaurant-1" },
  }) });
  const created = await adapter.createCheckoutSession({ orderId: "order-1", restaurantId: "restaurant-1", amountMinor: 1200,
    transferGroup: "order:order-1", successUrl: "https://eats.example.test/order/?success=1",
    cancelUrl: "https://eats.example.test/order/?cancelled=1", idempotencyKey: "checkout-fragment-1" });
  assert.equal(created.checkoutUrl, checkoutUrl);
  assert.equal(created.url, checkoutUrl);
  const retrieved = await adapter.retrieveCheckoutSession({ sessionId: created.providerReference });
  assert.equal(retrieved.checkoutUrl, checkoutUrl);
  assert.equal(retrieved.amountMinor, 1200);
  assert.equal(retrieved.orderId, "order-1");
});

test("provider Checkout URLs reject hostile origins, credentials and nondefault ports", async () => {
  for (const url of [
    "http://checkout.stripe.com/c/pay/cs_test_hostile#fragment",
    "https://checkout.stripe.com.attacker.invalid/c/pay/cs_test_hostile#fragment",
    "https://checkout.stripe.com@attacker.invalid/c/pay/cs_test_hostile#fragment",
    "https://attacker.invalid@checkout.stripe.com/c/pay/cs_test_hostile#fragment",
    "https://user:password@checkout.stripe.com/c/pay/cs_test_hostile#fragment",
    "https://checkout.stripe.com:8443/c/pay/cs_test_hostile#fragment",
    "https://checkout.stripe.com./c/pay/cs_test_hostile#fragment",
  ]) {
    const adapter = createStripeTestAdapter({ secretKey: KEY, fetchImpl: async () => jsonResponse({
      id: "cs_test_hostile", object: "checkout.session", livemode: false, status: "open", url,
    }) });
    await assert.rejects(adapter.retrieveCheckoutSession({ sessionId: "cs_test_hostile" }), /Checkout URL must use/);
  }
});

test("allowing a Stripe Checkout fragment does not loosen customer return URL validation", async () => {
  let requests = 0;
  const adapter = createStripeTestAdapter({ secretKey: KEY, fetchImpl: async () => { requests++; throw Error("unexpected request"); } });
  const input = { orderId: "order-1", restaurantId: "restaurant-1", amountMinor: 1200, transferGroup: "order:order-1",
    successUrl: "https://eats.example.test/order/", cancelUrl: "https://eats.example.test/order/", idempotencyKey: "checkout-return-1" };
  for (const property of ["successUrl", "cancelUrl"]) {
    for (const value of ["https://eats.example.test/order/#fragment", "https://user@eats.example.test/order/", "http://eats.example.test/order/"]) {
      await assert.rejects(adapter.createCheckoutSession({ ...input, [property]: value }), /HTTPS without credentials or fragment/);
    }
  }
  assert.equal(requests, 0);
});

test("configuration is test-only and rejects live or custom production transport", () => {
  assert.throws(() => createStripeTestAdapter({ secretKey: "sk_live_forbidden" }), StripeTestConfigurationError);
  assert.throws(() => createStripeTestAdapter({ secretKey: KEY, mode: "live" }), /non-test/);
  assert.throws(() => createStripeTestAdapter({ secretKey: KEY, baseUrl: "https://stripe.invalid" }), /injected test fetch/);
  assert.throws(() => createStripeTestAdapter({ secretKey: KEY, baseUrl: "https://stripe.invalid", allowTestTransport:true }), /injected test fetch/);
});

test("generic adapter requires matching mode keys and an explicit live gate",()=>{assert.throws(()=>createStripeAdapter({secretKey:"sk_live_unit",mode:"live"}),/liveEnabled/);assert.throws(()=>createStripeAdapter({secretKey:KEY,mode:"live",liveEnabled:true}),StripeTestConfigurationError);const adapter=createStripeAdapter({secretKey:"sk_live_unit",mode:"live",liveEnabled:true,allowTestTransport:true,baseUrl:"https://stripe.invalid",fetchImpl:async()=>jsonResponse({id:"acct_live",livemode:true,charges_enabled:true,payouts_enabled:true})});assert.equal(adapter.mode,"stripe_live");});

test("platform identity is normalized without exposing credentials",async()=>{const adapter=createStripeAdapter({secretKey:KEY,mode:"test",allowTestTransport:true,baseUrl:"https://stripe.invalid",fetchImpl:async()=>jsonResponse({id:"acct_platform123",country:"GB",charges_enabled:true,payouts_enabled:false})});const account=await adapter.retrievePlatformAccount();assert.equal(account.accountId,"acct_platform123");assert.equal(account.mode,"stripe_test");assert.equal(account.chargesEnabled,true);assert.equal(account.payoutsEnabled,false);assert.ok(!JSON.stringify(account).includes(KEY));});

test("hosted checkout uses manual capture and retrieval normalizes expanded payment details",async()=>{const calls=[],responses=[jsonResponse({id:"cs_test123",livemode:false,status:"open",payment_status:"unpaid",url:"https://checkout.stripe.com/session",expires_at:1_800_000_000}),jsonResponse({id:"cs_test123",livemode:false,status:"complete",payment_status:"paid",url:null,payment_intent:{id:"pi_test123",status:"requires_capture",latest_charge:{id:"ch_test123",balance_transaction:{fee:41,available_on:1_800_000_100}}}})];const adapter=createStripeAdapter({secretKey:KEY,mode:"test",allowTestTransport:true,baseUrl:"https://stripe.invalid",fetchImpl:async(url,init)=>{calls.push({url:String(url),init});return responses.shift();}});const created=await adapter.createCheckoutSession({orderId:"order-1",amountMinor:1200,restaurantId:"restaurant-1",successUrl:"https://example.test/success",cancelUrl:"https://example.test/cancel",transferGroup:"order-1",idempotencyKey:"checkout-order-1"});assert.equal(created.providerReference,"cs_test123");assert.equal(created.checkoutUrl,"https://checkout.stripe.com/session");assert.match(String(calls[0].init.body),/payment_intent_data%5Bcapture_method%5D=manual/);const retrieved=await adapter.retrieveCheckoutSession({sessionId:"cs_test123"});assert.equal(retrieved.paymentState,"authorized");assert.equal(retrieved.paymentIntentId,"pi_test123");assert.equal(retrieved.latestChargeId,"ch_test123");assert.equal(retrieved.providerCostMinor,41);assert.match(calls[1].url,/expand%5B%5D=payment_intent.latest_charge.balance_transaction/);});

test("checkout retrieval exposes immutable amount currency tenant and capture metadata",async()=>{const adapter=createStripeAdapter({secretKey:KEY,mode:"test",allowTestTransport:true,baseUrl:"https://stripe.invalid",fetchImpl:async()=>jsonResponse({id:"cs_testmeta",livemode:false,status:"complete",payment_status:"paid",amount_total:1200,currency:"gbp",metadata:{order_id:"order-1",restaurant_id:"restaurant-1"},payment_intent:{id:"pi_testmeta",status:"requires_capture",capture_method:"manual",metadata:{order_id:"order-1",restaurant_id:"restaurant-1"},latest_charge:null}})});const result=await adapter.retrieveCheckoutSession({sessionId:"cs_testmeta"});assert.equal(result.amountMinor,1200);assert.equal(result.currency,"GBP");assert.equal(result.orderId,"order-1");assert.equal(result.restaurantId,"restaurant-1");assert.equal(result.captureMethod,"manual");assert.equal(result.paymentIntentId,"pi_testmeta");});

test("hosted checkout expiration is idempotent, mode checked and normalized",async()=>{let call;const adapter=createStripeTestAdapter({secretKey:KEY,allowTestTransport:true,baseUrl:"https://stripe.invalid",fetchImpl:async(url,init)=>{call={url:String(url),init};return jsonResponse({id:"cs_testexpire",object:"checkout.session",livemode:false,status:"expired",payment_status:"unpaid",amount_total:1200,currency:"gbp",metadata:{order_id:"order-1",restaurant_id:"restaurant-1"}});}});const result=await adapter.expireCheckoutSession({sessionId:"cs_testexpire",idempotencyKey:"expire-checkout-order-1"});assert.match(call.url,/\/v1\/checkout\/sessions\/cs_testexpire\/expire$/);assert.equal(call.init.method,"POST");assert.equal(call.init.headers["Idempotency-Key"],"expire-checkout-order-1");assert.equal(result.providerReference,"cs_testexpire");assert.equal(result.paymentState,"expired");assert.equal(result.amountMinor,1200);assert.equal(result.currency,"GBP");assert.equal(result.orderId,"order-1");assert.equal(result.restaurantId,"restaurant-1");});

test("mutations pin version, require idempotency and encode manual authorization", async () => {
  let captured;
  const adapter = createStripeTestAdapter({ secretKey: KEY, allowTestTransport: true, baseUrl: "https://stripe.invalid", fetchImpl: async (url, init) => {
    captured = { url: String(url), init };
    return jsonResponse({ id: "pi_test123", livemode: false, status: "requires_capture" });
  }});
  await assert.rejects(adapter.authorizePayment({ amountMinor: 1200, paymentMethodId: "pm_test123", transferGroup: "order-group", orderId: "order-1" }), /idempotencyKey/);
  const result = await adapter.authorizePayment({ amountMinor: 1200, paymentMethodId: "pm_test123", transferGroup: "order-group", orderId: "order-1", idempotencyKey: "authorize-order-1" });
  assert.deepEqual(result, { ok: true, providerCostMinor: undefined, status: "confirmed", paymentState:"authorized", providerReference: "pi_test123", paymentIntentId:"pi_test123", latestChargeId:undefined, availableOn:undefined, errorCode: undefined });
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

test("transfer retrieval exposes immutable settlement binding fields",async()=>{const adapter=createStripeTestAdapter({secretKey:KEY,allowTestTransport:true,baseUrl:"https://stripe.invalid",fetchImpl:async()=>jsonResponse({id:"tr_testbind",object:"transfer",livemode:false,amount:875,currency:"gbp",destination:"acct_test123",source_transaction:"ch_test123",transfer_group:"order:123",reversed:false})});const result=await adapter.retrieveTransfer({transferId:"tr_testbind"});assert.equal(result.transferId,"tr_testbind");assert.equal(result.amountMinor,875);assert.equal(result.currency,"GBP");assert.equal(result.destinationAccountId,"acct_test123");assert.equal(result.sourceTransactionId,"ch_test123");assert.equal(result.transferGroup,"order:123");});

test("transfer reversal create and retrieval preserve transfer amount and currency",async()=>{const calls=[],adapter=createStripeTestAdapter({secretKey:KEY,allowTestTransport:true,baseUrl:"https://stripe.invalid",fetchImpl:async(url)=>{calls.push(String(url));return jsonResponse({id:"trr_test123",object:"transfer_reversal",livemode:false,transfer:"tr_test123",amount:400,currency:"gbp"});}});const created=await adapter.reverseTransfer({transferId:"tr_test123",amountMinor:400,idempotencyKey:"reverse-transfer-123"});assert.equal(created.reversalId,"trr_test123");assert.equal(created.transferId,"tr_test123");assert.equal(created.amountMinor,400);assert.equal(created.currency,"GBP");const retrieved=await adapter.retrieveTransferReversal({transferId:"tr_test123",reversalId:"trr_test123"});assert.equal(retrieved.providerReference,"trr_test123");assert.equal(retrieved.transferId,"tr_test123");assert.equal(retrieved.amountMinor,400);assert.match(calls[1],/\/v1\/transfers\/tr_test123\/reversals\/trr_test123$/);});

test("refund retrieval exposes payment amount currency and tenant metadata",async()=>{const adapter=createStripeTestAdapter({secretKey:KEY,allowTestTransport:true,baseUrl:"https://stripe.invalid",fetchImpl:async()=>jsonResponse({id:"re_test123",object:"refund",livemode:false,status:"succeeded",payment_intent:"pi_test123",amount:325,currency:"gbp",metadata:{order_id:"order-1",restaurant_id:"restaurant-1"}})});const result=await adapter.retrieveRefund({refundId:"re_test123"});assert.equal(result.paymentIntentId,"pi_test123");assert.equal(result.amountMinor,325);assert.equal(result.currency,"GBP");assert.equal(result.orderId,"order-1");assert.equal(result.restaurantId,"restaurant-1");});

test("connected account result exposes capability and requirement state", async () => {
  const adapter = createStripeTestAdapter({ secretKey: KEY, allowTestTransport: true, baseUrl: "https://stripe.invalid", fetchImpl: async () => jsonResponse({ id: "acct_test123", object:"account", charges_enabled: false, payouts_enabled: false, capabilities: { transfers: "active", card_payments: "pending" }, requirements: { currently_due: ["company.tax_id"], past_due: [] } }) });
  const result = await adapter.refreshConnectedAccount({ accountId: "acct_test123" });
  assert.equal(result.status, "pending");
  assert.equal(result.chargesEnabled,false);assert.equal(result.payoutsEnabled,false);
  assert.deepEqual(result.capabilities, ["transfers"]);
  assert.deepEqual(result.requirements, ["company.tax_id"]);
});

test("weekly payout schedule uses the anchor supported by the pinned Basil API", async () => {
  let call;
  const adapter = createStripeTestAdapter({ secretKey: KEY, fetchImpl: async (url, init) => {
    call = { url: String(url), init };
    return jsonResponse({ object: "balance_settings", payouts: { schedule: { interval: "weekly", weekly_anchor: "monday" } } });
  } });
  await adapter.configureWeeklyPayouts({ accountId: "acct_test123", weeklyAnchor: "monday", idempotencyKey: "weekly-payouts-1" });
  assert.equal(call.url, "https://api.stripe.com/v1/balance_settings");
  assert.equal(call.init.headers["Stripe-Version"], "2025-06-30.basil");
  assert.equal(call.init.headers["Stripe-Account"], "acct_test123");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(call.init.body)), {
    "payouts[schedule][interval]": "weekly", "payouts[schedule][weekly_anchor]": "monday",
  });
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
