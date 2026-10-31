import test from "node:test";
import assert from "node:assert/strict";
import { beginDashboardRefresh, beginActiveOrderRefresh } from "../src/dashboard-refresh-state.js";

test("same-period polling keeps the displayed dashboard and reconnect error unchanged", () => {
  const data = { operations: { liveOrders: 3 } };
  for (const error of ["", "Connection interrupted"]) {
    const previous = { key: "r1:today:1", data, loading: false, error };
    assert.equal(beginDashboardRefresh(previous, previous.key), previous);
  }
});

test("changing restaurant, period or page clears the preceding dashboard", () => {
  const previous = { key: "r1:today:1", data: { secret: "prior scope" }, loading: false, error: "Prior error" };
  for (const key of ["r2:today:1", "r1:yesterday:1", "r1:today:2"]) {
    assert.deepEqual(beginDashboardRefresh(previous, key), { key, data: null, loading: true, error: "" });
  }
});

test("active polling keeps empty results, rows and error-based action gates stable", () => {
  for (const items of [[], [{ id: "order1", status: "accepted" }]]) {
    for (const error of ["", "Orders could not be refreshed"]) {
      const previous = { restaurantId: "r1", items, total: items.length, loading: false, error };
      assert.equal(beginActiveOrderRefresh(previous, "r1"), previous);
    }
  }
});

test("switching restaurants clears active rows and former error before loading", () => {
  const previous = { restaurantId: "r1", items: [{ id: "private-order" }], total: 1, loading: false, error: "Old error" };
  assert.deepEqual(beginActiveOrderRefresh(previous, "r2"), { restaurantId: "r2", items: [], total: 0, loading: true, error: "" });
});
