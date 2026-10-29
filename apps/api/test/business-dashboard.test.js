import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { dashboardRange } from "../src/business-dashboard.js";
import { journeyFixture } from "./helpers.js";

test("dashboard presets use London calendar days, Monday weeks and exact DST boundaries", () => {
  const spring = dashboardRange("today", new Date("2026-03-29T12:00:00.000Z"));
  assert.equal(spring.from, "2026-03-29T00:00:00.000Z"); assert.equal(spring.toExclusive, "2026-03-29T23:00:00.000Z");
  const autumn = dashboardRange("yesterday", new Date("2026-10-26T12:00:00.000Z"));
  assert.equal(autumn.from, "2026-10-24T23:00:00.000Z"); assert.equal(autumn.toExclusive, "2026-10-26T00:00:00.000Z");
  const week = dashboardRange("this_week", new Date("2026-10-28T12:00:00.000Z"));
  assert.equal(week.fromDate, "2026-10-26"); assert.equal(week.toDate, "2026-10-28");
  const previous = dashboardRange("last_week", new Date("2026-10-28T12:00:00.000Z"));
  assert.equal(previous.fromDate, "2026-10-19"); assert.equal(previous.toDate, "2026-10-25");
  assert.equal(previous.from, "2026-10-18T23:00:00.000Z"); assert.equal(previous.toExclusive, "2026-10-26T00:00:00.000Z");
  assert.throws(() => dashboardRange("all_time"), /invalid/i);
});

