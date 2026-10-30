import { HttpError } from "./http.js";
import { parseLondonDateRange } from "./marketplace-reporting.js";

const fail = (code, message) => { throw new HttpError(409, code, message); };
const parse = (value, fallback) => { try { return JSON.parse(value ?? ""); } catch { return fallback; } };
export const CAMPAIGN_TYPES = ["percent_items", "percent_order", "amount_order", "free_item_with_purchase", "buy_one_get_one", "buy_one_get_free_item", "free_delivery", "happy_hour"];
export function campaignType(row) {
  return row.campaign_type || (row.offer_type === "free_item" ? "free_item_with_purchase" : row.offer_type === "fixed_off" ? "amount_order" : parse(row.eligible_item_ids, []).length || parse(row.eligible_categories, []).length ? "percent_items" : "percent_order");
}
export function campaignWeekStart(now) {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now)).map(part => [part.type, part.value]));
  const local = new Date(`${values.year}-${values.month}-${values.day}T12:00:00.000Z`);
  local.setUTCDate(local.getUTCDate() - (local.getUTCDay() + 6) % 7);
  const date = local.toISOString().slice(0, 10);
  return parseLondonDateRange(new URL(`http://promotion.local/?from=${date}&to=${date}`)).from;
}
export function campaignBudgetUsage(db, id, weekStart) {
  return db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(reserved_discount_minor),0) AS amount,COALESCE(SUM(CASE WHEN reserved_week_start=? THEN reserved_discount_minor ELSE 0 END),0) AS weeklyAmount FROM offer_grants WHERE campaign_id=? AND status IN ('reserved','redeemed')").get(weekStart, id);
}
export function assertPromotionBudget(db, grant, sponsorCostMinor, now) {
  const weekStart = campaignWeekStart(now), committed = campaignBudgetUsage(db, grant.campaign_id, weekStart);
  if (committed.count >= (grant.redemption_limit ?? 100000)) fail("PROMOTION_LIMIT_REACHED", "Promotion redemption limit is reached");
  if (grant.budget_minor != null && committed.amount + sponsorCostMinor > grant.budget_minor) fail("PROMOTION_BUDGET_EXHAUSTED", "Promotion budget is exhausted");
  if (grant.weekly_budget_minor != null && committed.weeklyAmount + sponsorCostMinor > grant.weekly_budget_minor) fail("PROMOTION_WEEKLY_BUDGET_EXHAUSTED", "Promotion weekly budget is exhausted");
  return weekStart;
}
export function quotePromotion(db, { grant, menu, grossSubtotal, now, fulfillment = "collection", deliveryFeeMinor = 0 }) {
  if ((grant.starts_at ?? grant.campaign_created_at ?? grant.created_at) > now) fail("OFFER_NOT_STARTED", "Offer has not started");
  if (grant.expires_at <= now) fail("OFFER_EXPIRED", "Offer has expired");
  if (grossSubtotal < grant.min_subtotal_minor) fail("OFFER_MINIMUM", "Order does not meet the offer minimum");
  if (grant.funding_party && grant.funding_party !== "restaurant") fail("PLATFORM_FUNDING_NOT_AUTHORISED", "Platform funding is not authorised");
  const type = campaignType(grant), rules = parse(grant.campaign_rules, {}), ids = new Set(parse(grant.eligible_item_ids, [])), categories = new Set(parse(grant.eligible_categories, []));
  if ((rules.audienceSegment ?? grant.recipient_segment) === "first_order" && db?.prepare("SELECT 1 FROM orders WHERE restaurant_id=? AND customer_id=? AND status='completed' LIMIT 1").get(grant.restaurant_id, grant.customer_id)) fail("FIRST_ORDER_INELIGIBLE", "This promotion is for a first completed order at this restaurant");
  const eligible = menu.map(line => ({ line, amount: line.unitPrice * line.entry.quantity })).filter(({ line }) => (!ids.size && !categories.size) || ids.has(line.row.id) || categories.has(line.row.category));
  const eligibleTotal = eligible.reduce((sum, line) => sum + line.amount, 0);
  if (!eligibleTotal || grossSubtotal <= 0) fail("PROMOTION_ITEMS_INELIGIBLE", "Basket has no eligible paid items");
  let discountMinor = 0, deliveryDiscountMinor = 0, gift = null;
  const allocations = [];
  if (type === "buy_one_get_one") {
    for (const entry of eligible) {
      const value = Math.floor(entry.line.entry.quantity / 2) * entry.line.row.price_minor;
      if (value > 0) allocations.push({ menuItemId: entry.line.row.id, name: entry.line.row.name, grossMinor: entry.amount, discountMinor: value, netMinor: entry.amount - value });
      discountMinor += value;
    }
    if (!discountMinor) fail("PROMOTION_BUY_QUANTITY", "Add two of the same eligible item to use buy one, get one free. Extras remain paid.");
  } else if (type === "free_delivery") {
    if (fulfillment !== "delivery") fail("PROMOTION_DELIVERY_REQUIRED", "This promotion is for delivery orders only");
    if (deliveryFeeMinor <= 0) fail("PROMOTION_DELIVERY_ALREADY_FREE", "Delivery is already free for this order");
    deliveryDiscountMinor = deliveryFeeMinor;
  } else if (["free_item_with_purchase", "buy_one_get_free_item"].includes(type)) {
    if (type === "buy_one_get_free_item" && !menu.some(line => line.row.id === rules.buyItemId && line.entry.quantity >= 1 && line.unitPrice > 0)) fail("PROMOTION_PURCHASE_REQUIRED", "Add the qualifying purchase item to receive this free item");
    const row = db?.prepare("SELECT * FROM menu_items WHERE id=? AND restaurant_id=? AND available=1").get(grant.menu_item_id, grant.restaurant_id);
    if (!row || parse(row.modifier_groups, []).some(group => group.minSelections > 0)) fail("OFFER_ITEM_UNAVAILABLE", "Offer item is unavailable");
    gift = { menuItemId: row.id, name: grant.item_name || row.name, quantity: 1, valueMinor: grant.item_value_minor ?? row.price_minor };
  } else {
    discountMinor = grant.offer_type === "fixed_off" ? Math.min(grant.offer_value, eligibleTotal) : Math.floor(eligibleTotal * grant.offer_value / 10000);
    let remaining = discountMinor;
    eligible.forEach((entry, index) => {
      const value = index === eligible.length - 1 ? remaining : Math.floor(discountMinor * entry.amount / eligibleTotal);
      remaining -= value;
      if (value) allocations.push({ menuItemId: entry.line.row.id, name: entry.line.row.name, grossMinor: entry.amount, discountMinor: value, netMinor: entry.amount - value });
    });
  }
  const netSubtotalMinor = grossSubtotal - discountMinor;
  if (netSubtotalMinor <= 0) fail("OFFER_REQUIRES_PURCHASE", "An offer requires a paid food item");
  return { campaignType: type, discountMinor, netSubtotalMinor, allocations, deliveryDiscountMinor, deliveryFeeMinor: deliveryFeeMinor - deliveryDiscountMinor, sponsorCostMinor: discountMinor + deliveryDiscountMinor + (gift?.valueMinor ?? 0), gift };
}
