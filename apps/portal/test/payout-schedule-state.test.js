import test from "node:test";
import assert from "node:assert/strict";
import { describePayoutSchedule,payoutScheduleState } from "../src/payout-schedule-state.js";

const verified=payoutSchedule=>({plannedPayoutSchedule:{interval:"weekly",weeklyAnchor:"monday"},payoutScheduleStatus:"verified",payoutScheduleVerifiedAt:"2026-11-08T12:00:00.000Z",payoutSchedule});
test("verified actual schedules stay distinct from the weekly Monday plan",()=>{
  const monday=payoutScheduleState(verified({interval:"weekly",weeklyPayoutDays:["monday"]}));assert.equal(monday.plan,"Weekly on Monday");assert.equal(monday.actual,"Weekly on Monday");assert.equal(monday.verified,true);assert.equal(monday.mismatch,false);
  for(const [schedule,expected]of [[{interval:"daily"},"Daily"],[{interval:"manual"},"Manual bank payouts"],[{interval:"weekly",weeklyPayoutDays:["wednesday","friday"]},"Weekly on Wednesday and Friday"],[{interval:"monthly",monthlyPayoutDays:[1,15]},"Monthly on days 1 and 15"]]){
    const state=payoutScheduleState(verified(schedule));assert.equal(state.actual,expected);assert.equal(state.mismatch,true);assert.equal(state.plan,"Weekly on Monday");
  }
});
test("missing permission, missing readback or an old static schedule cannot be labelled verified",()=>{
  for(const value of [null,{payoutSchedule:{interval:"weekly",weeklyAnchor:"monday"}},{...verified({interval:"weekly"})},{...verified({interval:"weekly",weeklyAnchor:"monday"}),payoutScheduleStatus:"unverified"},{...verified({interval:"daily"}),payoutScheduleVerifiedAt:null}]){
    const state=payoutScheduleState(value);assert.equal(state.verified,false);assert.equal(state.actual,null);assert.equal(state.mismatch,false);assert.equal(state.plan,"Weekly on Monday");
  }
  assert.equal(describePayoutSchedule({interval:"weekly"}),null);
  assert.equal(payoutScheduleState({payoutScheduleStatus:"unverified",payoutScheduleMessage:"Current payout settings are unavailable."}).message,"Current payout settings are unavailable.");
});