test("business dashboard scopes periods, roles, earnings, messages and transfer progress without inventing bank payouts", async () => {
  const now = "2026-10-28T12:00:00.000Z", f = await journeyFixture({ now: () => new Date(now), rateLimit: { attempts: 30, windowMs: 60000 } });
  try {
    const owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310"), otherOwner = await f.login("restaurant2@calai.local", "LocalRestaurant2!4310"), customer = await f.login("customer@calai.local", "LocalCustomer!4310");
    const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0], root = `/api/restaurant/restaurants/${restaurant.id}`;
    const item = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
    let index = 0;
    async function place(paymentMethod, createdAt, target = "completed", restaurantId = restaurant.id, menuItemId = item.id, cookie = owner) {
      const result = await f.json("/api/orders", { method: "POST", cookie: customer, headers: { "Idempotency-Key": `dashboard-order-${index++}` }, body: { restaurantId, items: [{ menuItemId, quantity: 1 }], paymentMethod, fulfillment: "collection" } });
      assert.equal(result.status, 201, result.text);
      const order = result.body.data;
      if (target !== "placed") for (const status of target === "accepted" ? ["accepted"] : ["accepted", "preparing", "ready", "completed"]) {
        const response = await f.json(`/api/restaurant/orders/${order.id}/status`, { method: "PATCH", cookie, body: { status } });
        assert.equal(response.status, 200, response.text);
      }
      f.db.prepare("UPDATE orders SET created_at=? WHERE id=?").run(createdAt, order.id);
      return order;
    }
    const cash = await place("cash", "2026-10-28T08:00:00.000Z"), card = await place("mock_card", "2026-10-28T09:00:00.000Z", "accepted"), stripe = await place("mock_card", "2026-10-28T10:00:00.000Z");
    await place("mock_card", "2026-10-27T09:00:00.000Z");
    await place("mock_card", "2026-10-26T09:00:00.000Z");
    const older = await place("cash", "2026-10-20T09:00:00.000Z");
    const pending = await place("cash", "2026-10-28T11:00:00.000Z", "placed");
    f.db.prepare("UPDATE orders SET confirmation_due_at=? WHERE id=?").run("2026-10-28T11:59:00.000Z", pending.id);
    const actor = f.db.prepare("SELECT id FROM users WHERE email='restaurant@calai.local'").get().id;
    f.db.prepare("INSERT INTO refunds(id,order_id,actor_user_id,idempotency_key,request_hash,food_amount_minor,delivery_amount_minor,reason,mode,commission_reversal_minor,created_at) VALUES(?,?,?,?,?,100,0,'Fixture cash return','manual_cash_return',7,?)").run(randomUUID(), cash.id, actor, "dashboard-refund", "fixture-refund", now);
    f.db.prepare("UPDATE orders SET payment_method='card',payment_status='stripe_captured' WHERE id=?").run(stripe.id);
    f.db.prepare("INSERT INTO stripe_order_payments(order_id,provider_mode,status,created_at,updated_at) VALUES(?,'stripe_test','captured',?,?)").run(stripe.id, now, now);
    f.db.prepare("INSERT INTO marketplace_operations(id,operation_key,restaurant_id,order_id,kind,status,amount_minor,currency,provider_mode,metadata,created_at,updated_at) VALUES(?,?,?,?, 'merchant_transfer','confirmed',?,'GBP','stripe_test','{}',?,?)").run(randomUUID(), `dashboard-transfer:${stripe.id}`, restaurant.id, stripe.id, stripe.totalMinor - stripe.commissionMinor, now, now);
    const sent = await f.json(`/api/orders/${pending.id}/messages`, { method: "POST", cookie: customer, headers: { "Idempotency-Key": "dashboard-unread" }, body: { message: "Please ring the bell." } });
    assert.equal(sent.status, 201, sent.text);
    const refundCase = await f.json("/api/refund-cases", { method: "POST", cookie: customer, body: { orderId: older.id, reason: "quality", description: "Fixture review for dashboard" } });
    assert.equal(refundCase.status, 201, refundCase.text);
    const otherRestaurant = (await f.json("/api/restaurant/restaurants", { cookie: otherOwner })).body.data[0];
    f.db.prepare("UPDATE restaurants SET status='approved' WHERE id=?").run(otherRestaurant.id);
    const otherItem = { id: randomUUID() };
    f.db.prepare("INSERT INTO menu_items(id,restaurant_id,name,price_minor,created_at,updated_at) VALUES(?,?,'Other restaurant dish',9999,?,?)").run(otherItem.id, otherRestaurant.id, now, now);
    await place("cash", "2026-10-28T08:00:00.000Z", "completed", otherRestaurant.id, otherItem.id, otherOwner);

    const response = await f.json(`${root}/dashboard?period=today&pageSize=2`, { cookie: owner });
    assert.equal(response.status, 200, response.text);
    const data = response.body.data;
    assert.deepEqual(data.summary, { ordersPlaced: 4, confirmedOrders: 3, completedOrders: 2, cancelledOrders: 0 });
    assert.equal(data.finance.period.grossSalesMinor, cash.totalMinor + card.totalMinor + stripe.totalMinor);
    assert.equal(data.finance.period.refundsMinor, 100);
    assert.equal(data.finance.period.commissionMinor, cash.commissionMinor + card.commissionMinor + stripe.commissionMinor - 7);
    assert.equal(data.finance.period.netEarningsMinor, cash.totalMinor + card.totalMinor + stripe.totalMinor - 100 - data.finance.period.commissionMinor);
    assert.equal(data.finance.period.cashCollectedMinor, cash.totalMinor);
    assert.equal(data.finance.period.cardSalesMinor, card.totalMinor + stripe.totalMinor);
    assert.equal(data.finance.balance.basis, "all_time"); assert.equal(data.finance.balance.bankPaidMinor, 0);
    assert.deepEqual(data.operations, { pendingConfirmation: 1, overdueConfirmation: 1, activeOrders: 2, liveOrders: 2, confirmedInKitchen: 1, readyForHandover: 0, unreadMessages: 1, openRefundCases: 1 });
    assert.equal(data.orders.items.length, 2); assert.equal(data.orders.pagination.total, 4); assert.equal(data.orders.pagination.totalPages, 2);
    const second = (await f.json(`${root}/dashboard?period=today&page=2&pageSize=2`, { cookie: owner })).body.data;
    assert.ok(data.orders.items.every(row => !second.orders.items.some(other => row.id === other.id)));
    const rows = [...data.orders.items, ...second.orders.items];
    assert.equal(rows.find(row => row.id === stripe.id).payoutState, "transferred_to_balance");
    assert.match(rows.find(row => row.id === stripe.id).payoutLabel, /Test.*Stripe balance/);
    assert.equal(rows.find(row => row.id === cash.id).payoutState, "cash_direct");
    assert.equal(rows.find(row => row.id === card.id).payoutState, "simulated");
    assert.equal((await f.json(`${root}/dashboard?period=yesterday`, { cookie: owner })).body.data.summary.ordersPlaced, 1);
    assert.equal((await f.json(`${root}/dashboard?period=this_week`, { cookie: owner })).body.data.summary.ordersPlaced, 6);
    assert.equal((await f.json(`${root}/dashboard?period=last_week`, { cookie: owner })).body.data.summary.ordersPlaced, 1);
    assert.equal((await f.json(`${root}/dashboard`, { cookie: otherOwner })).status, 404);
    assert.equal((await f.json(`${root}/dashboard`, { cookie: customer })).status, 403);
    assert.equal((await f.json(`${root}/dashboard?period=unknown`, { cookie: owner })).status, 400);
    assert.equal((await f.json(`${root}/dashboard?pageSize=1000`, { cookie: owner })).status, 400);
    const staffCreated = await f.json(`${root}/staff`, { method: "POST", cookie: owner, body: { name: "Dashboard staff", email: "dashboard-staff@example.invalid", password: "DashboardStaff!4310" } });
    assert.equal(staffCreated.status, 201, staffCreated.text);
    const staff = await f.login("dashboard-staff@example.invalid", "DashboardStaff!4310");
    const staffView = (await f.json(`${root}/dashboard`, { cookie: staff })).body.data;
    assert.equal(staffView.finance, null); assert.equal(staffView.operations.openRefundCases, null);
    assert.equal("comparison" in staffView, false); assert.equal("marketing" in staffView, false);
    for (const row of staffView.orders.items) for (const field of ["totalMinor", "refundsMinor", "commissionMinor", "netEarningsMinor", "paymentMethod", "paymentState", "payoutState", "payoutLabel", "providerMode"]) assert.equal(field in row, false);
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { await f.close(); }
});
