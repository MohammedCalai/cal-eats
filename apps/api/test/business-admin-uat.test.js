import assert from "node:assert/strict";
import test from "node:test";
import { journeyFixture } from "./helpers.js";
import { runOrderConfirmationAlerts } from "../src/order-confirmation.js";
import { runCustomerTransactionalEmails } from "../src/customer-emails.js";

test("business/admin HTTP acceptance crosses menu, offer, delivery, escalation, support, exports and verified closure", async () => {
  const start = Date.parse("2026-01-01T10:00:00.000Z"); let clock = start;
  const f = await journeyFixture({ now: () => new Date(clock), rateLimit: { attempts: 100, windowMs: 60000 }, orderAlertEmail: { mode: "local", recipient: "operator@example.invalid" } });
  try {
    const admin = await f.login("admin@calai.local", "LocalAdmin!4310"), owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310"), foreignOwner = await f.login("restaurant2@calai.local", "LocalRestaurant2!4310"), customer = await f.login("customer@calai.local", "LocalCustomer!4310");
    const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0], root = `/api/restaurant/restaurants/${restaurant.id}`, manage = `/api/admin/restaurants/${restaurant.id}/manage`;
    const item = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
    const staffCreated = await f.json(`${root}/staff`, { method: "POST", cookie: owner, body: { name: "Acceptance staff", email: "acceptance-staff@example.invalid", password: "Acceptance staff secret 4310" } }); assert.equal(staffCreated.status, 201, staffCreated.text);
    const staff = await f.login("acceptance-staff@example.invalid", "Acceptance staff secret 4310");
    const delivery = { enabled: true, outcodes: ["LU1"], deliveryFeeMinor: 275, minDeliverySubtotalMinor: 0 };
    for (const [cookie, expected] of [[customer, 403], [staff, 403], [foreignOwner, 404], [admin, 403]]) { const denied = await f.json(`${root}/delivery`, { method: "PATCH", cookie, body: delivery }); assert.equal(denied.status, expected, denied.text); }
    const configured = await f.json(`${root}/delivery`, { method: "PATCH", cookie: owner, body: delivery }); assert.equal(configured.status, 200, configured.text);
    const corrected = await f.json(`${manage}/menu/${item.id}`, { method: "PATCH", cookie: admin, body: { name: "Acceptance corrected curry", description: "Restaurant supplied description confirmed by support.", priceMinor: 1500 } }); assert.equal(corrected.status, 200, corrected.text);
    const publicMenu = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items.find(row => row.id === item.id); assert.equal(publicMenu.priceMinor, 1500); assert.equal(publicMenu.description, corrected.body.data.description);
    const deniedOverride = await f.json(`${manage}/menu/${item.id}`, { method: "PATCH", cookie: foreignOwner, body: { priceMinor: 1 } }); assert.equal(deniedOverride.status, 403, deniedOverride.text);
    const consent = await f.json("/api/account/marketing-preferences", { method: "PATCH", cookie: customer, body: { inAppPromotions: true, pushPromotions: false, source: "business-admin-acceptance" } }); assert.equal(consent.status, 200, consent.text);
    const campaign = await f.json(`${manage}/loyalty/promotions`, { method: "POST", cookie: admin, headers: { "Idempotency-Key": "uat-admin-offer" }, body: { title: "Twenty percent off", message: "Restaurant funded acceptance offer", offerType: "percent_off", campaignType: "percent_order", value: 2000, minSubtotalMinor: 0, startsAt: new Date(start).toISOString(), expiresAt: "2026-01-08T10:00:00.000Z", redemptionLimit: 20, budgetMinor: 5000, weeklyBudgetMinor: 5000, eligibleItemIds: [], eligibleCategories: [], recipientSegment: "first_order", customerIds: [], stackingPolicy: "exclusive", fundingParty: "restaurant" } }); assert.equal(campaign.status, 201, campaign.text);
    const claim = await f.json(`/api/promotions/${campaign.body.data.id}/claim`, { method: "POST", cookie: customer, body: {} }); assert.equal(claim.status, 200, claim.text);
    const basket = { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], fulfillment: "delivery", deliveryAddress: { line1: "10 Acceptance Road", city: "Luton", postcode: "LU1 1AA" }, offerId: claim.body.data.id };
    const quoted = await f.json("/api/orders/quote", { method: "POST", cookie: customer, body: basket }); assert.equal(quoted.status, 200, quoted.text); assert.equal(quoted.body.data.subtotalMinor, 1200); assert.equal(quoted.body.data.deliveryFeeMinor, 275); assert.equal(quoted.body.data.totalMinor, 1475); assert.equal(quoted.body.data.commissionMinor, 103);
    const forgedQuote = await f.json("/api/orders/quote", { method: "POST", cookie: customer, body: { ...basket, deliveryFeeMinor: 0 } }); assert.equal(forgedQuote.status, 400, forgedQuote.text);
    const forgedOrder = await f.json("/api/orders", { method: "POST", cookie: customer, headers: { "Idempotency-Key": "uat-forged-delivery-fee" }, body: { ...basket, paymentMethod: "cash", deliveryFeeMinor: 0 } }); assert.equal(forgedOrder.status, 400, forgedOrder.text);
    const placed = await f.json("/api/orders", { method: "POST", cookie: customer, headers: { "Idempotency-Key": "uat-discounted-delivery" }, body: { ...basket, paymentMethod: "cash", expectedTotalMinor: 1475 } }); assert.equal(placed.status, 201, placed.text);
    const order = placed.body.data, statusPath = `/api/restaurant/orders/${order.id}/status`;
    assert.equal(order.totalMinor, 1475); assert.equal(order.commissionMinor, 103); assert.equal(order.deliveryFeeMinor, 275);
    const adminQueue = () => f.json("/api/admin/workspace/unconfirmed-orders", { cookie: admin });
    assert.equal((await adminQueue()).body.data.summary.needsConfirmation, 1);
    assert.equal((await f.json(`${root}/dashboard?period=today`, { cookie: owner })).body.data.operations.pendingConfirmation, 1);
    let escalationPreviews = 0;
    const alertAdapter = async (mail, { beforeSend }) => { assert.equal(beforeSend(), true); escalationPreviews++; assert.equal(mail.to, "operator@example.invalid"); assert.equal(mail.text.includes("10 Acceptance Road"), false); return { status: "local_saved" }; };
    clock = start + 179000; assert.equal((await runOrderConfirmationAlerts(f.db, f.config, { adapter: alertAdapter })).queued, 0); assert.equal(escalationPreviews, 0);
    clock = start + 180000; const escalation = await runOrderConfirmationAlerts(f.db, f.config, { adapter: alertAdapter }); assert.equal(escalation.queued, 1); assert.equal(escalation.localSaved, 1); assert.equal(escalationPreviews, 1); assert.equal((await adminQueue()).body.data.summary.overdue, 1);
    await runOrderConfirmationAlerts(f.db, f.config, { adapter: alertAdapter }); assert.equal(escalationPreviews, 1);
    const ended = await f.json(`${manage}/loyalty/promotions/${campaign.body.data.id}/end`, { method: "POST", cookie: admin, body: {} }); assert.equal(ended.status, 200, ended.text);
    assert.equal((await f.json(`/api/promotions/${campaign.body.data.id}/claim`, { method: "POST", cookie: customer, body: {} })).status, 404);
    for (const [cookie, expected] of [[customer, 403], [foreignOwner, 404], [admin, 403]]) assert.equal((await f.json(statusPath, { method: "PATCH", cookie, body: { status: "accepted" } })).status, expected);
    const eta = new Date(clock + 45 * 60000).toISOString(), confirmed = await f.json(statusPath, { method: "PATCH", cookie: owner, body: { status: "accepted", estimatedReadyAt: eta } }); assert.equal(confirmed.status, 200, confirmed.text); assert.equal(confirmed.body.data.totalMinor, 1475); assert.equal(confirmed.body.data.commissionMinor, 103); assert.equal(confirmed.body.data.customerEtaAt, eta);
    assert.equal((await adminQueue()).body.data.summary.needsConfirmation, 0);
    const customerOrder = await f.json(`/api/orders/${order.id}`, { cookie: customer }); assert.equal(customerOrder.status, 200, customerOrder.text); assert.equal(customerOrder.body.data.status, "accepted"); assert.equal(customerOrder.body.data.customerEtaAt, eta);
    const help = await f.json("/api/support", { method: "POST", cookie: owner, headers: { "Idempotency-Key": "uat-business-help" }, body: { restaurantId: restaurant.id, subject: "Help with kitchen operations", message: "PRIVATE_BUSINESS_HELP_MARKER" } }); assert.equal(help.status, 201, help.text); assert.equal(help.body.data.assignedTo, "platform");
    const ticketId = help.body.data.id, supportQueue = await f.json("/api/admin/support?page=1&assignedTo=platform&waitingFor=team", { cookie: admin }); assert.equal(supportQueue.status, 200, supportQueue.text); assert.ok(supportQueue.body.data.items.some(row => row.id === ticketId));
    assert.equal((await f.json(`/api/restaurant/restaurants/${restaurant.id}/support?page=1`, { cookie: owner })).body.data.total, 0);
    assert.equal((await f.json(`/api/support/${ticketId}`, { cookie: foreignOwner })).status, 404);
    const reply = await f.json(`/api/support/${ticketId}/messages`, { method: "POST", cookie: admin, headers: { "Idempotency-Key": "uat-admin-help-reply" }, body: { message: "PRIVATE_ADMIN_REPLY_MARKER" } }); assert.equal(reply.status, 201, reply.text);
    const thread = await f.json(`/api/support/${ticketId}`, { cookie: owner }); assert.equal(thread.status, 200, thread.text); assert.equal(thread.body.data.messages.at(-1).message, "PRIVATE_ADMIN_REPLY_MARKER"); assert.equal(thread.body.data.waitingFor, "customer");
    for (const status of ["preparing", "ready", "out_for_delivery", "completed"]) { const progressed = await f.json(statusPath, { method: "PATCH", cookie: owner, body: { status } }); assert.equal(progressed.status, 200, progressed.text); if (status === "out_for_delivery") assert.equal((await f.json(`${root}/dashboard?period=today`, { cookie: owner })).body.data.operations.liveOrders, 0); }
    const notices = (await f.json("/api/notifications", { cookie: customer })).body.data.items; assert.ok(notices.some(row => row.title === "Order confirmed")); assert.ok(notices.some(row => row.title === "Out for delivery"));
    const previews = [];
    const emailed = await runCustomerTransactionalEmails(f.db, f.config, { adapter: async (mail, { beforeSend }) => { assert.equal(beforeSend(), true); previews.push(mail); return { status: "local_saved" }; } }); assert.equal(emailed.failed, 0); assert.ok(previews.some(mail => mail.to === "admin@calai.local")); assert.ok(previews.some(mail => mail.to === "restaurant@calai.local")); assert.ok(previews.some(mail => mail.to === "customer@calai.local"));
    for (const mail of previews) assert.equal(/PRIVATE_BUSINESS_HELP_MARKER|PRIVATE_ADMIN_REPLY_MARKER/.test(mail.text + mail.html), false);
    const ownerCsv = await f.request(`${root}/dashboard/orders.csv?period=today`, { cookie: owner }); assert.equal(ownerCsv.status, 200, ownerCsv.text); assert.ok(ownerCsv.text.includes(order.id)); assert.equal(ownerCsv.text.includes("recordedCommissionMinor"), false); assert.equal(ownerCsv.text.includes("10 Acceptance Road"), false);
    const adminCsv = await f.request("/api/admin/dashboard/orders.csv?from=2026-01-01&to=2026-01-01", { cookie: admin }); assert.equal(adminCsv.status, 200, adminCsv.text); assert.ok(adminCsv.text.includes(order.id)); assert.ok(adminCsv.text.includes('"1200","275","1475","103"')); assert.equal(adminCsv.text.includes("10 Acceptance Road"), false);
    assert.equal((await f.request(`${root}/dashboard/orders.csv?period=today`, { cookie: staff })).status, 403); assert.equal((await f.request("/api/admin/dashboard/orders.csv", { cookie: owner })).status, 403);
    const retained = () => Object.fromEntries(["orders", "order_items", "order_events", "ledger_entries", "marketplace_operations", "journal_postings", "offer_grants"].map(table => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const before = retained(), closureRequest = await f.json("/api/account/deletion-requests", { method: "POST", cookie: customer, body: { reason: "Support verified closure acceptance fixture." } }); assert.equal(closureRequest.status, 201, closureRequest.text);
    const closed = await f.json(`/api/admin/deletion-requests/${closureRequest.body.data.id}/close-account`, { method: "POST", cookie: admin, body: { note: "Support verified the customer's identity and confirmed the request after completed delivery." } }); assert.equal(closed.status, 200, closed.text); assert.equal(closed.body.data.accountEnabled, false); assert.equal(closed.body.data.dataReviewStatus, "under_review"); assert.equal(closed.body.data.retainedRecords, true); assert.deepEqual(retained(), before);
    assert.equal((await f.json("/api/auth/me", { cookie: customer })).status, 401);
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { await f.close(); }
});
