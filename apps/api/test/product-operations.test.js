import assert from "node:assert/strict";
import test from "node:test";
import { restaurantAvailability } from "../src/availability.js";
import { journeyFixture } from "./helpers.js";
import { seedDemoData } from "../src/seed.js";

const creds = { admin: ["admin@calai.local", "LocalAdmin!4310"], owner: ["restaurant@calai.local", "LocalRestaurant!4310"], owner2: ["restaurant2@calai.local", "LocalRestaurant2!4310"], customer: ["customer@calai.local", "LocalCustomer!4310"] };
async function auth(f) { return { admin: await f.login(...creds.admin), owner: await f.login(...creds.owner), owner2: await f.login(...creds.owner2), customer: await f.login(...creds.customer) }; }

test("restaurant onboarding stays pending and owner/staff permissions are isolated", async () => {
  const f = await journeyFixture();
  try {
    const a = await auth(f);
    const onboarded = await f.json("/api/auth/restaurant-register", { method: "POST", body: { name: "New Owner", email: "new-owner@example.test", password: "long local password", restaurantName: "Pending Place" } });
    assert.equal(onboarded.status, 201); const newCookie = onboarded.headers.get("set-cookie").split(";", 1)[0];
    const pending = (await f.json("/api/restaurant/restaurants", { cookie: newCookie })).body.data[0];
    assert.equal(pending.status, "pending"); assert.equal(pending.acceptingOrders, false);
    assert.equal((await f.json("/api/restaurants")).body.data.some((row) => row.id === pending.id), false);
    const owned = (await f.json("/api/restaurant/restaurants", { cookie: a.owner })).body.data[0];
    const staff = await f.json(`/api/restaurant/restaurants/${owned.id}/staff`, { method: "POST", cookie: a.owner, body: { name: "Demo Staff", email: "staff@example.test", password: "long staff password" } });
    assert.equal(staff.status, 201); const staffCookie = await f.login("staff@example.test", "long staff password");
    assert.equal((await f.json(`/api/restaurant/restaurants/${owned.id}/staff`, { cookie: staffCookie })).status, 403);
    assert.equal((await f.json(`/api/restaurant/restaurants/${owned.id}/statement`, { cookie: staffCookie })).status, 403);
    assert.equal((await f.json(`/api/restaurant/restaurants/${owned.id}/contract`, { cookie: staffCookie })).status, 403);
    assert.equal((await f.json(`/api/restaurant/restaurants/${owned.id}/menu`, { method: "POST", cookie: staffCookie, body: { name: "Forbidden", description: "", priceMinor: 100 } })).status, 403);
    assert.equal((await f.json("/api/restaurant/restaurants", { method: "POST", cookie: staffCookie, body: { name: "Forbidden tenant" } })).status, 403);
    const item = (await f.json(`/api/restaurants/${owned.id}/menu`)).body.data.items[0];
    const order = await f.json("/api/orders", { method: "POST", cookie: a.customer, headers: { "Idempotency-Key": "staff-privacy" }, body: { restaurantId: owned.id, items: [{ menuItemId: item.id, quantity: 1 }], paymentMethod: "mock_card", fulfillment: "collection" } });
    const staffOrder = (await f.json(`/api/restaurant/restaurants/${owned.id}/orders`, { cookie: staffCookie })).body.data[0];
    assert.equal(staffOrder.id, order.body.data.id); assert.equal("ledger" in staffOrder, false); assert.equal("contract" in staffOrder, false); assert.equal("commissionMinor" in staffOrder, false);
    const staffProgress = await f.json(`/api/restaurant/orders/${staffOrder.id}/status`, { method: "PATCH", cookie: staffCookie, body: { status: "accepted" } }); assert.equal(staffProgress.status, 200); assert.equal("ledger" in staffProgress.body.data, false); assert.equal("contract" in staffProgress.body.data, false);
    const other = (await f.json("/api/restaurant/restaurants", { cookie: a.owner2 })).body.data[0];
    assert.equal((await f.json(`/api/restaurant/restaurants/${other.id}/orders`, { cookie: staffCookie })).status, 404);
  } finally { await f.close(); }
});

