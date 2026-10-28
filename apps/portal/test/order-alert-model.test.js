import test from "node:test";
import assert from "node:assert/strict";
import { businessOrderTransitions, confirmationPayload, customerEtaLabel, orderEtaDefaultMinutes, orderIsOverdue, orderSoundPath, pendingOrdersForRestaurant, pendingOrdersFromAuthoritativeQueue } from "../src/order-alert-model.js";

test("pending alerts exclude another restaurant and unverified card checkouts",()=>{
  const base={id:"new",restaurantId:"ours",status:"placed",fulfillment:"delivery",merchantVisibleAt:"2026-10-28T12:00:00Z",paymentMethod:"cash"};
  const result=pendingOrdersForRestaurant([base,{...base,id:"other",restaurantId:"other"},{...base,id:"unpaid",paymentMethod:"card",paymentStatus:"stripe_pending"},{...base,id:"card",paymentMethod:"card",paymentStatus:"stripe_authorized",merchantVisibleAt:"2026-10-28T11:59:00Z"},{...base,id:"done",status:"accepted"}],"ours");
  assert.deepEqual(result.map(item=>item.id),["card","new"]);
});

test("the authenticated global queue retains pending orders from every own membership",()=>{
  const orders=[{id:"one",restaurantId:"first-membership",status:"placed",paymentMethod:"cash",merchantVisibleAt:"2026-10-28T12:00:00Z"},{id:"two",restaurantId:"second-membership",status:"placed",paymentMethod:"cash",merchantVisibleAt:"2026-10-28T11:59:00Z"}];
  assert.deepEqual(pendingOrdersFromAuthoritativeQueue(orders).map(order=>order.id),["two","one"]);
  assert.equal(orderEtaDefaultMinutes({...orders[1],defaultCustomerEtaMinutes:55},{profile:{estimatedDeliveryMinutes:10,estimatedCollectionMinutes:10}}),55);
});

test("only a merchant-visible overdue clock changes the exact Calai ringtone",()=>{
  const now=Date.parse("2026-10-28T12:03:00Z"),order={createdAt:"2026-10-27T10:00:00Z",confirmationDueAt:"2026-10-28T12:03:01Z"};
  assert.equal(orderIsOverdue(order,now),false);
  assert.equal(orderSoundPath([order],now),"/business/notification.wav");
  assert.equal(orderSoundPath([order],now+1000),"/business/unconfirmed-notification.wav");
  assert.equal(orderIsOverdue({createdAt:order.createdAt},now),false);
  assert.equal(orderSoundPath([],now),null);
});

test("confirmation uses an explicit valid customer ETA for delivery or collection",()=>{
  const now=Date.parse("2026-10-28T12:00:00Z");
  assert.deepEqual(confirmationPayload("30",now),{status:"accepted",estimatedReadyAt:"2026-10-28T12:30:00.000Z"});
  for(const value of [0,-1,1.5,"",1441,"bad"])assert.throws(()=>confirmationPayload(value,now),/ETA/);
  assert.equal(customerEtaLabel({fulfillment:"delivery"}),"Expected delivery arrival");
  assert.equal(customerEtaLabel({fulfillment:"collection"}),"Ready for collection");
  assert.equal(orderEtaDefaultMinutes({defaultCustomerEtaMinutes:37},{profile:{estimatedDeliveryMinutes:20}}),37);
});

test("delivery advances through out-for-delivery while collection completes at ready",()=>{
  assert.deepEqual(businessOrderTransitions("placed","delivery"),["accepted"]);
  assert.deepEqual(businessOrderTransitions("ready","delivery"),["out_for_delivery"]);
  assert.deepEqual(businessOrderTransitions("out_for_delivery","delivery"),["completed"]);
  assert.deepEqual(businessOrderTransitions("ready","collection"),["completed"]);
});
