import test from "node:test";
import assert from "node:assert/strict";
import { createStripeAdapter,STRIPE_API_VERSION } from "../src/payments/stripe-test.js";
import { loadLiveOnboardingConfig } from "../src/payments/live-onboarding.js";

function adapterFor(schedule,{httpStatus=200,body}={}){
  const calls=[],adapter=createStripeAdapter({secretKey:"rk_test_schedule_fixture",mode:"test",fetchImpl:async(url,init)=>{
    calls.push({url:new URL(url),method:init.method,headers:init.headers,body:init.body});
    return new Response(JSON.stringify(body??{object:"balance_settings",payouts:{schedule}}),{status:httpStatus,headers:{"content-type":"application/json"}});
  }});
  return {adapter,calls};
}

test("authoritative Basil readback reports weekly, changed daily/manual/monthly schedules without writing provider settings",async()=>{
  for(const [input,expected]of [
    [{interval:"weekly",weekly_payout_days:["monday"]},{interval:"weekly",weeklyPayoutDays:["monday"],weeklyAnchor:"monday"}],
    [{interval:"weekly",weekly_payout_days:["wednesday","friday"]},{interval:"weekly",weeklyPayoutDays:["wednesday","friday"]}],
    [{interval:"daily"},{interval:"daily",weeklyPayoutDays:[]}],
    [{interval:"manual"},{interval:"manual",weeklyPayoutDays:[]}],
    [{interval:"monthly",monthly_payout_days:[1,15]},{interval:"monthly",weeklyPayoutDays:[],monthlyPayoutDays:[1,15]}]
  ]){
    const {adapter,calls}=adapterFor(input),result=await adapter.retrievePayoutSchedule({accountId:"acct_connected"});
    assert.equal(result.ok,true);assert.equal(result.status,"confirmed");assert.equal(result.providerReference,"acct_connected");assert.deepEqual(result.payoutSchedule,expected);
    assert.equal(calls.length,1);assert.equal(calls[0].method,"GET");assert.equal(calls[0].url.origin,"https://api.stripe.com");assert.equal(calls[0].url.pathname,"/v1/balance_settings");assert.equal(calls[0].headers["Stripe-Account"],"acct_connected");assert.equal(calls[0].headers["Stripe-Version"],STRIPE_API_VERSION);assert.equal(STRIPE_API_VERSION,"2025-06-30.basil");assert.equal(calls[0].body,undefined);
    if(input.interval!=="weekly")assert.equal(result.payoutSchedule.weeklyAnchor,undefined);
  }
});

test("permission denial or malformed readback remains unverified and never invents weekly Monday",async()=>{
  const denied=adapterFor(null,{httpStatus:403,body:{error:{code:"permission_denied",message:"private provider internals must not leak"}}});
  const rejected=await denied.adapter.retrievePayoutSchedule({accountId:"acct_connected"});assert.equal(rejected.ok,false);assert.equal(rejected.payoutSchedule,undefined);assert.equal(JSON.stringify(rejected).includes("private provider"),false);
  for(const raw of [null,{}, {interval:"weekly"},{interval:"weekly",weekly_payout_days:["monday","monday"]},{interval:"weekly",weekly_payout_days:["unknown"]},{interval:"monthly",monthly_payout_days:[32]},{interval:"monthly"},{interval:"unexpected"}]){
    const {adapter}=adapterFor(raw),result=await adapter.retrievePayoutSchedule({accountId:"acct_connected"});assert.equal(result.ok,false);assert.equal(result.payoutSchedule,undefined);assert.equal(result.errorCode,"STRIPE_PAYOUT_SCHEDULE_UNAVAILABLE");
  }
});

test("onboarding-only access includes schedule readback without exposing customer charge or transfer methods",()=>{
  const provider={mode:"stripe_live",retrievePlatformAccount:async()=>{},retrievePayoutSchedule:async()=>{},createTransfer:async()=>{},capturePayment:async()=>{}},config=loadLiveOnboardingConfig({liveOnboardingRestaurantIds:["027d8cb9-f2ee-4aab-b893-1b1e2997c367"],liveOnboardingStripePlatformAccountId:"acct_platform",liveOnboardingStripeSecretKey:"rk_live_fixture_only",liveOnboardingWebhookSecret:"whsec_fixture_platform",liveOnboardingConnectWebhookSecret:"whsec_fixture_connect",liveOnboardingPaymentProvider:provider},{runMode:"hosted-preview",nodeEnv:"production",origin:"https://eats.example.test"});
  assert.equal(typeof config.connection.paymentProvider.retrievePayoutSchedule,"function");assert.equal(config.connection.paymentProvider.createTransfer,undefined);assert.equal(config.connection.paymentProvider.capturePayment,undefined);assert.equal(config.connection.livePaymentsEnabled,false);
});
