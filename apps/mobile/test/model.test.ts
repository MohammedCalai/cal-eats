import assert from "node:assert/strict";
import test from "node:test";
import { canCheckout, cartTotals, orderItems, outwardPostcode, refreshCart, toggleSelection, validateSelections } from "../src/model.ts";
import type { CartEntry, MenuItem, Restaurant } from "../src/types.ts";

const item: MenuItem = {
  id: "item-1", restaurantId: "restaurant-1", name: "Rice bowl", description: "", priceMinor: 1000, available: true, category: "Mains", allergens: ["sesame"], dietaryTags: [], photoUrl: null,
  modifierGroups: [{ id: "size", name: "Size", minSelections: 1, maxSelections: 1, options: [{ id: "large", name: "Large", priceMinor: 250, available: true }, { id: "sold-out", name: "Sold out", priceMinor: 0, available: false }] }]
};
const restaurant: Restaurant = { id: "restaurant-1", name: "Local Kitchen", acceptingOrders: true, suspended: false, delivery: { enabled: true, outcodes: ["E1"], deliveryFeeMinor: 199, minDeliverySubtotalMinor: 1200 }, profile: { collectionEnabled: true, cashEnabled: true, paused: false } };
const cart: CartEntry[] = [{ item, quantity: 2, selections: { size: ["large"] } }];

test("menu refresh preserves quantities, updates prices and removes sold-out dishes and choices", () => {
  const refreshed = refreshCart(cart, [{ ...item, priceMinor: 1100 }]);
  assert.equal(refreshed[0].quantity, 2); assert.equal(refreshed[0].item.priceMinor, 1100); assert.deepEqual(refreshed[0].selections.size, ["large"]);
  assert.deepEqual(refreshCart(cart, [{ ...item, available: false }]), []);
  const changed = refreshCart(cart, [{ ...item, modifierGroups: [{ ...item.modifierGroups[0], options: [] }] }]);
  assert.equal(canCheckout(changed, "collection", restaurant, "").ok, false);
});
test("optional single-choice extras can be removed and multiple choices respect their limit", () => {
  assert.deepEqual(toggleSelection(["large"], "large", 1), []);
  assert.deepEqual(toggleSelection(["small"], "large", 1), ["large"]);
  assert.deepEqual(toggleSelection(["one", "two"], "three", 2), ["one", "two"]);
});

test("normalises a full UK postcode to its outcode", () => assert.equal(outwardPostcode(" e1 6an "), "E1"));
test("rejects malformed postcodes", () => assert.equal(outwardPostcode("not a postcode"), ""));
test("requires available modifier choices", () => {
  assert.deepEqual(validateSelections(item, {}), { ok: false, reason: "Size needs 1 selection." });
  assert.equal(validateSelections(item, { size: ["sold-out"] }).ok, false);
  assert.equal(validateSelections(item, { size: ["large"] }).ok, true);
});
test("totals integer pence including modifiers and delivery", () => assert.deepEqual(cartTotals(cart, "delivery", restaurant), { subtotalMinor: 2500, deliveryFeeMinor: 199, totalMinor: 2699 }));
test("serializes only server identifiers, quantities and selected options", () => assert.deepEqual(orderItems(cart), [{ menuItemId: "item-1", quantity: 2, modifiers: [{ groupId: "size", optionIds: ["large"] }] }]));
test("delivery checkout validates restaurant outcode and minimum", () => {
  assert.equal(canCheckout(cart, "delivery", restaurant, "E1 6AN").ok, true);
  assert.equal(canCheckout(cart, "delivery", restaurant, "SW1A 1AA").ok, false);
  assert.equal(canCheckout([{ ...cart[0]!, quantity: 0 }], "delivery", restaurant, "E1 6AN").ok, false);
});
