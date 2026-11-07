import assert from "node:assert/strict";
import test from "node:test";
import { createCustomerNotificationAlert, shouldShowCustomerNotificationPrompt } from "../customer-notification-alert.js";

test("customer reminders stay silent and do not restack on polling; dismissing keeps underlying updates unread",()=>{
  let sounds=0,timers=0,changes=0;
  const alert=createCustomerNotificationAlert({onChange:()=>changes++,play:()=>sounds++,setTimer:()=>timers++});
  const updates=[{id:"first",readAt:null}];
  alert.update(updates);assert.equal(alert.snapshot().pending,1);assert.equal(changes,1);
  alert.update(updates);alert.update([{...updates[0]}]);assert.equal(changes,1);
  assert.equal(sounds,0);assert.equal(timers,0);assert.equal(alert.setSound,undefined);
  alert.acknowledge(updates);assert.equal(alert.snapshot().pending,0);assert.equal(updates[0].readAt,null);
  alert.update(updates);assert.equal(alert.snapshot().pending,0);
  alert.update([...updates,{id:"second",readAt:null}]);assert.equal(alert.snapshot().pending,1);
  alert.dispose();alert.update([{id:"third"}]);assert.equal(alert.snapshot().pending,0);assert.equal(sounds,0);
});
test("local dismissal restoration, read updates and identity reset keep reminders scoped",()=>{
  const alert=createCustomerNotificationAlert();
  alert.restoreAcknowledged(["seen"]);alert.update([{id:"seen"},{id:"read",readAt:"now"}]);assert.equal(alert.snapshot().pending,0);
  alert.update([{id:"new"}]);alert.acknowledge();const saved=alert.acknowledgedIds();
  alert.reset();alert.restoreAcknowledged(saved);alert.update([{id:"new"}]);assert.equal(alert.snapshot().pending,0);
  alert.reset();alert.update([{id:"new"}]);assert.equal(alert.snapshot().pending,1);
});

test("unread reminder never interrupts chats, checkout, a modal or an inactive/other-role screen",()=>{
  const ready={customer:true,pending:2,view:"discover"};
  assert.equal(shouldShowCustomerNotificationPrompt(ready),true);
  for(const view of ["messages","checkout","basket"])assert.equal(shouldShowCustomerNotificationPrompt({...ready,view}),false,view);
  for(const blocked of [{busy:true},{hidden:true},{hasDialog:true},{customer:false},{pending:0}])assert.equal(shouldShowCustomerNotificationPrompt({...ready,...blocked}),false);
  assert.equal(shouldShowCustomerNotificationPrompt({...ready,view:"orders"}),true);
});
