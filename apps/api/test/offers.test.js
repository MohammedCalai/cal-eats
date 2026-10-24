import assert from "node:assert/strict";
import test from "node:test";
import { journeyFixture } from "./helpers.js";
import { runExpiryWorker } from "../src/operations.js";

const credentials = { owner: ["restaurant@calai.local", "LocalRestaurant!4310"], owner2: ["restaurant2@calai.local", "LocalRestaurant2!4310"], customer: ["customer@calai.local", "LocalCustomer!4310"] };

async function complete(f, owner, orderId) {
  for (const status of ["accepted", "preparing", "ready", "completed"]) {
    const response = await f.json(`/api/restaurant/orders/${orderId}/status`, { method: "PATCH", cookie: owner, body: { status } });
    assert.equal(response.status, 200, response.text);
  }
}

async function setupEligible(f) {
  const owner = await f.login(...credentials.owner); const owner2 = await f.login(...credentials.owner2); const customer = await f.login(...credentials.customer);
  const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0];
  const items = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items;
  const paid = items.find((item) => item.priceMinor >= 1000); const gift = items.find((item) => item.id !== paid.id);
  const placed = await f.json("/api/orders", { method: "POST", cookie: customer, headers: { "Idempotency-Key": "offer-eligibility" }, body: { restaurantId: restaurant.id, items: [{ menuItemId: paid.id, quantity: 1 }], paymentMethod: "mock_card", fulfillment: "collection" } });
  assert.equal(placed.status, 201, placed.text); await complete(f, owner, placed.body.data.id);
  const customerId = placed.body.data.customerId;
  return { owner, owner2, customer, restaurant, paid, gift, customerId };
}

test("owner campaigns are tenant scoped, idempotent and expose persisted analytics", async () => {
  const f = await journeyFixture();
  try {
    const s = await setupEligible(f);
    const defaultDirectory = await f.json(`/api/restaurant/restaurants/${s.restaurant.id}/customers`, { cookie: s.owner }); assert.equal(defaultDirectory.body.data[0].merchantOffers, false);
    const directory = await f.json(`/api/restaurant/restaurants/${s.restaurant.id}/customers`, { cookie: s.owner });
    assert.deepEqual(directory.body.data.map((row) => row.customerId), [s.customerId]);
    assert.equal(directory.body.data[0].completedOrderCount, 1); assert.equal(directory.body.data[0].averageOrderMinor, directory.body.data[0].netSpendMinor);
    const body = { customerIds: [s.customerId], title: "A free side", message: "Thanks for ordering locally.", menuItemId: s.gift.id, minSubtotalMinor: 500, expiresInDays: 7 };
    assert.equal((await f.json(`/api/restaurant/restaurants/${s.restaurant.id}/offers`, { method: "POST", cookie: s.owner, headers: { "Idempotency-Key": "optout-blocked" }, body })).body.error.code, "RECIPIENT_NOT_ELIGIBLE");
    await f.json("/api/account/preferences", { method: "PATCH", cookie: s.customer, body: { merchantOffers: true } });
    const first = await f.json(`/api/restaurant/restaurants/${s.restaurant.id}/offers`, { method: "POST", cookie: s.owner, headers: { "Idempotency-Key": "campaign-one" }, body });
    assert.equal(first.status, 201, first.text); assert.equal(first.body.data.recipientCount, 1);
    const replay = await f.json(`/api/restaurant/restaurants/${s.restaurant.id}/offers`, { method: "POST", cookie: s.owner, headers: { "Idempotency-Key": "campaign-one" }, body });
    assert.equal(replay.status, 200); assert.equal(replay.body.data.id, first.body.data.id);
    const conflict = await f.json(`/api/restaurant/restaurants/${s.restaurant.id}/offers`, { method: "POST", cookie: s.owner, headers: { "Idempotency-Key": "campaign-one" }, body: { ...body, title: "Changed" } });
    assert.equal(conflict.body.error.code, "IDEMPOTENCY_CONFLICT");
    assert.equal((await f.json(`/api/restaurant/restaurants/${s.restaurant.id}/offers`, { cookie: s.owner2 })).status, 404);
    const offers = await f.json("/api/offers", { cookie: s.customer }); assert.equal(offers.body.data.length, 1); const grant = offers.body.data[0];
    await f.json(`/api/offers/${grant.id}`, { method: "PATCH", cookie: s.customer, body: { viewed: true } });
    const analytics = (await f.json(`/api/restaurant/restaurants/${s.restaurant.id}/offers`, { cookie: s.owner })).body.data[0]; assert.equal(analytics.openedCount, 1);
    const inbox = await f.json("/api/notifications", { cookie: s.customer }); assert.ok(inbox.body.data.items.some((row) => row.offerId === grant.id));
    const notification = inbox.body.data.items[0]; assert.equal((await f.json(`/api/notifications/${notification.id}`, { method: "PATCH", cookie: s.owner, body: { read: true } })).status, 404);
    const read = await f.json(`/api/notifications/${notification.id}`, { method: "PATCH", cookie: s.customer, body: { read: true } }); assert.ok(read.body.data.readAt);
  } finally { await f.close(); }
});

