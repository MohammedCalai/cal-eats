import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

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
