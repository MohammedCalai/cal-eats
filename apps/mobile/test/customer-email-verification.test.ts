import assert from "node:assert/strict";
import test from "node:test";
import { parseCustomerEmailVerification, verificationCooldownSeconds } from "../src/customer-email-verification.ts";

const pending={email:"customer+fixture@example.invalid",emailVerified:false,verificationRequired:true,canOrder:false,resendAvailableAt:"2026-11-08T12:01:00.000Z",delivery:"email"};
test("new customer verification gates ordering while grandfathered and verified accounts remain orderable",()=>{
  assert.equal(parseCustomerEmailVerification(pending).canOrder,false);
  assert.equal(parseCustomerEmailVerification({...pending,verificationRequired:false,canOrder:true}).canOrder,true);
  assert.equal(parseCustomerEmailVerification({...pending,emailVerified:true,verificationRequired:false,canOrder:true}).emailVerified,true);
  assert.throws(()=>parseCustomerEmailVerification({...pending,canOrder:true}),/could not be verified/);
  assert.throws(()=>parseCustomerEmailVerification({...pending,delivery:"success"}),/could not be verified/);
  assert.throws(()=>parseCustomerEmailVerification({...pending,resendAvailableAt:"soon"}),/could not be verified/);
});
test("resend countdown uses the server deadline, rounds remaining seconds up and ends at zero",()=>{
  const status=parseCustomerEmailVerification(pending);
  assert.equal(verificationCooldownSeconds(status,Date.parse("2026-11-08T12:00:00.000Z")),60);
  assert.equal(verificationCooldownSeconds(status,Date.parse("2026-11-08T12:00:59.500Z")),1);
  assert.equal(verificationCooldownSeconds(status,Date.parse("2026-11-08T12:01:00.000Z")),0);
  assert.equal(verificationCooldownSeconds(status,Date.parse("2026-11-08T12:05:00.000Z")),0);
  assert.equal(verificationCooldownSeconds(null),0);
});
