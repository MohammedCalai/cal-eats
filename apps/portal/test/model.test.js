import test from "node:test";
import assert from "node:assert/strict";
import { listItems, ownerNavigation, parseMenuCsv, roleHome } from "../src/model.js";

test("normalizes existing arrays and new cursor lists", () => {
  assert.deepEqual(listItems([{ id: 1 }]), [{ id: 1 }]);
  assert.deepEqual(listItems({ items: [{ id: 2 }], nextCursor: null }), [{ id: 2 }]);
  assert.deepEqual(listItems(null), []);
});

test("staff navigation omits owner-only finance, refunds and settings", () => {
  const labels = ownerNavigation("staff").map(([label]) => label);
  assert.ok(labels.includes("Orders"));
  assert.ok(!labels.includes("Earnings & payouts"));
  assert.ok(!labels.includes("Settings"));
});

test("role homes are explicit", () => {
  assert.equal(roleHome("admin"), "/admin/dashboard");
  assert.equal(roleHome("restaurant"), "/owner/dashboard");
});

test("menu CSV handles quoted commas and integer pence", () => {
  const items = parseMenuCsv('name,description,pricepence,category,allergens,dietarytags\n"Rice, bowl","Fresh\nherbs",1250,Mains,"milk|egg",halal');
  assert.deepEqual(items[0], { name: "Rice, bowl", description: "Fresh\nherbs", priceMinor: 1250, category: "Mains", allergens: ["milk","egg"], dietaryTags: ["halal"], modifierGroups: [] });
});

test("menu CSV rejects malformed rows and fractional pence", () => {
  assert.throws(() => parseMenuCsv("name,description,pricepence,category,allergens,dietarytags\nA,B,100,C,D"), /six cells/);
  assert.throws(() => parseMenuCsv("name,description,pricepence,category,allergens,dietarytags\nA,B,10.5,C,D,E"), /whole number/);
});