test("opening, overnight, DST, holiday, pause, fulfillment and cash gates are server enforced", async () => {
  const base = { suspended: 0, paused: 0, holiday_dates: "[]", always_open: 0, opening_hours: JSON.stringify([{ day: 6, open: "22:00", close: "02:00" }]) };
  assert.equal(restaurantAvailability(base, new Date("2026-03-29T00:30:00Z")).acceptingOrders, true);
  assert.equal(restaurantAvailability(base, new Date("2026-03-29T01:30:00Z")).acceptingOrders, false);
  assert.equal(restaurantAvailability({ ...base, holiday_dates: JSON.stringify(["2026-03-29"]) }, new Date("2026-03-29T00:30:00Z")).acceptingOrders, false);
  const f = await journeyFixture();
  try {
    const a = await auth(f); const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: a.owner })).body.data[0]; const item = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
    const place = (key, overrides = {}) => f.json("/api/orders", { method: "POST", cookie: a.customer, headers: { "Idempotency-Key": key }, body: { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], paymentMethod: "mock_card", fulfillment: "collection", ...overrides } });
    await f.json(`/api/restaurant/restaurants/${restaurant.id}/profile`, { method: "PATCH", cookie: a.owner, body: { alwaysOpen: false, openingHours: [] } });
    assert.equal((await place("closed")).body.error.code, "RESTAURANT_CLOSED");
    await f.json(`/api/restaurant/restaurants/${restaurant.id}/profile`, { method: "PATCH", cookie: a.owner, body: { alwaysOpen: true, paused: true } });
    assert.equal((await place("paused")).body.error.code, "RESTAURANT_CLOSED");
    await f.json(`/api/restaurant/restaurants/${restaurant.id}/profile`, { method: "PATCH", cookie: a.owner, body: { paused: false, collectionEnabled: false } });
    assert.equal((await place("no-collection")).body.error.code, "COLLECTION_DISABLED");
    await f.json(`/api/restaurant/restaurants/${restaurant.id}/profile`, { method: "PATCH", cookie: a.owner, body: { collectionEnabled: true, cashEnabled: false } });
    assert.equal((await place("no-cash", { paymentMethod: "cash" })).body.error.code, "CASH_DISABLED");
    await f.json(`/api/admin/restaurants/${restaurant.id}/suspension`, { method: "PATCH", cookie: a.admin, body: { suspended: true, reason: "Local review" } });
    assert.equal((await place("suspended")).body.error.code, "RESTAURANT_SUSPENDED");
    assert.equal((await f.json("/api/restaurants")).body.data.some((row) => row.id === restaurant.id), false);
  } finally { await f.close(); }
});

test("required modifiers use server prices and preserve allergen/category/customer snapshots", async () => {
  const f = await journeyFixture();
  try {
    const a = await auth(f); const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: a.owner })).body.data[0];
    const created = await f.json(`/api/restaurant/restaurants/${restaurant.id}/menu`, { method: "POST", cookie: a.owner, body: { name: "Fictional wrap", description: "Demo", priceMinor: 1000, category: "Mains", allergens: ["gluten"], dietaryTags: ["fictional"], modifierGroups: [{ id: "size", name: "Size", minSelections: 1, maxSelections: 1, options: [{ id: "large", name: "Large", priceMinor: 200, available: true }] }] } });
    assert.equal(created.status, 201); const item = created.body.data;
    const place = (key, modifiers) => f.json("/api/orders", { method: "POST", cookie: a.customer, headers: { "Idempotency-Key": key }, body: { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 2, ...(modifiers === undefined ? {} : { modifiers }) }], paymentMethod: "mock_card", fulfillment: "collection", customerPhone: "07000000000", allergyNotes: "No extra gluten please" } });
    assert.equal((await place("missing-modifier", [])).body.error.code, "MODIFIER_SELECTION_INVALID");
    assert.equal((await place("unknown-modifier", [{ groupId: "size", optionIds: ["small"] }])).body.error.code, "MODIFIER_UNAVAILABLE");
    const ordered = await place("modifier-order", [{ groupId: "size", optionIds: ["large"] }]);
    assert.equal(ordered.status, 201); assert.equal(ordered.body.data.subtotalMinor, 2400); assert.equal(ordered.body.data.items[0].basePriceMinor, 1000); assert.equal(ordered.body.data.items[0].unitPriceMinor, 1200); assert.equal(ordered.body.data.customerPhone, "07000000000");
    await f.json(`/api/restaurant/restaurants/${restaurant.id}/menu/${item.id}`, { method: "PATCH", cookie: a.owner, body: { name: "Changed", priceMinor: 5000, allergens: ["changed"], modifierGroups: [] } });
    const snapshot = (await f.json(`/api/orders/${ordered.body.data.id}`, { cookie: a.customer })).body.data.items[0];
    assert.equal(snapshot.name, "Fictional wrap"); assert.deepEqual(snapshot.allergens, ["gluten"]); assert.equal(snapshot.category, "Mains"); assert.equal(snapshot.selectedModifiers[0].name, "Large");
    const receipt = await f.request(`/api/orders/${ordered.body.data.id}/receipt`, { cookie: a.owner }); assert.match(receipt.text, /ALLERGY NOTE/); assert.match(receipt.text, /Allergens: gluten/); assert.doesNotMatch(receipt.text, /Changed/);
  } finally { await f.close(); }
});

