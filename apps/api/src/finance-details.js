import { requireRestaurantOwner } from "./auth/authorization.js";
import { HttpError, sendJson } from "./http.js";

const confirmedStates = new Set(["accepted", "preparing", "ready", "out_for_delivery", "completed"]);
const parse = value => { try { const result = JSON.parse(value || "null"); return result && typeof result === "object" ? result : null; } catch { return null; } };
const amount = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const string = (value, maximum = 200) => typeof value === "string" ? value.slice(0, maximum) : "";

export function buildOrderFinancialBreakdown(db, order) {
  const refunds = db.prepare("SELECT id,food_amount_minor,delivery_amount_minor,commission_reversal_minor,created_at FROM refunds WHERE order_id=? ORDER BY created_at,id").all(order.id);
  const refundedFoodMinor = refunds.reduce((sum, row) => sum + row.food_amount_minor, 0), refundedDeliveryMinor = refunds.reduce((sum, row) => sum + row.delivery_amount_minor, 0);
  const reversedMinor = refunds.reduce((sum, row) => sum + row.commission_reversal_minor, 0), refundedTotalMinor = refundedFoodMinor + refundedDeliveryMinor;
  const payment = db.prepare("SELECT provider_mode,status FROM stripe_order_payments WHERE order_id=?").get(order.id);
  const confirmed = confirmedStates.has(order.status) && (order.payment_method !== "card" || ["stripe_captured", "stripe_partially_refunded", "stripe_refunded"].includes(order.payment_status));
  const originalCommission = amount(order.commission_minor), retainedCommission = confirmed ? Math.max(0, originalCommission - reversedMinor) : 0;
  const originalEarnings = confirmed ? Math.max(0, order.total_minor - originalCommission) : 0, currentEarnings = confirmed ? Math.max(0, order.total_minor - refundedTotalMinor - retainedCommission) : 0;
  const rows = db.prepare("SELECT id,name,quantity,unit_price_minor,base_price_minor,is_offer_item,selected_modifiers FROM order_items WHERE order_id=? ORDER BY rowid").all(order.id);
  const items = rows.map(row => { const modifiers=parse(row.selected_modifiers); return { id: row.id, name: row.name, quantity: row.quantity, unitPriceMinor: row.unit_price_minor, lineTotalMinor: row.unit_price_minor * row.quantity, isOfferItem: Boolean(row.is_offer_item), modifiers: (Array.isArray(modifiers)?modifiers:[]).map(modifier => ({ name: string(modifier.name), priceMinor: amount(modifier.priceMinor) })) }; });
  const storedPromotion = parse(order.promotion_snapshot), storedOffer = parse(order.offer_snapshot);
  const freeItems = rows.filter(row => row.is_offer_item).map(row => ({ name: row.name, quantity: row.quantity, retailValueMinor: amount(row.base_price_minor) * row.quantity }));
  const discount = amount(order.restaurant_discount_minor);
  const promotion = storedPromotion || storedOffer || discount || freeItems.length ? {
    title: string(storedPromotion?.title || storedOffer?.title) || "Restaurant offer", offerType: string(storedPromotion?.offerType || storedOffer?.offerType) || (freeItems.length ? "free_item" : "fixed_off"), fundingParty: "restaurant", discountMinor: discount,
    freeItemRetailValueMinor: freeItems.reduce((sum, item) => sum + item.retailValueMinor, 0), freeItems,
    allocations: (Array.isArray(storedPromotion?.allocations) ? storedPromotion.allocations : []).map(row => ({ menuItemId: string(row.menuItemId, 100), name: string(row.name), grossMinor: amount(row.grossMinor), discountMinor: amount(row.discountMinor), netMinor: amount(row.netMinor) }))
  } : null;
  const transfers = db.prepare("SELECT kind,status,amount_minor FROM marketplace_operations WHERE restaurant_id=? AND order_id=? AND kind IN ('merchant_transfer','transfer_reversal')").all(order.restaurant_id, order.id);
  const transferredMinor = transfers.filter(row => row.kind === "merchant_transfer" && row.status === "confirmed").reduce((sum, row) => sum + row.amount_minor, 0), reversedTransferMinor = transfers.filter(row => row.kind === "transfer_reversal" && row.status === "confirmed").reduce((sum, row) => sum + row.amount_minor, 0);
  let state = "not_confirmed", label = "No earnings confirmed";
  if (confirmed) {
    if (!currentEarnings) { state = "no_net_earnings"; label = "No net earnings remaining"; }
    else if (order.payment_method === "cash") { state = order.payment_status === "cash_collected" ? "cash_direct" : "cash_due"; label = state === "cash_direct" ? "Cash received by restaurant" : "Cash due to restaurant"; }
    else if (order.payment_method === "mock_card") { state = "simulated"; label = "Test payment · no bank payout"; }
    else if (transfers.some(row => row.status === "unknown")) { state = "needs_review"; label = "Transfer needs review"; }
    else if (transferredMinor > reversedTransferMinor) { state = "transferred_to_balance"; label = "Transferred to Stripe balance"; }
    else if (transfers.some(row => row.status === "held")) { state = "held"; label = "Transfer on hold"; }
    else if (transfers.some(row => ["pending", "delayed"].includes(row.status))) { state = "processing"; label = "Transfer processing"; }
    else { state = order.status === "completed" ? "pending_transfer" : "awaiting_completion"; label = state === "pending_transfer" ? "Awaiting transfer" : "Awaiting order completion"; }
  }
  const base = order.commission_base === "food_plus_delivery" ? "food_plus_delivery" : "food";
  return {
    orderId: order.id, restaurantId: order.restaurant_id, currency: order.currency, status: order.status, createdAt: order.created_at, paymentMethod: order.payment_method, paymentStatus: order.payment_status, providerMode: payment?.provider_mode || "local_simulator", items,
    totals: { grossFoodMinor: Math.max(amount(order.gross_food_minor), order.subtotal_minor + discount), restaurantDiscountMinor: discount, foodChargedMinor: order.subtotal_minor, deliveryFeeMinor: order.delivery_fee_minor, customerChargedMinor: order.total_minor, refundedFoodMinor, refundedDeliveryMinor, refundedTotalMinor, retainedCustomerPaymentMinor: Math.max(0, order.total_minor - refundedTotalMinor) },
    commission: { rateBasisPoints: order.contract_rate_bps, base, commissionableMinor: order.subtotal_minor + (base === "food_plus_delivery" ? order.delivery_fee_minor : 0), originalMinor: originalCommission, reversedMinor, retainedMinor: retainedCommission, policyVersion: order.contract_policy_version, developmentAssumption: Boolean(order.contract_demo_only), recognised: confirmed }, promotion,
    earnings: { originalMinor: originalEarnings, refundImpactMinor: originalEarnings - currentEarnings, currentMinor: currentEarnings, providerFeeChargedToRestaurantMinor: 0, providerFeeBorneBy: "platform", confirmed },
    refunds: refunds.map(row => ({ id: row.id, foodMinor: row.food_amount_minor, deliveryMinor: row.delivery_amount_minor, commissionReversalMinor: row.commission_reversal_minor, createdAt: row.created_at })),
    settlement: { state, label, transferredMinor, reversedTransferMinor, bankPayoutAttributed: false, note: "Transfers to a connected Stripe balance are separate from bank payouts. This order is not attributed to a bank payout without Stripe reconciliation evidence." }
  };
}

export async function routeFinanceDetails({ req, res, url, db, session }) {
  const match = url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/finance\/orders\/([^/]+)\/breakdown$/);
  if (req.method !== "GET" || !match) return false;
  requireRestaurantOwner(db, session, match[1]);
  const order = db.prepare("SELECT * FROM orders WHERE id=? AND restaurant_id=?").get(match[2], match[1]);
  if (!order) throw new HttpError(404, "NOT_FOUND", "Resource not found");
  return sendJson(res, 200, { data: buildOrderFinancialBreakdown(db, order) });
}
