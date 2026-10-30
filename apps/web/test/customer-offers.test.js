import assert from "node:assert/strict";
import test from "node:test";
import { customerOffersHtml } from "../customer-offers.js";

const now = Date.parse("2026-10-30T12:00:00Z");
const offer = (id, extra = {}) => ({ id, restaurantName: "Blue Kitchen", title: "A thank you for you", message: "Enjoy your next meal.", offerType: "percent_off", value: 2000, minSubtotalMinor: 1500, startsAt: "2026-10-29T12:00:00Z", expiresAt: "2026-11-01T17:30:00Z", status: "available", ...extra });

test("direct personal grants appear first; public, segmented and unknown grants stay neutral", () => {
  const html = customerOffersHtml([offer("public", { recipientSegment: "first_order" }), offer("regular", { recipientSegment: "regular" }), offer("unknown"), offer("personal-later", { recipientSegment: "selected", expiresAt: "2026-11-02T17:30:00Z" }), offer("personal-soon", { recipientSegment: "selected" })], { now });
  assert.ok(html.indexOf('aria-label="Personalised for you"') < html.indexOf('aria-label="Restaurant offers"'));
  const personal = html.slice(html.indexOf('aria-label="Personalised for you"'), html.indexOf('aria-label="Restaurant offers"'));
  assert.ok(personal.includes('data-id="personal-soon"')); assert.ok(personal.includes('data-id="personal-later"'));
  assert.equal(personal.includes('data-id="public"'), false); assert.equal(personal.includes('data-id="regular"'), false); assert.equal(personal.includes('data-id="unknown"'), false);
  assert.ok(personal.indexOf('data-id="personal-soon"') < personal.indexOf('data-id="personal-later"'));
  assert.ok(html.includes("20% off")); assert.ok(html.includes("Min. £15.00 food spend"));
});

test("exact end/start times use London and only current available grants are actionable", () => {
  const html = customerOffersHtml([offer("current"), offer("elapsed", { expiresAt: "2026-10-30T12:00:00Z" }), offer("future", { startsAt: "2026-10-31T09:00:00Z" }), offer("used", { status: "redeemed" }), offer("reserved", { status: "reserved" }), offer("missing-date", { expiresAt: "invalid" })], { now });
  assert.equal((html.match(/data-action="choose-offer"/g) || []).length, 1);
  assert.ok(html.includes('data-id="current"')); assert.ok(html.includes("1 Nov 2026, 17:30 GMT"));
  assert.ok(html.includes("Starts <time datetime=\"2026-10-31T09:00:00.000Z\">31 Oct 2026, 09:00 GMT"));
  assert.ok(html.includes("Ended <time")); assert.ok(html.includes("Expired")); assert.ok(html.includes("Coming soon")); assert.ok(html.includes("Used")); assert.ok(html.includes("In an order")); assert.ok(html.includes("End date unavailable"));
  const summer = customerOffersHtml([offer("summer", { startsAt: "2026-06-01T00:00:00Z", expiresAt: "2026-06-02T17:30:00Z" })], { now: "2026-06-01T12:00:00Z" });
  assert.ok(summer.includes("2 Jun 2026, 18:30 BST"));
});

test("restaurant copy and identifiers are escaped and missing values never invent a benefit", () => {
  const html = customerOffersHtml([offer('id" onclick="bad', { restaurantName: "<img src=x>", title: "<script>bad</script>", message: "<a href=bad>offer</a>", offerType: "mystery", value: null, minSubtotalMinor: null })], { now });
  assert.equal(html.includes("<script>"), false); assert.equal(html.includes("<img src=x>"), false); assert.equal(html.includes("<a href=bad>"), false);
  assert.ok(html.includes('data-id="id&quot; onclick=&quot;bad"')); assert.ok(html.includes("&lt;script&gt;bad&lt;/script&gt;"));
  assert.ok(html.includes("Check minimum food spend")); assert.equal(html.includes("NaN"), false); assert.equal(html.includes("Free undefined"), false);
  assert.ok(customerOffersHtml([], { now }).includes("No offers to show"));
});