test("account export, support and deletion review remain isolated and audited", async () => {
  const f = await journeyFixture();
  try {
    const a = await auth(f);
    const second = await f.json("/api/auth/register", { method: "POST", body: { name: "Other", email: "other-phaseb@example.test", password: "another long password" } }); const secondCookie = second.headers.get("set-cookie").split(";", 1)[0];
    const restaurant = (await f.json("/api/restaurants")).body.data[0]; const item = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
    const ownOrder = await f.json("/api/orders", { method: "POST", cookie: a.customer, headers: { "Idempotency-Key": "export-own" }, body: { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], paymentMethod: "mock_card", fulfillment: "delivery", deliveryAddress: { line1: "1 Export Lane", city: "Luton", postcode: "LU1 1AA" }, allergyNotes: "Own note" } });
    const otherOrder = await f.json("/api/orders", { method: "POST", cookie: secondCookie, headers: { "Idempotency-Key": "export-other" }, body: { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], paymentMethod: "mock_card", fulfillment: "collection" } });
    assert.equal(ownOrder.status, 201); assert.equal(otherOrder.status, 201);
    const profile = await f.json("/api/account", { method: "PATCH", cookie: a.customer, body: { name: "Updated Customer", phone: "07123456789" } }); assert.equal(profile.body.data.phone, "07123456789");
    const support = await f.json("/api/support", { method: "POST", cookie: a.customer, body: { subject: "Local help", message: "Please review" } }); assert.equal(support.status, 201);
    assert.equal((await f.json("/api/support", { cookie: secondCookie })).body.data.length, 0);
    const deletion = await f.json("/api/account/deletion-requests", { method: "POST", cookie: a.customer, body: { reason: "Local review only" } }); assert.equal(deletion.body.data.status, "requested");
    const reviewed = await f.json(`/api/admin/deletion-requests/${deletion.body.data.id}`, { method: "PATCH", cookie: a.admin, body: { status: "under_review", note: "No erasure performed" } }); assert.equal(reviewed.body.data.status, "under_review");
    const resolved = await f.json(`/api/admin/support/${support.body.data.id}`, { method: "PATCH", cookie: a.admin, body: { status: "resolved" } }); assert.equal(resolved.body.data.status, "resolved");
    const exported = await f.json("/api/account/export", { cookie: a.customer }); assert.equal(exported.body.data.account.email, "customer@calai.local"); assert.equal(exported.body.data.support.length, 1); assert.equal(exported.body.data.deletionRequests.length, 1); assert.equal(exported.body.data.orders.length, 1); assert.equal(exported.body.data.orders[0].deliveryAddress.line1, "1 Export Lane"); assert.equal(exported.body.data.orders[0].allergyNotes, "Own note"); assert.equal(JSON.stringify(exported.body).includes(otherOrder.body.data.id), false); assert.equal(JSON.stringify(exported.body).includes("password_hash"), false); assert.equal(JSON.stringify(exported.body).includes("other-phaseb@example.test"), false); assert.equal("contract" in exported.body.data.orders[0], false); assert.equal("commissionMinor" in exported.body.data.orders[0], false);
    const audit = (await f.json("/api/admin/audit", { cookie: a.admin })).body.data; assert.ok(audit.some((row) => row.action === "deletion_review_changed")); assert.ok(audit.some((row) => row.action === "support_status_changed"));
  } finally { await f.close(); }
});

test("demo food fixture is enriched once and reseeding preserves merchant customization", async () => {
  const f = await journeyFixture();
  try {
    const owner = await f.login(...creds.owner); const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0];
    const menu = (await f.json(`/api/restaurant/restaurants/${restaurant.id}/menu`, { cookie: owner })).body.data.items;
    const bowl = menu.find((item) => item.name === "Grilled chicken bowl"); const fries = menu.find((item) => item.name === "Seasoned fries");
    assert.equal(bowl.priceMinor, 1200); assert.equal(fries.priceMinor, 450); assert.equal(bowl.modifierGroups[0].id, "sauce"); assert.deepEqual(bowl.modifierGroups[0].options.map((option) => [option.name, option.priceMinor]), [["Lemon herb", 0], ["Chilli mayo", 50]]);
    f.db.prepare("UPDATE menu_items SET description='Merchant custom description' WHERE id=?").run(bowl.id);
    await seedDemoData(f.db, new Date("2026-01-02T00:00:00.000Z"));
    assert.equal(f.db.prepare("SELECT description FROM menu_items WHERE id=?").get(bowl.id).description, "Merchant custom description");
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM menu_items WHERE restaurant_id=?").get(restaurant.id).n, 2);
    const foodImage = await f.request("/assets/food-demo.png"); assert.equal(foodImage.status, 200); assert.equal(foodImage.headers.get("content-type"), "image/png");
  } finally { await f.close(); }
});
