import test from "node:test";
import assert from "node:assert/strict";
import { availableBasketOffers, basketReviewHtml } from "../basket-ui.js";
import { cartLines, cartTotals } from "../model.js";

test("basket keeps option prices, line quantities and owner delivery fees without inventing offer savings", () => {
  const items = [{ id: "dish", name: '<Chicken bowl>', priceMinor: 1000, photoUrl: '/api/media/food', modifierGroups: [{ id: "sauce", name: "Sauce", options: [{ id: "mayo", name: "Mayo", priceMinor: 75 }] }] }];
  const lines = cartLines(items, { dish: 2 }, { dish: { sauce: ['mayo'] } });
  const totals = cartTotals(lines, 'delivery', { deliveryFeeMinor: 250 });
  const html = basketReviewHtml({ restaurant: { id: 'r1', name: 'Kitchen', profile: {} }, lines, totals, fulfillment: 'delivery', offers: [] });
  assert.equal(totals.totalMinor, 2400); assert.ok(html.includes('£21.50')); assert.ok(html.includes('Sauce: Mayo')); assert.ok(html.includes('£2.50')); assert.ok(html.includes('£24.00'));
  assert.ok(html.includes('Close basket')); assert.ok(html.includes('Go to checkout')); assert.ok(html.includes('&lt;Chicken bowl&gt;')); assert.ok(!html.includes('Saving £'));
});
test("basket offers exclude expired, redeemed, other restaurants and future offers", () => {
  const base = { id: 'active', restaurantId: 'r1', status: 'available', expiresAt: '2026-11-01T00:00:00Z' };
  assert.deepEqual(availableBasketOffers([base,{...base,id:'expired',expiresAt:'2026-10-01T00:00:00Z'},{...base,id:'future',startsAt:'2026-10-31T00:00:00Z'},{...base,id:'redeemed',status:'redeemed'},{...base,id:'other',restaurantId:'r2'}],'r1',Date.parse('2026-10-29T00:00:00Z')).map(offer=>offer.id),['active']);
});
