import test from "node:test";
import assert from "node:assert/strict";
import {bankPayoutScheduleCopy,businessFinanceCopy,businessSettlementLabel} from "../src/finance-copy.ts";

test("restaurant payout labels explain earnings without the provider brand or claiming a bank deposit",()=>{
 for(const label of ["Transferred to Stripe balance","Transferred to connected Stripe balance","Transferred to Stripebalance"]){assert.equal(businessFinanceCopy(label),"Awaiting weekly payout");}
 assert.equal(businessFinanceCopy("Stripe balance"),"earnings awaiting payout");
 assert.equal(businessFinanceCopy("Stripe's payout account"),"the payment service payout account");
 assert.equal(businessFinanceCopy("Awaiting order completion"),"Awaiting order completion");
 assert.equal(businessSettlementLabel({state:"transferred_to_balance",label:"Transferred to Stripe balance"}),"Awaiting weekly payout");
});
test("weekly schedules show the actual reported days, with no inferred Monday",()=>{
 assert.equal(bankPayoutScheduleCopy({interval:"weekly",weeklyPayoutDays:["tuesday","friday"],weeklyAnchor:"monday"},"verified"),"Weekly on Tuesday and Friday");
 assert.equal(bankPayoutScheduleCopy({interval:"weekly",weeklyPayoutDays:["tuesday","thursday","saturday"]},"verified"),"Weekly on Tuesday, Thursday and Saturday");
 assert.equal(bankPayoutScheduleCopy({interval:"weekly",weeklyAnchor:"wednesday"},"verified"),"Weekly on Wednesday");
 assert.equal(bankPayoutScheduleCopy({interval:"weekly"},"verified"),"Weekly · day not confirmed");
 assert.equal(bankPayoutScheduleCopy({interval:"weekly",weeklyPayoutDays:["unexpected"],weeklyAnchor:"monday"},"verified"),"Weekly · day not confirmed");
});
test("unverified or missing schedules stay unconfirmed even when a policy/default day is present",()=>{
 assert.equal(bankPayoutScheduleCopy({interval:"weekly",weeklyAnchor:"monday"},"unverified"),"Schedule not confirmed");
 assert.equal(bankPayoutScheduleCopy({interval:"weekly",weeklyAnchor:"monday"}),"Schedule not confirmed");
 assert.equal(bankPayoutScheduleCopy(null,"verified"),"Schedule not confirmed");
 assert.equal(bankPayoutScheduleCopy({interval:"manual"},"verified"),"Manual payouts");
});
