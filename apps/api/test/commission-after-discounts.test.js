import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { journeyFixture } from "./helpers.js";
import { buildWeeklyStatementSnapshot, weeklyStatementPeriod } from "../src/business-weekly-statements.js";

test("7% commission follows £15 less a £4 restaurant offer through saved earnings and refunds", async () => {
  const f = await journeyFixture({
    now: () => new Date("2026-01-01T01:00:00.000Z"),
    paymentProviderMode: "local_simulator",
    orderAlertEmail: { mode: "off" },
    businessStatements: { sendEnabled: false },
    rateLimit: { attempts: 30, windowMs: 60000 }
  });
  try {
    const owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310");
    const customer = await f.login("customer@calai.local", "LocalCustomer!4310");
    const admin = await f.login("admin@calai.local", "LocalAdmin!4310");
    const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0];
    const root = `/api/restaurant/restaurants/${restaurant.id}`;
    const item = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
    const editPrice = async priceMinor => {
      const response = await f.json(`${root}/menu/${item.id}`, { method: "PATCH", cookie: owner, body: { priceMinor } });
      assert.equal(response.status, 200, response.text);
    };
    await editPrice(1500);

    const basket = { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], fulfillment: "collection" };
    const place = async (key, offerId) => {
      const response = await f.json("/api/orders", {
        method: "POST", cookie: customer, headers: { "Idempotency-Key": key },
        body: { ...basket, paymentMethod: "mock_card", ...(offerId ? { offerId } : {}) }
      });
      assert.equal(response.status, 201, response.text);
      return response.body.data;
    };
    const advance = async (orderId, status) => {
      const response = await f.json(`/api/restaurant/orders/${orderId}/status`, { method: "PATCH", cookie: owner, body: { status } });
      assert.equal(response.status, 200, response.text);
      return response.body.data;
    };

    // Establish the completed purchase required for a real targeted offer grant.
    const history = await place("commission-relationship");
    for (const status of ["accepted", "preparing", "ready", "completed"]) await advance(history.id, status);
    const consent = await f.json("/api/account/marketing-preferences", {
      method: "PATCH", cookie: customer,
      body: { inAppPromotions: true, pushPromotions: false, source: "commission-regression" }
    });
    assert.equal(consent.status, 200, consent.text);
    const campaign = await f.json(`${root}/loyalty/promotions`, {
      method: "POST", cookie: owner, headers: { "Idempotency-Key": "commission-four-pounds-off" },
      body: {
        title: "Four pounds off", message: "Restaurant-funded collection offer", offerType: "fixed_off", value: 400,
        menuItemId: null, minSubtotalMinor: 0, startsAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-10T00:00:00.000Z",
        redemptionLimit: 1, budgetMinor: 10000, eligibleItemIds: [], eligibleCategories: [],
        recipientSegment: "selected", customerIds: [history.customerId], stackingPolicy: "exclusive", fundingParty: "restaurant"
      }
    });
    assert.equal(campaign.status, 201, campaign.text);
    const grant = (await f.json("/api/offers", { cookie: customer })).body.data.find(row => row.campaignId === campaign.body.data.id);
    assert.ok(grant);

    const quoteResponse = await f.json("/api/orders/quote", { method: "POST", cookie: customer, body: { ...basket, offerId: grant.id } });
    assert.equal(quoteResponse.status, 200, quoteResponse.text);
    const quote = quoteResponse.body.data;
    assert.equal(quote.grossFoodMinor, 1500);
    assert.equal(quote.restaurantDiscountMinor, 400);
    assert.equal(quote.subtotalMinor, 1100);
    assert.equal(quote.commission.baseMinor, 1100);
    assert.equal(quote.commission.rateBasisPoints, 700);
    assert.equal(quote.commissionMinor, 77);

    const order = await place("commission-discounted-order", grant.id);
    assert.equal(order.grossFoodMinor, 1500);
    assert.equal(order.restaurantDiscountMinor, 400);
    assert.equal(order.subtotalMinor, 1100);
    assert.equal(order.totalMinor, 1100);
    assert.equal(order.commissionMinor, 77);
    assert.equal(order.contract.rateBasisPoints, 700);
    const accepted = await advance(order.id, "accepted");
    assert.equal(accepted.ledger.find(row => row.kind === "commission_mock").amountMinor, 77);
    const commissionOperation = f.db.prepare("SELECT amount_minor FROM marketplace_operations WHERE order_id=? AND kind='commission'").get(order.id);
    assert.equal(commissionOperation.amount_minor, 77);
    for (const status of ["preparing", "ready", "completed"]) await advance(order.id, status);

    const breakdown = async () => {
      const response = await f.json(`${root}/finance/orders/${order.id}/breakdown`, { cookie: owner });
      assert.equal(response.status, 200, response.text);
      return response.body.data;
    };
    const original = await breakdown();
    assert.equal(original.commission.originalMinor, 77);
    assert.equal(original.commission.retainedMinor, 77);
    assert.equal(original.commission.commissionableMinor, 1100);
    assert.equal(original.earnings.currentMinor, 1023);

    // Only the disposable fixture's current settings change; saved order terms must survive.
    f.db.prepare("UPDATE contracts SET rate_bps=999 WHERE restaurant_id=?").run(restaurant.id);
    await editPrice(2500);
    const saved = await breakdown();
    assert.equal(saved.totals.grossFoodMinor, 1500);
    assert.equal(saved.totals.restaurantDiscountMinor, 400);
    assert.equal(saved.totals.foodChargedMinor, 1100);
    assert.equal(saved.items[0].unitPriceMinor, 1500);
    assert.equal(saved.commission.rateBasisPoints, 700);
    assert.equal(saved.commission.originalMinor, 77);
    assert.equal(saved.earnings.currentMinor, 1023);

    const statement = buildWeeklyStatementSnapshot(f.db, restaurant.id, weeklyStatementPeriod("2026-01-05T09:00:00.000Z"), f.config);
    const rows = statement.csv.trim().split("\r\n").map(line => [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(match => match[1].replaceAll('""', '"')));
    const headers = rows.shift();
    const pricing = rows.find(row => row[0] === "order_placed" && row[2] === order.id);
    assert.ok(pricing);
    for (const [column, expected] of Object.entries({
      foodBeforePromotionMinor: 1500, restaurantDiscountMinor: 400, foodChargedMinor: 1100,
      commissionRateBasisPoints: 700, originalCommissionMinor: 77
    })) assert.equal(Number(pricing[headers.indexOf(column)]), expected, column);

    const refund = async (key, foodAmountMinor) => {
      const response = await f.json(`/api/admin/orders/${order.id}/refunds`, {
        method: "POST", cookie: admin, headers: { "Idempotency-Key": key },
        body: { foodAmountMinor, deliveryAmountMinor: 0, reason: "Synthetic commission regression refund" }
      });
      assert.equal(response.status, 201, response.text);
      return response.body.data;
    };
    const partial = await refund("commission-partial-refund", 400);
    assert.equal(partial.refund.commissionReversalMinor, 28);
    const afterPartial = await breakdown();
    assert.equal(afterPartial.commission.originalMinor, 77);
    assert.equal(afterPartial.commission.retainedMinor, 49);
    assert.equal(afterPartial.earnings.currentMinor, 651);

    const full = await refund("commission-remaining-refund", 700);
    assert.equal(full.refund.commissionReversalMinor, 49);
    assert.equal(full.order.paymentStatus, "mock_refunded");
    const afterFull = await breakdown();
    assert.equal(afterFull.commission.rateBasisPoints, 700);
    assert.equal(afterFull.commission.originalMinor, 77);
    assert.equal(afterFull.commission.reversedMinor, 77);
    assert.equal(afterFull.commission.retainedMinor, 0);
    assert.equal(afterFull.earnings.currentMinor, 0);
  } finally {
    await f.close();
  }
});