test("offer checkout reserves once, snapshots a free item, releases on rejection and redeems on completion", async () => {
  const f = await journeyFixture();
  try {
    const s = await setupEligible(f); await f.json("/api/account/preferences", { method: "PATCH", cookie: s.customer, body: { merchantOffers: true } }); const admin = await f.login("admin@calai.local", "LocalAdmin!4310"); const campaignBody = { customerIds: [s.customerId], title: "Free fries", message: "One free side with a paid order.", menuItemId: s.gift.id, minSubtotalMinor: 1000, expiresInDays: 7 };
    await f.json(`/api/restaurant/restaurants/${s.restaurant.id}/offers`, { method: "POST", cookie: s.owner, headers: { "Idempotency-Key": "redeem-campaign" }, body: campaignBody });
    const grant = (await f.json("/api/offers", { cookie: s.customer })).body.data[0];
    const request = (key) => f.json("/api/orders", { method: "POST", cookie: s.customer, headers: { "Idempotency-Key": key }, body: { restaurantId: s.restaurant.id, items: [{ menuItemId: s.paid.id, quantity: 1 }], paymentMethod: "mock_card", fulfillment: "collection", offerId: grant.id } });
    const [a, b] = await Promise.all([request("offer-race-a"), request("offer-race-b")]); const successes = [a, b].filter((row) => row.status === 201); const failures = [a, b].filter((row) => row.status === 409);
    assert.equal(successes.length, 1); assert.equal(failures.length, 1); assert.equal(failures[0].body.error.code, "OFFER_UNAVAILABLE");
    const first = successes[0].body.data; assert.equal(first.totalMinor, first.subtotalMinor); assert.equal(first.commissionMinor, Math.round(first.subtotalMinor * 0.07));
    const free = first.items.find((item) => item.isOfferItem); assert.ok(free); assert.equal(free.unitPriceMinor, 0); assert.equal(free.lineTotalMinor, 0); assert.equal(free.basePriceMinor, grant.itemValueMinor); assert.equal(first.offer.itemName, grant.itemName);
    await f.json(`/api/restaurant/orders/${first.id}/status`, { method: "PATCH", cookie: s.owner, body: { status: "rejected" } });
    assert.equal((await f.json("/api/offers", { cookie: s.customer })).body.data[0].status, "available");
    const second = await request("offer-after-release"); assert.equal(second.status, 201, second.text); await complete(f, s.owner, second.body.data.id);
    assert.equal((await f.json("/api/offers", { cookie: s.customer })).body.data[0].status, "redeemed");
    const analytics = (await f.json(`/api/restaurant/restaurants/${s.restaurant.id}/offers`, { cookie: s.owner })).body.data[0]; assert.equal(analytics.redeemedCount, 1); assert.equal(analytics.reservedCount, 0);
    const laterRefund = await f.json(`/api/admin/orders/${second.body.data.id}/refunds`, { method: "POST", cookie: admin, headers: { "Idempotency-Key": "refund-after-redemption" }, body: { foodAmountMinor: second.body.data.subtotalMinor, deliveryAmountMinor: 0, reason: "Completed order refund" } }); assert.equal(laterRefund.status, 201); assert.equal((await f.json("/api/offers", { cookie: s.customer })).body.data[0].status, "redeemed");
    const receipt = await f.request(`/api/orders/${second.body.data.id}/receipt`, { cookie: s.customer }); assert.match(receipt.text, /FREE OFFER ITEM/); assert.match(receipt.text, /Free \(value/);
    const merchantInbox = await f.json("/api/notifications", { cookie: s.owner }); assert.ok(merchantInbox.body.data.items.some((row) => row.orderId === second.body.data.id && row.type === "new_order"));
    const customerInbox = await f.json("/api/notifications", { cookie: s.customer }); assert.ok(customerInbox.body.data.items.some((row) => row.orderId === second.body.data.id && /completed/.test(row.message)));
  } finally { await f.close(); }
});

test("offer eligibility, minimum, expiry, order expiry and pre-completion full refund are enforced", async () => {
  const f = await journeyFixture();
  try {
    const s = await setupEligible(f); await f.json("/api/account/preferences", { method: "PATCH", cookie: s.customer, body: { merchantOffers: true } }); const admin = await f.login("admin@calai.local", "LocalAdmin!4310");
    const outsider = await f.json("/api/auth/register", { method: "POST", body: { name: "No history", email: "no-history@example.test", password: "long local password" } });
    const outsiderId = outsider.body.data.user.id;
    const invalid = await f.json(`/api/restaurant/restaurants/${s.restaurant.id}/offers`, { method: "POST", cookie: s.owner, headers: { "Idempotency-Key": "ineligible" }, body: { customerIds: [outsiderId], title: "Not allowed", message: "No merchant history", menuItemId: s.gift.id, minSubtotalMinor: 0, expiresInDays: 2 } });
    assert.equal(invalid.body.error.code, "RECIPIENT_NOT_ELIGIBLE");
    const terms = { customerIds: [s.customerId], title: "Terms", message: "Spend enough first", menuItemId: s.gift.id, minSubtotalMinor: s.paid.priceMinor + 1, expiresInDays: 2 };
    await f.json(`/api/restaurant/restaurants/${s.restaurant.id}/offers`, { method: "POST", cookie: s.owner, headers: { "Idempotency-Key": "terms" }, body: terms });
    let grant = (await f.json("/api/offers", { cookie: s.customer })).body.data[0];
    const place = (key, offerId = grant.id) => f.json("/api/orders", { method: "POST", cookie: s.customer, headers: { "Idempotency-Key": key }, body: { restaurantId: s.restaurant.id, items: [{ menuItemId: s.paid.id, quantity: 1 }], paymentMethod: "mock_card", fulfillment: "collection", offerId } });
    assert.equal((await place("below-minimum")).body.error.code, "OFFER_MINIMUM");
    f.db.prepare("UPDATE offer_campaigns SET min_subtotal_minor=0,expires_at='2025-01-01T00:00:00.000Z'").run();
    assert.equal((await place("expired-offer")).body.error.code, "OFFER_EXPIRED");
    f.db.prepare("UPDATE offer_campaigns SET expires_at='2027-01-01T00:00:00.000Z'").run();
    const expiring = await place("worker-expiry"); assert.equal(expiring.status, 201);
    f.db.prepare("UPDATE orders SET created_at='2025-01-01T00:00:00.000Z' WHERE id=?").run(expiring.body.data.id);
    assert.equal(runExpiryWorker(f.db, f.config), 1); assert.equal((await f.json("/api/offers", { cookie: s.customer })).body.data[0].status, "available");
    const refunded = await place("refund-release");
    await f.json(`/api/restaurant/orders/${refunded.body.data.id}/status`, { method: "PATCH", cookie: s.owner, body: { status: "accepted" } });
    const refund = await f.json(`/api/admin/orders/${refunded.body.data.id}/refunds`, { method: "POST", cookie: admin, headers: { "Idempotency-Key": "full-before-complete" }, body: { foodAmountMinor: refunded.body.data.subtotalMinor, deliveryAmountMinor: 0, reason: "Local test" } });
    assert.equal(refund.status, 201, refund.text); assert.equal((await f.json("/api/offers", { cookie: s.customer })).body.data[0].status, "available");
    const exportData = (await f.json("/api/account/export", { cookie: s.customer })).body.data; assert.ok(exportData.offers.some((row) => row.id === grant.id)); assert.ok(exportData.notifications.some((row) => row.orderId === refunded.body.data.id));
  } finally { await f.close(); }
});
