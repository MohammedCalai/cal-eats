export const merchantFinanceCopy = value => String(value || "").replace(/\bStripe(?:’s|'s)?\b/gi, "the payment service");

export function merchantSettlementLabel(state, fallback = "") {
  return ({
    not_confirmed: "No earnings confirmed",
    no_net_earnings: "No net earnings remaining",
    cash_direct: "Cash received by your restaurant",
    cash_due: "Cash due to your restaurant",
    simulated: "Test earnings · no bank payout",
    needs_review: "Earnings need review",
    transferred_to_balance: "Awaiting weekly payout",
    held: "Earnings on hold",
    processing: "Preparing your earnings",
    pending_transfer: "Awaiting earnings allocation",
    awaiting_completion: "Awaiting order completion"
  })[state] || merchantFinanceCopy(fallback) || "Awaiting earnings update";
}

export const merchantBankPayoutLabel = state => ({ paid: "Bank payout marked paid", pending: "Pending", in_transit: "In transit", failed: "Failed", canceled: "Cancelled", cancelled: "Cancelled" })[state] || merchantFinanceCopy(state).replaceAll("_", " ");
