import test from "node:test";
import assert from "node:assert/strict";
import { canMuteOrderSound, pendingOrderSoundRequired } from "../../../packages/contracts/src/order-alert-policy.js";

test("pending orders cannot be muted and one confirmation cannot silence another waiting order", () => {
  const state={signedIn:true,unlocked:true,pendingCount:2};
  assert.equal(pendingOrderSoundRequired(state),true);
  assert.equal(canMuteOrderSound(2),false);
  assert.equal(pendingOrderSoundRequired({...state,pendingCount:1}),true);
  assert.equal(canMuteOrderSound(1),false);
  assert.equal(pendingOrderSoundRequired({...state,pendingCount:0}),false);
  assert.equal(canMuteOrderSound(0),true);
  for(const gate of ["signedIn","unlocked","active","verified"]) assert.equal(pendingOrderSoundRequired({...state,[gate]:false}),false);
});
