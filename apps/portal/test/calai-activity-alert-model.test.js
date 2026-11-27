import test from "node:test";
import assert from "node:assert/strict";
import { observeCalaiActivity } from "../src/calai-activity-alert-model.js";

const businessId = "arndale";
const started = Date.parse("2026-11-27T12:00:00Z");
const at = ms => new Date(started + ms).toISOString();
const event = (key, ms) => ({ key: key.repeat(64), at: at(ms) });
const snapshot = (ms, ...events) => ({ generatedAt: at(ms), events });
const observe = (previous, calls = null, phoneOrders = null) => observeCalaiActivity(previous, { businessId, calls, phoneOrders }, businessId);

test("Calai activity shows existing calls silently and chimes for distinct later activity once", () => {
  const baseline = observe(null, snapshot(0, event("a", -1_000)), snapshot(0, event("b", -55_000)));
  assert.deepEqual([baseline.currentCalls, baseline.newCalls, baseline.newOrders], [1, 0, 0]);

  const calls = snapshot(5_000, event("a", -1_000), event("c", 2_000), event("c", 2_000));
  const seen = observe(baseline.state, calls, snapshot(30_000, event("b", -55_000), event("d", 24_000)));
  assert.deepEqual([seen.currentCalls, seen.newCalls, seen.newOrders], [2, 1, 1]);

  const repeated = observe(seen.state, calls, snapshot(35_000, event("d", 24_000)));
  assert.deepEqual([repeated.currentCalls, repeated.newCalls, repeated.newOrders], [2, 0, 0]);
  const ended = observe(repeated.state, snapshot(10_000));
  assert.equal(ended.currentCalls, 0);
});

test("Calai activity baselines each source independently and ignores unrelated, invalid and old observations", () => {
  const baseline = observe(null, snapshot(0));
  const unauthorised = observeCalaiActivity(baseline.state, { businessId: "another", calls: snapshot(5_000, event("a", 3_000)) }, businessId);
  assert.deepEqual([unauthorised.currentCalls, unauthorised.newCalls], [0, 0]);
  assert.equal(unauthorised.state.calls, baseline.state.calls);

  const afterError = observe(unauthorised.state, snapshot(130_000, event("a", 1_000), event("z", 125_000), event("b", 140_000)), snapshot(130_000, event("c", 128_000)));
  assert.equal(afterError.newCalls, 0, "An old active call or malformed observation cannot chime");
  assert.equal(afterError.currentCalls, 1, "An older genuine call may remain active");
  assert.equal(afterError.newOrders, 0, "First successful order snapshot sets its own baseline");

  const outOfOrder = observe(afterError.state, snapshot(125_000, event("d", 124_000)), snapshot(160_000, event("e", 155_000)));
  assert.equal(outOfOrder.newCalls, 0);
  assert.equal(outOfOrder.newOrders, 1);
});
