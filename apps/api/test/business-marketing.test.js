import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { journeyFixture } from "./helpers.js";
import { campaignWeekStart } from "../src/promotion-mechanics.js";
import { DatabaseSync } from "node:sqlite";
import { marketingCampaignMigration32 } from "../src/marketing-campaign-migration.js";

async function setup() {
  let stamp = Date.parse("2026-10-30T12:00:00.000Z"), sequence = 0;
  const f = await journeyFixture({ now: () => new Date(stamp), sessionHours: 24 * 90, rateLimit: { attempts: 60, windowMs: 60000 } });
  const owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310"), customer = await f.login("customer@calai.local", "LocalCustomer!4310"), otherOwner = await f.login("restaurant2@calai.local", "LocalRestaurant2!4310");
  const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0], root = `/api/restaurant/restaurants/${restaurant.id}`;
  const items = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items;
  const main = items[0], gift = items[1], other = { id: randomUUID() };
  f.db.prepare("UPDATE menu_items SET price_minor=1000,modifier_groups='[]',category='mains' WHERE id=?").run(main.id);
  f.db.prepare("UPDATE menu_items SET price_minor=300,modifier_groups='[]',category='sides' WHERE id=?").run(gift.id);
  f.db.prepare("INSERT INTO menu_items(id,restaurant_id,name,price_minor,category,created_at,updated_at) VALUES(?,?,'Other paid dish',700,'sides',?,?)").run(other.id, restaurant.id, new Date(stamp).toISOString(), new Date(stamp).toISOString());
  await f.json(`${root}/delivery`, { method: "PATCH", cookie: owner, body: { enabled: true, outcodes: ["LU1"], deliveryFeeMinor: 275, minDeliverySubtotalMinor: 0 } });
  const customerId = f.db.prepare("SELECT id FROM users WHERE email='customer@calai.local'").get().id;
  const basket = (id = main.id, quantity = 1) => [{ menuItemId: id, quantity }];
  const payload = (offerId, cart = basket(), fulfillment = "collection") => ({ restaurantId: restaurant.id, items: cart, fulfillment, ...(fulfillment === "delivery" ? { deliveryAddress: { line1: "10 Fictional Road", city: "Luton", postcode: "LU1 2AB" } } : {}), ...(offerId ? { offerId } : {}) });
  async function place(offerId, cart, fulfillment, cookie = customer) { return f.json("/api/orders", { method: "POST", cookie, headers: { "Idempotency-Key": `marketing-order-${sequence++}` }, body: { ...payload(offerId, cart, fulfillment), paymentMethod: "cash" } }); }
  async function complete(orderId, cookie = owner) { for (const status of ["accepted", "preparing", "ready", "completed"]) { const result = await f.json(`/api/restaurant/orders/${orderId}/status`, { method: "PATCH", cookie, body: { status } }); assert.equal(result.status, 200, result.text); } }
  async function consent(cookie) { const result = await f.json("/api/account/marketing-preferences", { method: "PATCH", cookie, body: { inAppPromotions: true, pushPromotions: false, source: "marketing-fixture" } }); assert.equal(result.status, 200, result.text); }
  async function newCustomer(email) {
    const response = await f.json("/api/auth/register", { method: "POST", body: { name: "Fictional second customer", email, password: "MarketingFixture!4310" } });
    assert.equal(response.status, 201, response.text);
    const cookie = response.headers.get("set-cookie").split(";", 1)[0]; await consent(cookie);
    return { cookie, id: response.body.data.user.id };
  }
  async function campaign(type, overrides = {}, cookie = owner) {
    const offerType = { percent_items: "percent_off", percent_order: "percent_off", amount_order: "fixed_off", free_item_with_purchase: "free_item" }[type] ?? type;
    const body = { title: `Fixture ${type}`, message: "A restaurant-funded test promotion", campaignType: type, offerType, value: ["percent_items", "percent_order", "happy_hour"].includes(type) ? 1000 : type === "amount_order" ? 100 : 0, menuItemId: ["free_item_with_purchase", "buy_one_get_free_item"].includes(type) ? gift.id : null, buyItemId: type === "buy_one_get_free_item" ? main.id : null, minSubtotalMinor: 0, startsAt: "2026-10-30T00:00:00.000Z", expiresAt: "2026-11-30T00:00:00.000Z", redemptionLimit: 1000, budgetMinor: null, weeklyBudgetMinor: null, eligibleItemIds: ["percent_items", "buy_one_get_one"].includes(type) ? [main.id] : [], eligibleCategories: [], recipientSegment: "selected", customerIds: [customerId], stackingPolicy: "exclusive", fundingParty: "restaurant", ...overrides };
    const submittedKey=`marketing-campaign-${sequence++}`,response=await f.json(`${root}/loyalty/promotions`, { method: "POST", cookie, headers: { "Idempotency-Key": submittedKey }, body });
    return {...response,submittedBody:body,submittedKey};
  }
  async function grant(created, cookie = customer) {
    assert.equal(created.status, 201, created.text);
    const response = await f.json("/api/offers", { cookie });
    const offer = response.body.data.find(row => row.campaignId === created.body.data.id);
    assert.ok(offer, "Expected a scoped promotion grant"); return offer;
  }
  const quote = (offerId, cart, fulfillment, cookie = customer) => f.json("/api/orders/quote", { method: "POST", cookie, body: payload(offerId, cart, fulfillment) });
  const history = await place(); assert.equal(history.status, 201, history.text); await complete(history.body.data.id); await consent(customer);
  return { ...f, owner, otherOwner, customer, customerId, restaurant, root, main, gift, other, basket, payload, place, complete, consent, newCustomer, campaign, grant, quote, set(value) { stamp = Date.parse(value); } };
}

