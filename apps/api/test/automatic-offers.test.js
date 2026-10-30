import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { journeyFixture } from "./helpers.js";

async function setup() {
  const stamp = "2026-01-01T01:00:00.000Z";
  const f = await journeyFixture({ now: () => new Date(stamp), paymentProviderMode: "local_simulator", orderAlertEmail: { mode: "off" }, businessStatements: { sendEnabled: false }, rateLimit: { attempts: 60, windowMs: 60000 } });
  const customer = await f.login("customer@calai.local", "LocalCustomer!4310");
  const user = f.db.prepare("SELECT id FROM users WHERE email='customer@calai.local'").get();
  const owner = f.db.prepare("SELECT id FROM users WHERE email='restaurant@calai.local'").get();
  const restaurant = f.db.prepare("SELECT r.* FROM restaurants r JOIN restaurant_memberships m ON m.restaurant_id=r.id WHERE m.user_id=?").get(owner.id);
  const items = f.db.prepare("SELECT * FROM menu_items WHERE restaurant_id=? ORDER BY rowid").all(restaurant.id);
  const main = items[0], gift = items[1];
  f.db.prepare("UPDATE menu_items SET price_minor=1000,modifier_groups='[]' WHERE id=?").run(main.id);
  f.db.prepare("UPDATE menu_items SET price_minor=300,modifier_groups='[]' WHERE id=?").run(gift.id);
  f.db.prepare("UPDATE restaurants SET delivery_enabled=1,delivery_outcodes='[\"LU1\"]',delivery_fee_minor=250,min_delivery_subtotal_minor=0 WHERE id=?").run(restaurant.id);
  const consent = await f.json("/api/account/marketing-preferences", { method: "PATCH", cookie: customer, body: { inAppPromotions: true, pushPromotions: false, source: "automatic-offer-test" } });
  assert.equal(consent.status, 200, consent.text);
  function grant(type, overrides = {}) {
    const id = randomUUID(), campaignId = randomUUID();
    const offerType = { percent_order: "percent_off", free_item_with_purchase: "free_item" }[type] || "fixed_off";
    f.db.prepare(`INSERT INTO offer_campaigns(id,restaurant_id,created_by_user_id,idempotency_key,request_hash,title,message,
      menu_item_id,item_name,item_value_minor,min_subtotal_minor,expires_at,created_at,starts_at,offer_type,offer_value,
      campaign_type,eligible_item_ids,budget_minor,weekly_budget_minor)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(campaignId, restaurant.id, owner.id, campaignId, campaignId,
      `Automatic ${type}`, "Synthetic promotion", gift.id, "Free side", overrides.giftValue ?? 300, overrides.minimum ?? 0,
      overrides.expires ?? "2026-02-01T00:00:00.000Z", stamp, overrides.starts ?? "2026-01-01T00:00:00.000Z", offerType,
      overrides.value ?? 0, type, JSON.stringify(overrides.eligibleIds ?? []), overrides.budget ?? null, overrides.weeklyBudget ?? null);
    f.db.prepare("INSERT INTO offer_grants(id,campaign_id,restaurant_id,customer_id,status,dismissed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, campaignId, overrides.restaurantId ?? restaurant.id, overrides.customerId ?? user.id, overrides.status ?? "available", overrides.dismissed ? stamp : null, stamp, stamp);
    return { id, campaignId };
  }
  const payload = (quantity = 1, delivery = false) => ({ restaurantId: restaurant.id, items: [{ menuItemId: main.id, quantity }], fulfillment: delivery ? "delivery" : "collection", ...(delivery ? { deliveryAddress: { line1: "10 Fictional Road", city: "Luton", postcode: "LU1 2AB" } } : {}), autoApplyOffers: true });
  async function quote(body = payload()) {
    const before = f.db.prepare("SELECT * FROM offer_grants ORDER BY id").all();
    const orderCount = f.db.prepare("SELECT COUNT(*) n FROM orders").get().n;
    const response = await f.json("/api/orders/quote", { method: "POST", cookie: customer, body });
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(f.db.prepare("SELECT * FROM offer_grants ORDER BY id").all(), before, "Quotes must not reserve, redeem, view or update grants");
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM orders").get().n, orderCount);
    assert.equal(response.body.data.sideEffects, false);
    return response.body.data;
  }
  return { ...f, customer, user, restaurant, main, gift, grant, payload, quote };
}

test("automatic quotes choose one actual saving, respect BOGO quantity and delivery, and retain manual selection", async () => {
  const f = await setup();
  try {
    const fixed = f.grant("amount_order", { value: 200 });
    const percent = f.grant("percent_order", { value: 3000 });
    const bogo = f.grant("buy_one_get_one", { eligibleIds: [f.main.id] });
    let quote = await f.quote();
    assert.equal(quote.offerId, percent.id);
    assert.equal(quote.promotion.grantId, percent.id);
    assert.equal(quote.totalMinor, 700);
    assert.equal(quote.commissionMinor, 49);
    assert.equal((await f.quote({ ...f.payload(), offerId: fixed.id })).offerId, percent.id, "Explicit auto selection owns a stale manual choice");
    quote = await f.quote({ ...f.payload(), autoApplyOffers: false, offerId: fixed.id });
    assert.equal(quote.offerId, fixed.id);
    assert.equal(quote.totalMinor, 800);
    quote = await f.quote(f.payload(2));
    assert.equal(quote.offerId, bogo.id);
    assert.equal(quote.totalMinor, 1000);
    assert.equal(quote.restaurantDiscountMinor, 1000);

    f.db.prepare("UPDATE offer_grants SET dismissed_at='2026-01-01T00:00:00.000Z'").run();
    const freeDelivery = f.grant("free_delivery");
    assert.equal((await f.quote()).offerId, null, "Delivery-only promotion cannot discount collection");
    quote = await f.quote(f.payload(1, true));
    assert.equal(quote.offerId, freeDelivery.id);
    assert.equal(quote.deliveryFeeMinor, 0);
    assert.equal(quote.deliveryDiscountMinor, 250);
    assert.equal(quote.totalMinor, 1000);
    assert.equal(quote.commissionMinor, 70);

    f.db.prepare("UPDATE offer_grants SET dismissed_at='2026-01-01T00:00:00.000Z'").run();
    f.grant("free_item_with_purchase", { giftValue: 100 });
    const largerGift = f.grant("free_item_with_purchase", { giftValue: 300 });
    quote = await f.quote();
    assert.equal(quote.offerId, largerGift.id);
    assert.equal(quote.totalMinor, 1000);
    assert.deepEqual(quote.promotion.gift, { menuItemId: f.gift.id, name: "Free side", quantity: 1, valueMinor: 300 });
    assert.match(quote.promotion.title, /free_item_with_purchase/);
    assert.equal(quote.promotion.campaignType, "free_item_with_purchase");
    const tinySaving = f.grant("amount_order", { value: 1 });
    assert.equal((await f.quote()).offerId, tinySaving.id, "Actual money saved wins over gift retail value");
  } finally { await f.close(); }
});

test("automatic quotes skip invalid or exhausted grants, respect consent and keep checkout revalidation", async () => {
  const f = await setup();
  try {
    const otherId = randomUUID();
    f.db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,'unused','customer',?)").run(otherId, "Other customer", `${otherId}@example.invalid`, "2026-01-01T00:00:00.000Z");
    const otherRestaurant = f.db.prepare("SELECT id FROM restaurants WHERE id<>? LIMIT 1").get(f.restaurant.id);
    f.grant("amount_order", { value: 900, minimum: 2000 });
    f.grant("amount_order", { value: 900, expires: "2025-12-31T00:00:00.000Z" });
    f.grant("amount_order", { value: 900, starts: "2026-01-02T00:00:00.000Z" });
    f.grant("amount_order", { value: 900, customerId: otherId });
    f.grant("amount_order", { value: 900, restaurantId: otherRestaurant.id });
    const dismissed = f.grant("amount_order", { value: 900, dismissed: true });
    f.grant("amount_order", { value: 900, eligibleIds: [f.gift.id] });
    f.grant("amount_order", { value: 900, budget: 1 });
    f.grant("amount_order", { value: 900, weeklyBudget: 1 });
    f.grant("amount_order", { value: 900, status: "reserved" });
    let quote = await f.quote();
    assert.equal(quote.offerId, null);
    assert.equal(quote.promotion, null);
    assert.equal(quote.totalMinor, 1000);
    const valid = f.grant("amount_order", { value: 200 });
    quote = await f.quote({ ...f.payload(), offerId: dismissed.id });
    assert.equal(quote.offerId, valid.id);
    assert.equal(quote.totalMinor, 800);
    f.db.prepare("UPDATE marketing_preferences SET in_app_promotions=0 WHERE user_id=?").run(f.user.id);
    quote = await f.quote();
    assert.equal(quote.offerId, null);
    assert.equal(quote.totalMinor, 1000);
    f.db.prepare("UPDATE marketing_preferences SET in_app_promotions=1 WHERE user_id=?").run(f.user.id);
    f.db.prepare("UPDATE offer_campaigns SET budget_minor=1 WHERE id=?").run(valid.campaignId);
    const create = await f.json("/api/orders", { method: "POST", cookie: f.customer, headers: { "Idempotency-Key": "automatic-recheck" }, body: { restaurantId: f.restaurant.id, items: [{ menuItemId: f.main.id, quantity: 1 }], fulfillment: "collection", paymentMethod: "mock_card", offerId: valid.id } });
    assert.equal(create.status, 409);
    assert.equal(create.body.error.code, "PROMOTION_BUDGET_EXHAUSTED");
  } finally { await f.close(); }
});

test("automatic offer evaluation is bounded and reports truncation", async () => {
  const f = await setup();
  try {
    for (let index = 0; index < 101; index++) f.grant("amount_order", { value: 1 });
    const quote = await f.quote();
    assert.equal(quote.totalMinor, 999);
    assert.deepEqual(quote.autoOfferSelection, { candidateLimit: 100, truncated: true, candidatesChecked: 100 });
  } finally { await f.close(); }
});
