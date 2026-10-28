import test from "node:test";
import assert from "node:assert/strict";
import { etaTimestamp, nextOrderAction, orderEtaLabel, orderSoundAllowed, pendingOrderQueue, type BusinessOrder } from "../src/orders-model.ts";

test("confirmation estimates distinguish customer arrival from collection readiness and stay bounded", () => {
  assert.equal(orderEtaLabel({ fulfillment: "delivery" }), "Customer arrival estimate");
  assert.equal(orderEtaLabel({ fulfillment: "collection" }), "Ready for collection estimate");
  assert.equal(etaTimestamp("45", new Date("2026-10-28T12:00:00.000Z")), "2026-10-28T12:45:00.000Z");
  for (const value of ["0", "-1", "1441", "20.5", "soon"]) assert.throws(() => etaTimestamp(value));
});
test("collection orders never expose a delivery-driver progression", () => {
  assert.deepEqual(nextOrderAction({ status: "ready", fulfillment: "collection" }), { status: "completed", label: "Mark collected" });
  assert.equal(nextOrderAction({ status: "ready", fulfillment: "delivery" })?.status, "out_for_delivery");
  assert.equal(nextOrderAction({ status: "out_for_delivery", fulfillment: "delivery" })?.status, "completed");
  assert.equal(nextOrderAction({ status: "placed", fulfillment: "delivery" }), null);
  assert.equal(nextOrderAction({ status: "completed", fulfillment: "delivery" }), null);
});
test("global alerts retain only pending server records and stop sound on every lifecycle gate", () => {
  const order = (id: string, status: string, minute: string) => ({ id, status, confirmationDueAt: `2026-10-28T12:${minute}:00.000Z` }) as BusinessOrder;
  assert.deepEqual(pendingOrderQueue([order("later", "placed", "20"), order("confirmed", "accepted", "00"), order("first", "placed", "10"), order("first", "placed", "10")]).map(item => item.id), ["first", "later"]);
  const active = { signedIn: true, foreground: true, enabled: true, verified: true, pendingCount: 1 };
  assert.equal(orderSoundAllowed(active), true);
  for (const gate of ["signedIn", "foreground", "enabled", "verified"] as const) assert.equal(orderSoundAllowed({ ...active, [gate]: false }), false);
  assert.equal(orderSoundAllowed({ ...active, pendingCount: 0 }), false);
});
