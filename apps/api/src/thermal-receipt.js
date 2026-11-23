const paymentLabels = new Map([
  ["stripe_captured", "Paid by card"],
  ["stripe_authorized", "Card authorised - payment pending"],
  ["stripe_pending", "Card payment pending"],
  ["stripe_failed", "Card payment failed"],
  ["stripe_cancelled", "Card payment cancelled"],
  ["stripe_expired", "Card payment expired"],
  ["stripe_partially_refunded", "Card payment partially refunded"],
  ["stripe_refunded", "Card payment refunded"],
  ["cash_due", "Cash due"],
  ["cash_collected", "Paid in cash"],
  ["cash_paid", "Paid in cash"],
  ["cash_cancelled", "Cash payment cancelled"],
  ["cash_partially_refunded", "Cash payment partially refunded"],
  ["cash_refunded", "Cash refunded"],
  ["mock_captured", "Test card payment - no money charged"],
  ["mock_authorized", "Test card authorised"],
  ["mock_pending", "Test card payment pending"],
  ["mock_failed", "Test card payment failed"],
  ["mock_cancelled", "Test card payment cancelled"],
  ["mock_expired", "Test card payment expired"],
  ["mock_partially_refunded", "Test card payment partially refunded"],
  ["mock_refunded", "Test card payment refunded"],
  ["voucher_reserved", "Cal-Eats voucher reserved"],
  ["voucher_redeemed", "Paid with a Cal-Eats voucher"],
  ["voucher_cancelled", "Cal-Eats voucher cancelled"],
]);

export function thermalPaymentLabel(status, providerMode) {
  if (typeof status === "string" && status.startsWith("stripe_")) {
    if (providerMode === "stripe_test") status = `mock_${status.slice("stripe_".length)}`;
    else if (providerMode !== "stripe_live") return "Status unavailable";
  }
  return paymentLabels.get(status) ?? "Status unavailable";
}
