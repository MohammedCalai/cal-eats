import assert from "node:assert/strict";
import test from "node:test";
import { assertStripePaymentBinding } from "../src/payments/stripe-connect.js";

test("Stripe payment binding rejects mismatched provider facts",()=>{
  const order={id:"order-1",restaurant_id:"restaurant-1",total_minor:1299,currency:"GBP"},payment={payment_intent_id:"pi_exact"};
  const valid={orderId:"order-1",restaurantId:"restaurant-1",amountMinor:1299,currency:"gbp",captureMethod:"manual",paymentIntentId:"pi_exact"};
  assert.equal(assertStripePaymentBinding(valid,{order,payment}),valid);
  assert.throws(()=>assertStripePaymentBinding({...valid,amountMinor:1300},{order,payment}),/does not match/);
});