test("all advertised marketing mechanics quote and redeem server prices without changing owner delivery configuration", async () => {
  const f = await setup();
  try {
    const mixed = [...f.basket(), ...f.basket(f.gift.id)];
    const percentItems = await f.grant(await f.campaign("percent_items", { value: 2500 }));
    assert.equal((await f.quote(percentItems.id, mixed)).body.data.restaurantDiscountMinor, 250);
    assert.equal((await f.place(percentItems.id,mixed)).body.data.totalMinor,1050);
    const percentOrder = await f.grant(await f.campaign("percent_order"));
    assert.equal((await f.quote(percentOrder.id, mixed)).body.data.restaurantDiscountMinor, 130);
    assert.equal((await f.place(percentOrder.id,mixed)).body.data.totalMinor,1170);
    assert.equal((await f.campaign("percent_order",{value:10000})).status,400);
    assert.equal((await f.campaign("happy_hour",{value:10000})).status,400);
    assert.equal((await f.campaign("percent_items",{eligibleItemIds:f.main.id})).status,400);
    const amount = await f.grant(await f.campaign("amount_order", { value: 400 }));
    assert.equal((await f.quote(amount.id, mixed)).body.data.totalMinor, 900);
    assert.equal((await f.place(amount.id,mixed)).body.data.totalMinor,900);

    const freeGift = await f.grant(await f.campaign("free_item_with_purchase", { weeklyBudgetMinor: 300 }));
    const giftQuote = await f.quote(freeGift.id); assert.equal(giftQuote.body.data.promotion.gift.valueMinor, 300); assert.equal(giftQuote.body.data.totalMinor, 1000);
    const giftOrder = await f.place(freeGift.id); assert.equal(giftOrder.status, 201, giftOrder.text);
    assert.equal(giftOrder.body.data.items.filter(row => row.isOfferItem).length, 1);
    assert.equal(f.db.prepare("SELECT reserved_discount_minor FROM offer_grants WHERE id=?").get(freeGift.id).reserved_discount_minor, 300, "Gift retail value must consume promotional budget");

    const bogo = await f.grant(await f.campaign("buy_one_get_one"));
    assert.equal((await f.quote(bogo.id)).body.error.code, "PROMOTION_BUY_QUANTITY");
    const groups = [{ id: "extras", name: "Extras", minSelections: 0, maxSelections: 1, options: [{ id: "sauce", name: "Sauce", priceMinor: 100, available: true }] }];
    f.db.prepare("UPDATE menu_items SET modifier_groups=? WHERE id=?").run(JSON.stringify(groups), f.main.id);
    const bogoBasket = [{ menuItemId: f.main.id, quantity: 3, modifiers: [{ groupId: "extras", optionIds: ["sauce"] }] }];
    const bogoQuote = await f.quote(bogo.id, bogoBasket); assert.equal(bogoQuote.status, 200, bogoQuote.text);
    assert.equal(bogoQuote.body.data.grossFoodMinor, 3300); assert.equal(bogoQuote.body.data.restaurantDiscountMinor, 1000); assert.equal(bogoQuote.body.data.subtotalMinor, 2300);
    const bogoOrder = await f.place(bogo.id, bogoBasket); assert.equal(bogoOrder.status, 201, bogoOrder.text); assert.equal(bogoOrder.body.data.totalMinor, 2300); assert.equal(bogoOrder.body.data.commissionMinor, 161); assert.equal(bogoOrder.body.data.promotion.allocations[0].discountMinor, 1000);

    const crossGift = await f.grant(await f.campaign("buy_one_get_free_item"));
    assert.equal(crossGift.campaignRules.buyItemName, f.main.name);
    assert.equal((await f.quote(crossGift.id, f.basket(f.other.id))).body.error.code, "PROMOTION_PURCHASE_REQUIRED");
    const crossOrder = await f.place(crossGift.id); assert.equal(crossOrder.status, 201, crossOrder.text); assert.equal(crossOrder.body.data.items.find(row => row.isOfferItem).menuItemId, f.gift.id);

    const delivery = await f.grant(await f.campaign("free_delivery"));
    assert.equal((await f.quote(delivery.id)).body.error.code, "PROMOTION_DELIVERY_REQUIRED");
    const deliveryQuote = await f.quote(delivery.id, undefined, "delivery"); assert.equal(deliveryQuote.status, 200, deliveryQuote.text);
    assert.equal(deliveryQuote.body.data.deliveryFeeMinor, 0); assert.equal(deliveryQuote.body.data.deliveryDiscountMinor, 275); assert.equal(deliveryQuote.body.data.restaurantDiscountMinor, 0);
    const waived = await f.place(delivery.id, undefined, "delivery"); assert.equal(waived.status, 201, waived.text); assert.equal(waived.body.data.totalMinor, 1000); assert.equal(waived.body.data.deliveryDiscountMinor, 275); assert.equal(waived.body.data.commissionMinor, 70);
    assert.equal(f.db.prepare("SELECT delivery_fee_minor FROM restaurants WHERE id=?").get(f.restaurant.id).delivery_fee_minor, 275);

    const happy = await f.grant(await f.campaign("happy_hour", { startsAt: "2026-10-30T12:01:00.000Z", expiresAt: "2026-10-30T12:02:00.000Z" }));
    assert.equal((await f.quote(happy.id)).body.error.code, "OFFER_NOT_STARTED");
    f.set("2026-10-30T12:01:30.000Z"); assert.equal((await f.quote(happy.id)).body.data.restaurantDiscountMinor, 100);
    const timedOrder=await f.place(happy.id);assert.equal(timedOrder.status,201,timedOrder.text);assert.equal(timedOrder.body.data.totalMinor,900);
    await f.json(`/api/restaurant/orders/${timedOrder.body.data.id}/status`,{method:"PATCH",cookie:f.owner,body:{status:"rejected"}});
    f.set("2026-10-30T12:02:00.000Z"); assert.equal((await f.quote(happy.id)).body.error.code, "OFFER_EXPIRED");

    const all = await f.campaign("amount_order", { recipientSegment: "all", customerIds: [] }); assert.equal(all.status, 201, all.text); assert.equal(all.body.data.recipientSegment, "all");
    assert.equal((await f.campaign("percent_items", {}, f.otherOwner)).status, 404);
    const staff = await f.json(`${f.root}/staff`, { method: "POST", cookie: f.owner, body: { name: "Campaign staff", email: "campaign-staff@example.invalid", password: "CampaignStaff!4310" } }); assert.equal(staff.status, 201, staff.text);
    const staffCookie = await f.login("campaign-staff@example.invalid", "CampaignStaff!4310");
    assert.equal((await f.campaign("percent_items", {}, staffCookie)).status, 403);
    const foreignRestaurant = (await f.json("/api/restaurant/restaurants", { cookie: f.otherOwner })).body.data[0], foreignId = randomUUID();
    f.db.prepare("INSERT INTO menu_items(id,restaurant_id,name,price_minor,created_at,updated_at) VALUES(?,?,'Foreign',100,?,?)").run(foreignId, foreignRestaurant.id, "2026-10-30T00:00:00Z", "2026-10-30T00:00:00Z");
    assert.equal((await f.campaign("percent_items", { eligibleItemIds: [foreignId] })).body.error.code, "MENU_UNAVAILABLE");
    const newcomer = await f.newCustomer("campaign-new@example.invalid");
    const firstCampaign = await f.campaign("amount_order", { recipientSegment: "first_order", customerIds: [], weeklyBudgetMinor: 1000 }); assert.equal(firstCampaign.status, 201, firstCampaign.text);
    const publicPromotions = await f.json(`/api/promotions?restaurantId=${f.restaurant.id}`, { cookie: newcomer.cookie });
    assert.equal("weeklyBudgetMinor" in publicPromotions.body.data[0], false, "Private campaign budgets must not be exposed by public promotion discovery");
    const claimed = await f.json(`/api/promotions/${firstCampaign.body.data.id}/claim`, { method: "POST", cookie: newcomer.cookie, body: {} }); assert.equal(claimed.status, 200, claimed.text);
    const firstOrder = await f.place(undefined, undefined, undefined, newcomer.cookie); await f.complete(firstOrder.body.data.id);
    assert.equal((await f.quote(claimed.body.data.id, undefined, undefined, newcomer.cookie)).body.error.code, "FIRST_ORDER_INELIGIBLE");
    const retry=await f.campaign("amount_order");assert.equal(retry.status,201,retry.text);
    f.db.prepare("UPDATE menu_items SET available=0").run();
    const replay=await f.json(`${f.root}/loyalty/promotions`,{method:"POST",cookie:f.owner,headers:{"Idempotency-Key":retry.submittedKey},body:retry.submittedBody});
    assert.equal(replay.status,200,replay.text);assert.equal(replay.body.data.id,retry.body.data.id);
    const conflict=await f.json(`${f.root}/loyalty/promotions`,{method:"POST",cookie:f.owner,headers:{"Idempotency-Key":retry.submittedKey},body:{...retry.submittedBody,value:101}});
    assert.equal(conflict.body.error.code,"IDEMPOTENCY_CONFLICT");
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { await f.close(); }
});

test("marketing migration restores previously uncounted reserved and redeemed gift value only",()=>{
  const db=new DatabaseSync(":memory:");
  try{
    db.exec("CREATE TABLE offer_campaigns(id TEXT PRIMARY KEY,offer_type TEXT,item_value_minor INTEGER);CREATE TABLE offer_grants(id TEXT,campaign_id TEXT,status TEXT,reserved_discount_minor INTEGER);INSERT INTO offer_campaigns VALUES('gift','free_item',300),('percent','percent_off',0);INSERT INTO offer_grants VALUES('held','gift','reserved',0),('used','gift','redeemed',0),('available','gift','available',0),('already-counted','gift','redeemed',125),('discount','percent','reserved',0);");
    db.exec(marketingCampaignMigration32.sql);
    const values=Object.fromEntries(db.prepare("SELECT id,reserved_discount_minor FROM offer_grants").all().map(row=>[row.id,row.reserved_discount_minor]));
    assert.deepEqual(values,{held:300,used:300,available:0,"already-counted":125,discount:0});
  }finally{db.close();}
});

test("weekly spend caps reserve atomically, release rejected gifts and reset at London Monday without resetting lifetime limits", async () => {
  assert.equal(campaignWeekStart("2026-10-25T12:00:00.000Z"), "2026-10-18T23:00:00.000Z");
  assert.equal(campaignWeekStart("2026-10-26T00:00:00.000Z"), "2026-10-26T00:00:00.000Z");
  const f = await setup();
  try {
    const second = await f.newCustomer("campaign-second@example.invalid"), history = await f.place(undefined, undefined, undefined, second.cookie); await f.complete(history.body.data.id);
    const created = await f.campaign("free_item_with_purchase", { customerIds: [f.customerId, second.id], weeklyBudgetMinor: 300, budgetMinor: 600 });
    const firstGrant = await f.grant(created), secondGrant = await f.grant(created, second.cookie);
    const held = await f.place(firstGrant.id); assert.equal(held.status, 201, held.text);
    const before = f.db.prepare("SELECT COUNT(*) AS n FROM orders").get().n;
    assert.equal((await f.place(secondGrant.id, undefined, undefined, second.cookie)).body.error.code, "PROMOTION_WEEKLY_BUDGET_EXHAUSTED");
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM orders").get().n, before);
    await f.json(`/api/restaurant/orders/${held.body.data.id}/status`, { method: "PATCH", cookie: f.owner, body: { status: "rejected" } });
    const used = await f.place(secondGrant.id, undefined, undefined, second.cookie); assert.equal(used.status, 201, used.text); await f.complete(used.body.data.id);
    assert.equal((await f.quote(firstGrant.id)).body.error.code, "PROMOTION_WEEKLY_BUDGET_EXHAUSTED");
    f.set("2026-11-02T00:00:00.000Z");
    const nextWeek = await f.place(firstGrant.id); assert.equal(nextWeek.status, 201, nextWeek.text);
    const summary = (await f.json(`${f.root}/loyalty/promotions`, { cookie: f.owner })).body.data.find(row => row.id === created.body.data.id);
    assert.equal(summary.weeklyCommittedBudgetMinor, 300); assert.equal(summary.committedBudgetMinor, 600);
    const grant = f.db.prepare("SELECT * FROM offer_grants WHERE id=?").get(firstGrant.id); assert.equal(grant.reserved_week_start, "2026-11-02T00:00:00.000Z");
    const race = await f.campaign("amount_order", { customerIds: [f.customerId, second.id], weeklyBudgetMinor: 100, value: 100 });
    const a = await f.grant(race), b = await f.grant(race, second.cookie);
    const results = await Promise.all([f.place(a.id), f.place(b.id, undefined, undefined, second.cookie)]);
    assert.deepEqual(results.map(row => row.status).sort(), [201, 409]);
    assert.equal(results.find(row => row.status === 409).body.error.code, "PROMOTION_WEEKLY_BUDGET_EXHAUSTED");
    const cost = f.db.prepare("SELECT COUNT(*) AS n,SUM(reserved_discount_minor) AS amount FROM offer_grants WHERE campaign_id=? AND status='reserved'").get(race.body.data.id);
    assert.equal(cost.n, 1); assert.equal(cost.amount, 100);
  } finally { await f.close(); }
});
