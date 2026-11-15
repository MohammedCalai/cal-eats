import test from "node:test";
import assert from "node:assert/strict";
import {campaignEditDraft,campaignEditPayload,campaignEditFingerprint} from "../src/campaign-edit.ts";
const now=Date.parse("2026-11-15T12:00:00Z"),campaign={title:"Lunch offer",message:"Save on lunch",startsAt:"2026-11-14T12:00:00.000Z",expiresAt:"2026-11-22T12:00:00.000Z",redemptionLimit:100,budgetMinor:10000,weeklyBudgetMinor:null};
test("campaign edits send changed supported fields only and preserve an active start/financial benefit",()=>{
 const draft=campaignEditDraft(campaign);draft.title="Updated lunch";draft.budget="120.25";
 assert.deepEqual(campaignEditPayload(draft,campaign,now),{title:"Updated lunch",budgetMinor:12025});
 assert.deepEqual(campaignEditPayload(campaignEditDraft(campaign),campaign,now),{});
 draft.startsAt="2026-11-15T13:00:00.000Z";assert.throws(()=>campaignEditPayload(draft,campaign,now),/start time.*active/);
 const legacy={...campaign,startsAt:null},legacyDraft=campaignEditDraft(legacy);legacyDraft.title="Legacy offer updated";assert.deepEqual(campaignEditPayload(legacyDraft,legacy,now),{title:"Legacy offer updated"});
});
test("ended campaigns, expired end dates and invalid limits cannot be saved",()=>{
 const draft=campaignEditDraft(campaign);draft.expiresAt="2026-11-15T11:59:00Z";assert.throws(()=>campaignEditPayload(draft,campaign,now),/end date/);
 assert.throws(()=>campaignEditPayload(campaignEditDraft({...campaign,expiresAt:"2026-11-15T10:00:00Z"}),{...campaign,expiresAt:"2026-11-15T10:00:00Z"},now),/ended/);
 for(const limit of ["0","1.5","100001"]){const value=campaignEditDraft(campaign);value.redemptionLimit=limit;assert.throws(()=>campaignEditPayload(value,campaign,now),/redemptions/);}
 const zero=campaignEditDraft(campaign);zero.weeklyBudget="0";assert.throws(()=>campaignEditPayload(zero,campaign,now),/above £0/);
 const maximum=campaignEditDraft(campaign);maximum.budget="1000000.00";assert.equal(campaignEditPayload(maximum,campaign,now).budgetMinor,100_000_000);maximum.budget="1000000.01";assert.throws(()=>campaignEditPayload(maximum,campaign,now),/too large/);
});
test("fresh campaign conflicts include budget/end-time changes without treating analytical counts as editable",()=>{
 assert.notEqual(campaignEditFingerprint(campaign),campaignEditFingerprint({...campaign,budgetMinor:15000}));
 assert.notEqual(campaignEditFingerprint(campaign),campaignEditFingerprint({...campaign,expiresAt:"2026-11-23T12:00:00Z"}));
 const extra={...campaign,recipientCount:999};assert.equal(campaignEditFingerprint(campaign),campaignEditFingerprint(extra));
});
