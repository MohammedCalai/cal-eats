import { createStripeTestAdapter } from "../apps/api/src/payments/stripe-test.js";

// Read-only connection check. Never prints credentials or the private account profile.
async function main() {
  const expected = process.env.CALAI_STRIPE_ACCOUNT_ID;
  const secretKey = process.env.CALAI_STRIPE_TEST_SECRET_KEY;
  if (!/^acct_[A-Za-z0-9]+$/.test(expected || "")) throw new Error("Configure the confirmed Cal-Eats sandbox account ID first.");
  if (!/^(rk|sk)_test_/.test(secretKey || "")) throw new Error("A sandbox-only restricted or secret key is required.");
  if (process.env.CALAI_LIVE_PAYMENTS_ENABLED === "true") throw new Error("Disable live payments before running the sandbox connection check.");
  const result = await createStripeTestAdapter({ secretKey }).retrievePlatformAccount();
  if (!result.ok) throw new Error(`Sandbox identity check failed (${result.errorCode || "unconfirmed"}).`);
  if (result.accountId !== expected) throw new Error("The connection key belongs to a different account. Cal-Eats remains disconnected.");
  console.log(JSON.stringify({
    connection: "verified", mode: "stripe_test", accountId: result.accountId,
    country: result.country, chargesEnabled: result.chargesEnabled, payoutsEnabled: result.payoutsEnabled,
    checkoutActivated: false, note: "Account identity only. Signed webhooks and restaurant onboarding still require separate verification."
  }, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
