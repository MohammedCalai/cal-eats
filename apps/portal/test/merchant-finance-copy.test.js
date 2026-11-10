import assert from "node:assert/strict";
import test from "node:test";
import { merchantBankPayoutLabel, merchantFinanceCopy, merchantSettlementLabel } from "../src/merchant-finance-copy.js";

test("an order allocation never claims that the restaurant has received a bank payout", () => {
  assert.equal(merchantSettlementLabel("transferred_to_balance", "Transferred to Stripe balance"), "Awaiting weekly payout");
  for (const [state, expected] of [["held", "Earnings on hold"], ["needs_review", "Earnings need review"], ["processing", "Preparing your earnings"], ["awaiting_completion", "Awaiting order completion"]]) {
    const label = merchantSettlementLabel(state); assert.equal(label, expected); assert.doesNotMatch(label, /paid|Stripe|connected balance/i);
  }
  assert.equal(merchantSettlementLabel("cash_due"), "Cash due to your restaurant");
  assert.equal(merchantSettlementLabel("not_confirmed"), "No earnings confirmed");
});

test("bank payout statuses retain paid, pending, failed and in-transit distinctions without provider branding", () => {
  assert.equal(merchantBankPayoutLabel("paid"), "Bank payout marked paid");
  assert.equal(merchantBankPayoutLabel("pending"), "Pending"); assert.equal(merchantBankPayoutLabel("failed"), "Failed"); assert.equal(merchantBankPayoutLabel("in_transit"), "In transit");
  assert.doesNotMatch(merchantFinanceCopy("Stripe’s connection needs attention"), /stripe/i);
  assert.doesNotMatch(merchantSettlementLabel("future_status", "Stripe balance needs review"), /stripe/i);
});
