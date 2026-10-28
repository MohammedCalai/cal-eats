import test from "node:test";
import assert from "node:assert/strict";
import { menuSections } from "../menu-sections.js";
import { restaurantMenuHtml } from "../restaurant-menu.js";

test("menu sections preserve owner order, keep every dish once and use stable safe anchors during search", () => {
  const items = [{ id: "a", name: "Chicken tikka", category: "Starters" }, { id: "b", name: "Pilau rice", category: "Rice" }, { id: "c", name: "Samosa", category: "Starters" }, { id: "d", name: "Tea", category: "" }, { id: "e", name: "Special", category: "__proto__" }];
  const full = menuSections(items);
  assert.deepEqual(full.map(section => section.title), ["Starters", "Rice", "Menu", "__proto__"]);
  assert.deepEqual(full[0].items.map(item => item.id), ["a", "c"]);
  assert.equal(new Set(full.flatMap(section => section.items.map(item => item.id))).size, items.length);
  assert.equal(menuSections(items, "PILAU")[0].id, full[1].id);
  assert.equal(menuSections(items, "not on the menu").length, 0);
});

test("menu cards show real photo and quantity controls, escape merchant copy, and keep options out of quick add", () => {
  const html = restaurantMenuHtml({ restaurant: { name: '<Example & Kitchen>' }, cart: { pictured: 2 }, items: [
    { id: "pictured", name: '<Pictured dish>', category: "Mains", priceMinor: 950, photoUrl: "/api/media/food", allergens: ["milk"], modifierGroups: [] },
    { id: "custom", name: "Customise me", category: "Mains", description: 'A <script> must be text', priceMinor: 600, modifierGroups: [{ id: "size" }] }
  ] });
  assert.ok(html.includes('dish-with-photo')); assert.ok(html.includes('dish-text'));
  assert.ok(html.includes('Remove one &lt;Pictured dish&gt;')); assert.ok(html.includes('aria-label="Customise Customise me"'));
  assert.ok(html.includes('£9.50')); assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('aria-label="All menu sections"'));
});
