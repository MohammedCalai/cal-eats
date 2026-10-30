import { HttpError } from "./http.js";
import { assertPromotionBudget, quotePromotion } from "./promotion-mechanics.js";

// Bound per-basket evaluation to the 100 newest active grants. Report truncation
// so callers do not mistake a bounded selection for an exhaustive offer search.
export const AUTO_OFFER_CANDIDATE_LIMIT = 100;

export function automaticOfferQuote(db, { customerId, restaurantId, menu, grossSubtotal, now, fulfillment, deliveryFeeMinor }) {
  const baseline = { discountMinor: 0, netSubtotalMinor: grossSubtotal, allocations: [], deliveryDiscountMinor: 0, deliveryFeeMinor, gift: null };
  const result = { offer: null, quote: baseline, candidateLimit: AUTO_OFFER_CANDIDATE_LIMIT, truncated: false, candidatesChecked: 0 };
  if (!db.prepare("SELECT 1 FROM marketing_preferences WHERE user_id=? AND in_app_promotions=1").get(customerId)) return result;
  const candidates = db.prepare(`SELECT g.*,c.title,c.message,c.offer_type,c.offer_value,c.menu_item_id,c.item_name,c.item_value_minor,
      c.min_subtotal_minor,c.expires_at,c.created_at AS campaign_created_at,c.starts_at,c.eligible_item_ids,c.eligible_categories,
      c.funding_party,c.budget_minor,c.redemption_limit,c.campaign_type,c.campaign_rules,c.weekly_budget_minor,c.recipient_segment
    FROM offer_grants g JOIN offer_campaigns c ON c.id=g.campaign_id
    WHERE g.customer_id=? AND g.restaurant_id=? AND c.restaurant_id=g.restaurant_id
      AND g.status='available' AND g.dismissed_at IS NULL
      AND COALESCE(c.starts_at,c.created_at)<=? AND c.expires_at>?
      AND c.min_subtotal_minor<=?
    ORDER BY g.created_at DESC,g.id DESC LIMIT ?`).all(customerId, restaurantId, now, now, grossSubtotal, AUTO_OFFER_CANDIDATE_LIMIT + 1);
  result.truncated = candidates.length > AUTO_OFFER_CANDIDATE_LIMIT;
  result.candidatesChecked = Math.min(candidates.length, AUTO_OFFER_CANDIDATE_LIMIT);
  let bestTotal = grossSubtotal + deliveryFeeMinor, bestGift = 0;
  for (const offer of candidates.slice(0, AUTO_OFFER_CANDIDATE_LIMIT)) {
    try {
      const quote = quotePromotion(db, { grant: offer, menu, grossSubtotal, now, fulfillment, deliveryFeeMinor });
      assertPromotionBudget(db, offer, quote.sponsorCostMinor, now);
      const total = quote.netSubtotalMinor + quote.deliveryFeeMinor, gift = quote.gift?.valueMinor ?? 0;
      if (total < bestTotal || (total === bestTotal && gift > bestGift)) {
        result.offer = offer; result.quote = quote; bestTotal = total; bestGift = gift;
      }
    } catch (error) {
      // An ineligible promotion does not make an otherwise valid basket fail.
      if (!(error instanceof HttpError) || error.status !== 409) throw error;
    }
  }
  return result;
}
