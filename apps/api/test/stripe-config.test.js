import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { createStripeAdapter } from "../src/payments/stripe-test.js";

const live = {
  runMode: "hosted-preview", nodeEnv: "production", origin: "https://eats.example.test",
  paymentProviderMode: "stripe_live", livePaymentsEnabled: true,
  stripePlatformAccountId: "acct_localfixture", paymentProvider: { mode: "stripe_live" },
  paymentProviderWebhookSecret: "whsec_platform_fixture", paymentProviderConnectWebhookSecret: "whsec_connect_fixture"
};

test("live Stripe requires explicit activation, hosted HTTPS, account binding and both webhook secrets", () => {
  assert.throws(() => loadConfig({ ...live, livePaymentsEnabled: false }), /explicit/);
  assert.throws(() => loadConfig({ ...live, livePaymentsEnabled: "false" }), /boolean/);
  assert.throws(() => loadConfig({ ...live, nodeEnv: "development" }), /production/);
  assert.throws(() => loadConfig({ ...live, stripePlatformAccountId: null }), /ACCOUNT_ID/);
  assert.throws(() => loadConfig({ ...live, paymentProviderConnectWebhookSecret: "" }), /webhook/);
  assert.throws(() => loadConfig({ ...live, paymentProviderConnectWebhookSecret: live.paymentProviderWebhookSecret }), /distinct.*webhook/);
  assert.equal(loadConfig(live).paymentProviderMode, "stripe_live");
});

test("Stripe configuration rejects a cross-mode adapter and malformed account binding", () => {
  assert.throws(() => loadConfig({ ...live, paymentProvider: { mode: "stripe_test" } }), /mode must match/);
  assert.throws(() => loadConfig({ ...live, stripePlatformAccountId: "acct_wrong/host" }), /platform account/);
  assert.throws(() => loadConfig({ paymentProviderMode: "stripe_test", stripeSecretKey: "sk_live_fixture" }), /matching|test/);
});

test("restricted Stripe keys keep the same sandbox and live isolation", async () => {
  let authorization;
  const sandbox = createStripeAdapter({ secretKey: "rk_test_localfixture", fetchImpl: async (_url, init) => {
    authorization = init.headers.Authorization;
    return { ok: true, json: async () => ({ id: "acct_localfixture", country: "GB" }) };
  } });
  assert.equal((await sandbox.retrievePlatformAccount()).accountId, "acct_localfixture");
  assert.equal(authorization, "Bearer rk_test_localfixture");
  assert.throws(() => createStripeAdapter({ secretKey: "rk_live_localfixture" }), /matching/);
  assert.throws(() => createStripeAdapter({ secretKey: "rk_test_localfixture", mode: "live", liveEnabled: true }), /matching/);
  assert.throws(() => createStripeAdapter({ secretKey: "rk_live_localfixture", mode: "live" }), /explicit/);
  assert.equal(createStripeAdapter({ secretKey: "rk_live_localfixture", mode: "live", liveEnabled: true }).mode, "stripe_live");
});

test("only the exact live Connect profile prerequisite becomes a safe actionable error code",async()=>{
  const message="You must complete your platform profile to use Connect and create live connected accounts. Visit your dashboard at https://dashboard.stripe.com/connect/accounts/overview to answer the questionnaire.";
  const replies=[{type:"invalid_request_error",message},{type:"invalid_request_error",message:"Another invalid request with private provider details"},{type:"invalid_request_error",message}];
  const adapter=createStripeAdapter({mode:"live",liveEnabled:true,secretKey:"rk_live_profile_fixture",fetchImpl:async()=>({ok:false,status:400,json:async()=>({error:replies.shift()})})});
  const first=await adapter.createConnectedAccount({restaurantId:"restaurant-fixture",email:"fixture@example.invalid",idempotencyKey:"profile-create-fixture"});
  assert.deepEqual(first,{ok:false,status:"failed",providerReference:undefined,errorCode:"STRIPE_CONNECT_PLATFORM_PROFILE_REQUIRED"});
  const other=await adapter.createConnectedAccount({restaurantId:"restaurant-fixture",email:"fixture@example.invalid",idempotencyKey:"profile-create-fixture"});assert.equal(other.errorCode,"invalid_request_error");
  const refresh=await adapter.refreshConnectedAccount({accountId:"acct_fixture"});assert.equal(refresh.errorCode,"invalid_request_error","The special mapping only applies to account creation");
  for(const result of[first,other,refresh])assert.doesNotMatch(JSON.stringify(result),/questionnaire|dashboard\.stripe|private provider|rk_live_profile_fixture|fixture@example/);
});