test("new delivery commission includes the charged fee, excludes waived fees and preserves saved food-only orders", async () => {
  const stamp = "2026-01-01T01:00:00.000Z";
  const f = await journeyFixture({
    now: () => new Date(stamp), paymentProviderMode: "local_simulator",
    orderAlertEmail: { mode: "off" }, businessStatements: { sendEnabled: false },
    rateLimit: { attempts: 60, windowMs: 60000 }
  });
  try {
    const owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310");
    const customer = await f.login("customer@calai.local", "LocalCustomer!4310");
    const admin = await f.login("admin@calai.local", "LocalAdmin!4310");
    const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0];
    const root = `/api/restaurant/restaurants/${restaurant.id}`;
    const item = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
    const priced = await f.json(`${root}/menu/${item.id}`, { method: "PATCH", cookie: owner, body: { priceMinor: 1500 } });
    assert.equal(priced.status, 200, priced.text);
    const deliverySettings = await f.json(`${root}/delivery`, {
      method: "PATCH", cookie: owner,
      body: { enabled: true, outcodes: ["LU1"], deliveryFeeMinor: 200, minDeliverySubtotalMinor: 0 }
    });
    assert.equal(deliverySettings.status, 200, deliverySettings.text);
    const basket = { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], fulfillment: "collection" };
    const deliveredBasket = { ...basket, fulfillment: "delivery", deliveryAddress: { line1: "10 Fictional Road", city: "Luton", postcode: "LU1 2AB" } };
    const place = async (key, body) => {
      const response = await f.json("/api/orders", {
        method: "POST", cookie: customer, headers: { "Idempotency-Key": key }, body: { ...body, paymentMethod: "mock_card" }
      });
      assert.equal(response.status, 201, response.text);
      return response.body.data;
    };
    const advance = async (orderId, status) => {
      const response = await f.json(`/api/restaurant/orders/${orderId}/status`, { method: "PATCH", cookie: owner, body: { status } });
      assert.equal(response.status, 200, response.text);
      return response.body.data;
    };
    const history = await place("delivery-commission-relationship", basket);
    for (const status of ["accepted", "preparing", "ready", "completed"]) await advance(history.id, status);
    const consent = await f.json("/api/account/marketing-preferences", {
      method: "PATCH", cookie: customer, body: { inAppPromotions: true, pushPromotions: false, source: "delivery-commission-regression" }
    });
    assert.equal(consent.status, 200, consent.text);
    const grantOffer = async (campaignType, offerType, value) => {
      const campaign = await f.json(`${root}/loyalty/promotions`, {
        method: "POST", cookie: owner, headers: { "Idempotency-Key": `delivery-commission-${campaignType}` },
        body: {
          title: `Delivery commission ${campaignType}`, message: "Restaurant-funded test offer", campaignType, offerType, value,
          menuItemId: null, minSubtotalMinor: 0, startsAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-10T00:00:00.000Z",
          redemptionLimit: 1, budgetMinor: 10000, eligibleItemIds: [], eligibleCategories: [],
          recipientSegment: "selected", customerIds: [history.customerId], stackingPolicy: "exclusive", fundingParty: "restaurant"
        }
      });
      assert.equal(campaign.status, 201, campaign.text);
      const grant = (await f.json("/api/offers", { cookie: customer })).body.data.find(row => row.campaignId === campaign.body.data.id);
      assert.ok(grant);
      return grant;
    };
    const quote = async body => {
      const response = await f.json("/api/orders/quote", { method: "POST", cookie: customer, body });
      assert.equal(response.status, 200, response.text);
      return response.body.data;
    };
    const discountedOffer = await grantOffer("amount_order", "fixed_off", 400);
    const discountedBasket = { ...deliveredBasket, offerId: discountedOffer.id };
    const deliveryQuote = await quote(discountedBasket);
    assert.equal(deliveryQuote.grossFoodMinor, 1500);
    assert.equal(deliveryQuote.restaurantDiscountMinor, 400);
    assert.equal(deliveryQuote.subtotalMinor, 1100);
    assert.equal(deliveryQuote.deliveryFeeMinor, 200);
    assert.equal(deliveryQuote.totalMinor, 1300);
    assert.equal(deliveryQuote.commission.base, "food_plus_delivery");
    assert.equal(deliveryQuote.commission.baseMinor, 1300);
    assert.equal(deliveryQuote.commissionMinor, 91);
    const delivered = await place("delivery-commission-discounted", discountedBasket);
    assert.equal(delivered.totalMinor, 1300);
    assert.equal(delivered.commissionMinor, 91);
    assert.equal(delivered.contract.commissionBase, "food_plus_delivery");
    const accepted = await advance(delivered.id, "accepted");
    assert.equal(accepted.ledger.find(row => row.kind === "commission_mock").amountMinor, 91);
    const breakdown = async orderId => {
      const response = await f.json(`${root}/finance/orders/${orderId}/breakdown`, { cookie: owner });
      assert.equal(response.status, 200, response.text);
      return response.body.data;
    };
    assert.equal((await breakdown(delivered.id)).earnings.currentMinor, 1209);
    const refundDelivery = async (orderId, key) => {
      const response = await f.json(`/api/admin/orders/${orderId}/refunds`, {
        method: "POST", cookie: admin, headers: { "Idempotency-Key": key },
        body: { foodAmountMinor: 0, deliveryAmountMinor: 100, reason: "Synthetic delivery-only refund" }
      });
      assert.equal(response.status, 201, response.text);
      return response.body.data.refund;
    };
    assert.equal((await refundDelivery(delivered.id, "new-delivery-refund")).commissionReversalMinor, 7);
    const refunded = await breakdown(delivered.id);
    assert.equal(refunded.commission.retainedMinor, 84);
    assert.equal(refunded.earnings.currentMinor, 1116);

    const waivedOffer = await grantOffer("free_delivery", "free_delivery", 0);
    const waivedBasket = { ...deliveredBasket, offerId: waivedOffer.id };
    const waivedQuote = await quote(waivedBasket);
    assert.equal(waivedQuote.deliveryDiscountMinor, 200);
    assert.equal(waivedQuote.deliveryFeeMinor, 0);
    assert.equal(waivedQuote.commission.baseMinor, 1500);
    assert.equal(waivedQuote.commissionMinor, 105);
    const waived = await place("delivery-commission-waived", waivedBasket);
    assert.equal(waived.deliveryFeeMinor, 0);
    assert.equal(waived.totalMinor, 1500);
    assert.equal(waived.commissionMinor, 105);
    assert.equal(f.db.prepare("SELECT delivery_fee_minor FROM restaurants WHERE id=?").get(restaurant.id).delivery_fee_minor, 200);

    // Model a persisted historical snapshot independently of the new-order default.
    const historicalId = randomUUID();
    f.db.prepare(`INSERT INTO orders(id,restaurant_id,restaurant_name,customer_id,status,subtotal_minor,delivery_fee_minor,total_minor,
      commission_minor,payment_method,payment_status,fulfillment,idempotency_key,request_hash,created_at,updated_at,
      contract_rate_bps,commission_base,gross_food_minor,restaurant_discount_minor)
      VALUES(?,?,?,?,'accepted',1100,200,1300,77,'mock_card','mock_captured','delivery',?,?,?, ?,700,'food',1500,400)`)
      .run(historicalId, restaurant.id, restaurant.name, history.customerId, "historical-food-only", "historical-fixture", stamp, stamp);
    const historical = await breakdown(historicalId);
    assert.equal(historical.commission.base, "food");
    assert.equal(historical.commission.originalMinor, 77);
    assert.equal((await refundDelivery(historicalId, "historical-delivery-refund")).commissionReversalMinor, 0);
    const savedHistorical = await breakdown(historicalId);
    assert.equal(savedHistorical.commission.base, "food");
    assert.equal(savedHistorical.commission.retainedMinor, 77);
    assert.equal(savedHistorical.earnings.currentMinor, 1123);
  } finally {
    await f.close();
  }
});
