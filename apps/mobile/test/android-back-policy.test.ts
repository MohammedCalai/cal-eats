import assert from "node:assert/strict";
import test from "node:test";
import { createAndroidBackStack, requestBackNavigation } from "../src/android-back-policy.ts";

test("Android Back closes the nested conversation before its order and releases removed screens", () => {
  const stack = createAndroidBackStack(), actions: string[] = [];
  stack.register(() => { actions.push("order"); return true; }, 10);
  const remove = stack.register(() => { actions.push("conversation"); return true; }, 30);
  // A parent effect registered later must not take priority over the child.
  stack.register(() => false, 0);
  assert.equal(stack.dispatch(), true); assert.deepEqual(actions, ["conversation"]);
  remove(); stack.dispatch(); assert.deepEqual(actions, ["conversation", "order"]);
  assert.equal(createAndroidBackStack().dispatch(), false);
});

test("in-flight work consumes Back and unsaved edits wait for explicit discard", () => {
  let closed = 0, confirm: (() => void) | undefined;
  const options = { close: () => { closed++; }, confirmDiscard: (close: () => void) => { confirm = close; } };
  assert.equal(requestBackNavigation({ ...options, blocked: true, dirty: true }), true);
  assert.equal(closed, 0); assert.equal(confirm, undefined);
  requestBackNavigation({ ...options, blocked: false, dirty: true });
  assert.equal(closed, 0); confirm?.(); assert.equal(closed, 1);
  requestBackNavigation({ ...options, blocked: false, dirty: false }); assert.equal(closed, 2);
});
