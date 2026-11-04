import assert from "node:assert/strict";
import test from "node:test";
import { initialScheduleChoice, reconcileScheduleChoice } from "../src/schedule-choice.ts";

test("returning from a basket edit restores the customer's scheduled choice", () => {
  const draft = { mode: "scheduled" as const, scheduledFor: "2026-11-06T18:30:00.000Z" };
  const restored = initialScheduleChoice(draft, true);
  assert.deepEqual(restored, draft);
  assert.deepEqual(reconcileScheduleChoice(restored, [draft.scheduledFor]), draft);
});

test("an expired or unavailable restored time stays in scheduled mode until the customer chooses again", () => {
  const draft = initialScheduleChoice({ mode: "scheduled", scheduledFor: "2026-11-06T18:30:00.000Z" }, true);
  assert.deepEqual(reconcileScheduleChoice(draft, ["2026-11-06T18:45:00.000Z"]), { mode: "scheduled", scheduledFor: null });
  assert.deepEqual(initialScheduleChoice({ mode: "scheduled", scheduledFor: null }, true), { mode: "scheduled", scheduledFor: null });
});

test("slot refresh cannot alter an original-order recovery target", () => {
  const original = { mode: "scheduled" as const, scheduledFor: "2026-11-06T18:30:00.000Z" };
  assert.strictEqual(reconcileScheduleChoice(original, [], true), original);
  assert.deepEqual(reconcileScheduleChoice(original, [], false), { mode: "scheduled", scheduledFor: null });
});

test("a new checkout defaults to ASAP only when open and a closed ASAP draft asks for a scheduled time", () => {
  assert.deepEqual(initialScheduleChoice(null, true), { mode: "asap", scheduledFor: null });
  assert.deepEqual(initialScheduleChoice(null, false), { mode: "scheduled", scheduledFor: null });
  assert.deepEqual(initialScheduleChoice({ mode: "asap", scheduledFor: null }, false), { mode: "scheduled", scheduledFor: null });
});
