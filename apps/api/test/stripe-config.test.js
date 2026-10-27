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
