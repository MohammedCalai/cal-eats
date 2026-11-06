import assert from "node:assert/strict";
import test from "node:test";
import { deliveryDeadlineAt, deliveryDispatchWarning } from "../src/delivery-deadline.js";

const due = "2026-11-06T12:00:00.000Z", at = Date.parse(due);
const delivery = { fulfillment: "delivery", status: "preparing", confirmedAt: "2026-11-06T11:00:00.000Z", estimatedReadyAt: due };

test("delivery warning starts exactly fifteen minutes before ETA and continues through overdue until handover", () => {
  assert.equal(deliveryDispatchWarning(delivery, at - 15 * 60000 - 1), null);
  const boundary = deliveryDispatchWarning(delivery, at - 15 * 60000);
  assert.deepEqual(boundary, { dueAt: due, overdue: false, minutes: 15, label: "Delivery due in 15 min" });
  assert.equal(deliveryDispatchWarning(delivery, at - (14 * 60000 + 59000)).label, "Delivery due in 15 min");
  assert.equal(deliveryDispatchWarning(delivery, at - 60000).label, "Delivery due in 1 min");
  assert.equal(deliveryDispatchWarning(delivery, at).label, "Delivery due now");
  assert.equal(deliveryDispatchWarning(delivery, at).overdue, false);
  assert.equal(deliveryDispatchWarning(delivery, at + 1).label, "Delivery overdue");
  assert.equal(deliveryDispatchWarning(delivery, at + 1).overdue, true);
  assert.equal(deliveryDispatchWarning(delivery, at + 3 * 60000 + 20000).label, "Delivery overdue by 3 min");
  assert.ok(deliveryDispatchWarning(delivery, at + 24 * 3600000), "An overdue order stays visible until dispatch, without a fabricated timeout");
  assert.equal(deliveryDispatchWarning({ ...delivery, status: "out_for_delivery" }, at + 24 * 3600000), null);
});

test("only live delivery kitchen states warn; collection and terminal orders retain their ordinary styling", () => {
  for (const status of ["placed", "accepted", "preparing", "ready"]) {
    const order = { fulfillment: "delivery", status, scheduledFor: due };
    assert.ok(deliveryDispatchWarning(order, at - 5 * 60000), status);
    assert.equal(deliveryDispatchWarning({ ...order, fulfillment: "collection" }, at), null, status);
  }
  for (const status of ["out_for_delivery", "completed", "rejected", "cancelled", "expired", "unknown", null]) {
    assert.equal(deliveryDeadlineAt({ ...delivery, status }), null, String(status));
    assert.equal(deliveryDispatchWarning({ ...delivery, status }, at), null, String(status));
  }
  assert.equal(deliveryDispatchWarning(null, at), null);
});

test("deadlines use confirmed ETA then scheduled delivery and never invent an ETA from creation or restaurant estimates", () => {
  const later = "2026-11-06T13:00:00.000Z";
  assert.equal(deliveryDeadlineAt({ ...delivery, customerEtaAt: later, scheduledFor: "2026-11-06T14:00:00.000Z" }), Date.parse(later));
  assert.equal(deliveryDeadlineAt({ ...delivery, scheduledFor: later }), at, "Confirmed estimatedReadyAt takes priority over the requested schedule");
  assert.equal(deliveryDeadlineAt({ ...delivery, confirmedAt: null }), at, "Accepted/preparing/ready are also confirmed legacy states");
  assert.equal(deliveryDeadlineAt({ ...delivery, status: "placed", confirmedAt: null, scheduledFor: later }), Date.parse(later));
  assert.equal(deliveryDeadlineAt({ ...delivery, status: "placed", confirmedAt: null, scheduledFor: null }), null, "An unconfirmed estimate is not a promise");
  assert.equal(deliveryDeadlineAt({ fulfillment: "delivery", status: "placed", createdAt: due, profile: { estimatedDeliveryMinutes: 30 } }), null);
  assert.equal(deliveryDeadlineAt({ ...delivery, estimatedReadyAt: "invalid", scheduledFor: due }), at);
  for (const value of [null, "", "not-a-date", "2026-02-30T12:00:00Z", "2026-11-06T25:00:00Z", "0", 0]) {
    assert.equal(deliveryDispatchWarning({ ...delivery, estimatedReadyAt: value }, at), null, String(value));
  }
  assert.equal(deliveryDeadlineAt({ ...delivery, estimatedReadyAt: "2026-11-06T14:00:00+02:00" }), at);
  assert.equal(deliveryDispatchWarning(delivery, new Date(at)).label, "Delivery due now");
  for (const value of [NaN, Infinity, "2026-11-06T12:00:00Z", new Date("invalid")]) assert.equal(deliveryDispatchWarning(delivery, value), null);
});
