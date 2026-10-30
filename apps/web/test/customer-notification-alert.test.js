import assert from "node:assert/strict";
import test from "node:test";
import { createCustomerNotificationAlert } from "../customer-notification-alert.js";

test("notification reminders repeat until the bell acknowledges them, without marking updates read",()=>{
  let tick,active=0,plays=0,visible=true;
  const alert=createCustomerNotificationAlert({play:()=>plays++,visible:()=>visible,setTimer:fn=>{active++;tick=fn;return 1;},clearTimer:()=>{active--;}});
  const updates=[{id:'first',readAt:null}];alert.update(updates);assert.equal(plays,1);assert.equal(active,1);
  alert.update(updates);assert.equal(active,1);tick();assert.equal(plays,2);
  visible=false;tick();assert.equal(plays,2);visible=true;
  alert.acknowledge(updates);assert.equal(active,0);assert.equal(updates[0].readAt,null);alert.update(updates);assert.equal(alert.snapshot().pending,0);
  alert.update([]);alert.update(updates);assert.equal(plays,2);assert.equal(alert.snapshot().pending,0);
  alert.update([...updates,{id:'second',readAt:null}]);assert.equal(plays,3);assert.equal(active,1);
  alert.setSound(false);tick();assert.equal(plays,3);assert.equal(alert.snapshot().pending,1);
  alert.reset();assert.equal(active,0);assert.equal(alert.snapshot().pending,0);
});
test("bell acknowledgements survive restoration, while read updates and identity teardown cannot ring",()=>{
  let plays=0,active=0;
  const alert=createCustomerNotificationAlert({play:()=>plays++,setTimer:()=>{active++;return 1;},clearTimer:()=>active--});
  alert.restoreAcknowledged(['seen']);alert.update([{id:'seen'},{id:'read',readAt:'now'}]);assert.equal(plays,0);
  alert.update([{id:'new'}]);assert.equal(plays,1);alert.dispose();assert.equal(active,0);
  alert.update([{id:'another'}]);alert.resume();assert.equal(plays,1);
});
