import assert from "node:assert/strict";
import test from "node:test";
import { customerOrdersListHtml } from "../customer-order-list.js";

const now = Date.parse("2026-10-30T12:00:00.000Z");
const order = (id, status, extra = {}) => ({ id, status, restaurantName: "Blue Kitchen", fulfillment: "delivery", paymentMethod: "card", paymentStatus: "stripe_captured", totalMinor: 1050, createdAt: "2026-10-30T10:00:00.000Z", updatedAt: "2026-10-30T11:00:00.000Z", ...extra });

test("overview groups actual live and past orders, keeps selection and never invents unread indicators", () => {
  const html = customerOrdersListHtml([order("past-1", "completed"), order("live-1", "preparing", { confirmedAt: "2026-10-30T10:10:00.000Z", customerEtaAt: "2026-10-30T12:30:00.000Z" })], { selectedId: "live-1", now });
  assert.ok(html.indexOf('aria-label="Live orders"') < html.indexOf('aria-label="Past orders"'));
  assert.ok(html.includes("Preparing your food")); assert.ok(html.includes("Delivered")); assert.ok(html.includes("ETA 12:30"));
  assert.ok(html.includes('data-action="open-customer-order" data-id="live-1" aria-current="true"'));
  assert.ok(html.includes('data-order-id="live-1"')); assert.ok(html.includes("£10.50"));
  assert.equal(html.includes('class="customer-order-unread"'), false); assert.equal(html.includes("unread messages"), false);
});

test("unpaid cards are not presented as restaurant-confirmed and collection completion stays distinct", () => {
  const html = customerOrdersListHtml([order("unpaid", "placed", { paymentStatus: "stripe_pending", payment: { status: "pending", checkoutAvailable: true } }), order("collected", "completed", { fulfillment: "collection", unreadMessageCount: 3 })], { now });
  assert.ok(html.includes("Complete your payment")); assert.equal(html.includes("Order confirmed"), false); assert.ok(html.includes("Collected")); assert.ok(html.includes("3 unread messages"));
  assert.equal(html.includes("ETA"), false);
});

test("hostile restaurant names and identifiers are escaped and activity dates are not fabricated", () => {
  const html = customerOrdersListHtml([order('id" onclick="unsafe', "rejected", { restaurantName: "<img src=x onerror=bad>", createdAt: "invalid", updatedAt: "invalid", totalMinor: null })], { now });
  assert.equal(html.includes("<img src=x"), false); assert.ok(html.includes("&lt;img src=x onerror=bad&gt;"));
  assert.ok(html.includes('data-id="id&quot; onclick=&quot;unsafe"')); assert.equal(html.includes("<time"), false); assert.ok(html.includes("Total unavailable"));
  assert.ok(customerOrdersListHtml([], { now }).includes("Browse restaurants"));
});
