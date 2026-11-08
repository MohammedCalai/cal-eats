import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { loadConfig } from "../src/config.js";
import { loadLiveOnboardingConfig } from "../src/payments/live-onboarding.js";
import { routeStripeConnect,runStripeConnectWorker } from "../src/payments/stripe-connect.js";
import { scopedAdminRestaurantSession } from "../src/auth/admin-restaurant-scope.js";
import { journeyFixture } from "./helpers.js";

const hosting={runMode:"hosted-preview",nodeEnv:"production",origin:"https://eats.example.test"};
const staged={liveOnboardingStripePlatformAccountId:"acct_liveplatform",liveOnboardingStripeSecretKey:"rk_live_fixture_only",liveOnboardingWebhookSecret:"whsec_live_platform_fixture",liveOnboardingConnectWebhookSecret:"whsec_live_connect_fixture"};
const scopeId="027d8cb9-f2ee-4aab-b893-1b1e2997c367";

function adapter(mode,calls){
  const accountId=mode==="stripe_live"?"acct_liverestaurant":"acct_testrestaurant";
  const ready=()=>({status:"confirmed",providerReference:accountId,chargesEnabled:true,payoutsEnabled:true,capabilities:["card_payments","transfers"],requirements:[]});
  const record=(name,result)=>async input=>{calls.push({name,input,mode});return typeof result==="function"?result(input):result;};
  return {mode,
    retrievePlatformAccount:record("platform",{status:"confirmed",providerReference:mode==="stripe_live"?"acct_liveplatform":"acct_testplatform",mode}),
    createConnectedAccount:record("createAccount",{...ready(),status:"pending",chargesEnabled:false,payoutsEnabled:false}),
    configureWeeklyPayouts:record("schedule",{status:"confirmed"}),
    createAccountLink:record("onboardingLink",{status:"confirmed",actionUrl:`https://connect.stripe.com/setup/s/${accountId}`}),
    refreshConnectedAccount:record("refresh",ready),
    createAccountLoginLink:record("dashboard",{status:"confirmed",actionUrl:`https://connect.stripe.com/express/${accountId}`}),
    listExternalBankAccounts:record("banks",{status:"confirmed",providerReference:accountId,items:[{id:"ba_fixture",last4:"1234",country:"GB",currency:"GBP"}]}),
    listPayouts:record("payouts",{items:[],hasMore:false}),
    // Financial methods must never be included in the scoped provider.
    createCheckoutSession:record("checkout",{}),createTransfer:record("transfer",{}),capturePayment:record("capture",{})};
}

async function setup(){
  const testCalls=[],liveCalls=[],testProvider=adapter("stripe_test",testCalls),liveProvider=adapter("stripe_live",liveCalls);
  const f=await journeyFixture({paymentProviderMode:"stripe_test",paymentProvider:testProvider,stripePlatformAccountId:"acct_testplatform",paymentProviderWebhookSecret:"whsec_test_platform_fixture",paymentProviderConnectWebhookSecret:"whsec_test_connect_fixture",liveOnboardingRestaurantIds:[]});
  const selected=f.db.prepare("SELECT * FROM restaurants WHERE name='Calai Kitchen'").get(),other=f.db.prepare("SELECT * FROM restaurants WHERE name='Second Spoon'").get();
  const session=email=>({user:f.db.prepare("SELECT * FROM users WHERE email=?").get(email)});
  const owner=session("restaurant@calai.local"),otherOwner=session("restaurant2@calai.local"),customer=session("customer@calai.local"),admin=session("admin@calai.local");
  const config=loadConfig({...hosting,paymentProviderMode:"stripe_test",paymentProvider:testProvider,stripePlatformAccountId:"acct_testplatform",paymentProviderWebhookSecret:"whsec_test_platform_fixture",paymentProviderConnectWebhookSecret:"whsec_test_connect_fixture",livePaymentsEnabled:false,...staged,liveOnboardingRestaurantIds:[selected.id],liveOnboardingPaymentProvider:liveProvider,now:f.config.now,dbPath:f.config.dbPath});
  async function call(path,{session:actor=owner,method="GET",body={},headers={}}={}){
    const req=Readable.from(method==="GET"?[]:[Buffer.from(JSON.stringify(body))]);
    Object.assign(req,{method,headers:{"content-type":"application/json","idempotency-key":"scoped-onboarding-fixture",...headers}});
    let response;
    const res={setHeader(){},writeHead(status){this.statusCode=status;},end(value){response={status:this.statusCode??200,body:JSON.parse(value)};}};
    try{await routeStripeConnect({req,res,url:new URL(path,config.origin),db:f.db,config,session:actor});}
    catch(error){return {status:error.status??500,body:{error:{code:error.code,message:error.message}}};}
    return response;
  }
  const root=`/api/restaurant/restaurants/${selected.id}/finance/stripe`;
  return {f,config,selected,other,owner,otherOwner,customer,admin,testCalls,liveCalls,call,root};
}

async function credential(s){
  for(const [email,currentPassword]of [["restaurant@calai.local","LocalRestaurant!4310"],["admin@calai.local","LocalAdmin!4310"]]){
    const cookie=await s.f.login(email,currentPassword);
    const changed=await s.f.json("/api/auth/password",{method:"POST",cookie,body:{currentPassword,newPassword:"FixtureBankAccess!2026"}});
    assert.equal(changed.status,200,changed.text);
  }
}

test("live bank onboarding is explicit, hosted, allowlisted and has no financial provider methods",()=>{
  const calls=[],provider=adapter("stripe_live",calls);
  assert.equal(loadLiveOnboardingConfig({liveOnboardingRestaurantIds:[]},hosting),null);
  for(const override of [
    {liveOnboardingRestaurantIds:["not-a-restaurant"]},
    {liveOnboardingStripePlatformAccountId:""},
    {liveOnboardingStripeSecretKey:"rk_test_wrong_mode"},
    {liveOnboardingConnectWebhookSecret:staged.liveOnboardingWebhookSecret},
    {liveOnboardingPaymentProvider:adapter("stripe_test",[])},
  ])assert.throws(()=>loadLiveOnboardingConfig({...staged,liveOnboardingRestaurantIds:[scopeId],liveOnboardingPaymentProvider:provider,...override},hosting));
  assert.throws(()=>loadLiveOnboardingConfig({...staged,liveOnboardingRestaurantIds:[scopeId],liveOnboardingPaymentProvider:provider},{...hosting,nodeEnv:"development"}),/production hosting/);
  const scoped=loadLiveOnboardingConfig({...staged,liveOnboardingRestaurantIds:[scopeId],liveOnboardingPaymentProvider:provider},hosting);
  assert.deepEqual(scoped.restaurantIds,[scopeId]);assert.equal(scoped.connection.paymentProviderMode,"stripe_live");assert.equal(scoped.connection.livePaymentsEnabled,false);
  for(const name of ["createCheckoutSession","capturePayment","createTransfer"])assert.equal(scoped.connection.paymentProvider[name],undefined);
  assert.equal(calls.length,0,"Loading configuration never calls Stripe");
});

test("an incomplete live platform profile gives actionable guidance without creating a fake restaurant binding",async()=>{
  const s=await setup();try{
    await credential(s);
    const calls=[],blocked={...adapter("stripe_live",calls),createConnectedAccount:async input=>{calls.push({name:"blockedCreate",input});return {ok:false,status:"failed",errorCode:"STRIPE_CONNECT_PLATFORM_PROFILE_REQUIRED",message:"raw private provider message must not be exposed"};}};
    s.config.liveOnboarding={restaurantIds:[s.selected.id],connection:{...s.config.liveOnboarding.connection,paymentProvider:blocked,stripeProvider:blocked}};
    const before=JSON.stringify({accounts:s.f.db.prepare("SELECT * FROM provider_accounts").all(),readiness:s.f.db.prepare("SELECT * FROM stripe_account_readiness").all()});
    for(let attempt=0;attempt<2;attempt++){
      const result=await s.call(`${s.root}/onboarding`,{method:"POST",headers:{"idempotency-key":`fresh-browser-attempt-${attempt}`}});
      assert.equal(result.status,503);assert.equal(result.body.error.code,"STRIPE_CONNECT_PLATFORM_PROFILE_REQUIRED");assert.match(result.body.error.message,/Cal-Eats.*platform profile/);
      assert.doesNotMatch(JSON.stringify(result),/raw private|rk_live|whsec_|dashboard\.stripe/);
    }
    const creations=calls.filter(call=>call.name==="blockedCreate");assert.equal(creations.length,4);assert.equal(creations[0].input.idempotencyKey,`connect-account:stripe_live:${s.selected.id}`);assert.equal(new Set(creations.map(call=>call.input.idempotencyKey)).size,4);
    const attempts=s.f.db.prepare("SELECT * FROM provider_account_setup_attempts ORDER BY attempt_no").all();assert.deepEqual(attempts.map(row=>row.attempt_no),[0,1,2,3]);assert.ok(attempts.every(row=>row.status==="profile_rejected"&&row.outcome_code==="STRIPE_CONNECT_PLATFORM_PROFILE_REQUIRED"&&row.provider_reference===null));
    assert.equal(calls.some(call=>["schedule","onboardingLink","transfer","capture","checkout"].includes(call.name)),false);
    assert.equal(JSON.stringify({accounts:s.f.db.prepare("SELECT * FROM provider_accounts").all(),readiness:s.f.db.prepare("SELECT * FROM stripe_account_readiness").all()}),before);
    assert.equal(s.config.paymentProviderMode,"stripe_test");assert.equal(s.config.livePaymentsEnabled,false);
  }finally{await s.f.close();}
});

test("non-profile failures and ambiguous creation keep the same request until a verified response",async()=>{
  const s=await setup();try{
    await credential(s);
    const calls=[],base=adapter("stripe_live",calls),keys=[],emails=[];
    const provider={...base,createConnectedAccount:async input=>{keys.push(input.idempotencyKey);emails.push(input.email);return keys.length===1?{ok:false,status:"failed",errorCode:"permission_error"}:keys.length===2?{ok:false,status:"unknown",errorCode:"STRIPE_TIMEOUT"}:base.createConnectedAccount(input);}};
    s.config.liveOnboarding={restaurantIds:[s.selected.id],connection:{...s.config.liveOnboarding.connection,paymentProvider:provider,stripeProvider:provider}};
    const refused=await s.call(`${s.root}/onboarding`,{method:"POST"});assert.equal(refused.status,503);assert.equal(refused.body.error.code,"STRIPE_BANK_SETUP_UNAVAILABLE");
    const originalScope=s.config.liveOnboarding,originalAttempt={...s.f.db.prepare("SELECT * FROM provider_account_setup_attempts").get()};
    const otherPlatform={...provider,retrievePlatformAccount:async()=>({ok:true,status:"confirmed",providerReference:"acct_otherplatform",mode:"stripe_live"})};
    s.config.liveOnboarding={...originalScope,connection:{...originalScope.connection,stripePlatformAccountId:"acct_otherplatform",paymentProvider:otherPlatform,stripeProvider:otherPlatform}};
    const wrongPlatform=await s.call(`${s.root}/onboarding`,{method:"POST"});assert.equal(wrongPlatform.status,409);assert.equal(wrongPlatform.body.error.code,"ACCOUNT_SETUP_PLATFORM_MISMATCH");assert.equal(keys.length,1);assert.deepEqual({...s.f.db.prepare("SELECT * FROM provider_account_setup_attempts").get()},originalAttempt);
    s.config.liveOnboarding=originalScope;
    s.owner.user.email="changed-fixture@example.invalid";
    const pending=await s.call(`${s.root}/onboarding`,{method:"POST"});assert.equal(pending.status,503);assert.equal(pending.body.error.code,"STRIPE_ACCOUNT_CREATION_UNCONFIRMED");assert.match(pending.body.error.message,/try again from this page/i);
    assert.equal(s.f.db.prepare("SELECT 1 FROM provider_accounts WHERE restaurant_id=?").get(s.selected.id),undefined);
    assert.equal(calls.some(call=>["schedule","onboardingLink"].includes(call.name)),false);
    const recovered=await s.call(`${s.root}/onboarding`,{method:"POST",headers:{"idempotency-key":"second-browser-attempt"}});assert.equal(recovered.status,200,JSON.stringify(recovered));assert.equal(keys.length,3);assert.equal(new Set(keys).size,1);assert.equal(new Set(emails).size,1);
    assert.equal(s.f.db.prepare("SELECT COUNT(*) n FROM provider_account_setup_attempts").get().n,1);assert.equal(s.f.db.prepare("SELECT status FROM provider_account_setup_attempts").get().status,"succeeded");
    assert.equal(s.f.db.prepare("SELECT platform_account_id FROM provider_account_setup_attempts").get().platform_account_id,"acct_liveplatform");
    assert.throws(()=>s.f.db.prepare("UPDATE provider_account_setup_attempts SET platform_account_id='acct_otherplatform'").run(),/immutable/);
    assert.equal(s.f.db.prepare("SELECT COUNT(*) n FROM provider_accounts WHERE restaurant_id=? AND provider_mode='stripe_live'").get(s.selected.id).n,1);
    assert.equal(calls.filter(call=>call.name==="onboardingLink").length,1);
    assert.equal(s.config.paymentProviderMode,"stripe_test");assert.equal(s.config.livePaymentsEnabled,false);
  }finally{await s.f.close();}
});

test("bank and refresh responses distinguish the planned schedule from verified actual settings or unavailable readback",async()=>{
  const s=await setup();try{
    await credential(s);const calls=[],base=adapter("stripe_live",calls);let actual={interval:"weekly",weeklyPayoutDays:["monday"],weeklyAnchor:"monday"},denied=false;
    const provider={...base,retrievePayoutSchedule:async()=>denied?{ok:false,status:"failed",errorCode:"permission_error"}:{ok:true,status:"confirmed",providerReference:"acct_liverestaurant",payoutSchedule:actual}};
    s.config.liveOnboarding={restaurantIds:[s.selected.id],connection:{...s.config.liveOnboarding.connection,paymentProvider:provider,stripeProvider:provider}};
    assert.equal((await s.call(`${s.root}/onboarding`,{method:"POST"})).status,200);
    const planned=(await s.call(s.root)).body.data;assert.equal(planned.payoutSchedule,null);assert.equal(planned.payoutScheduleStatus,"unverified");assert.deepEqual(planned.plannedPayoutSchedule,{interval:"weekly",weeklyAnchor:"monday"});
    for(const interval of["weekly","daily","manual"]){
      actual=interval==="weekly"?{interval,weeklyPayoutDays:["thursday"],weeklyAnchor:"thursday"}:{interval};
      for(const[suffix,method]of[["banking","GET"],["refresh","POST"]]){
        const response=await s.call(`${s.root}/${suffix}`,{method});assert.equal(response.status,200,JSON.stringify(response));const dto=response.body.data;
        assert.equal(dto.payoutScheduleStatus,"verified");assert.equal(dto.payoutSchedule.interval,interval);assert.ok(dto.payoutScheduleVerifiedAt);assert.equal(dto.plannedPayoutSchedule.weeklyAnchor,"monday");
        assert.equal(dto.payoutSchedule.weeklyAnchor,interval==="weekly"?"thursday":undefined);
      }
    }
    denied=true;
    for(const[suffix,method]of[["banking","GET"],["refresh","POST"]]){
      const response=await s.call(`${s.root}/${suffix}`,{method});assert.equal(response.status,200,JSON.stringify(response));const dto=response.body.data;
      assert.equal(dto.payoutSchedule,null);assert.equal(dto.payoutScheduleStatus,"unverified");assert.equal(dto.payoutScheduleVerifiedAt,null);assert.match(dto.payoutScheduleMessage,/could not be checked/);assert.equal(dto.account.payoutsEnabled,true);assert.equal(dto.plannedPayoutSchedule.weeklyAnchor,"monday");
    }
    assert.equal(calls.filter(call=>call.name==="schedule").length,1,"Schedule readback never changes the provider settings");assert.equal(s.config.paymentProviderMode,"stripe_test");assert.equal(s.config.livePaymentsEnabled,false);
  }finally{await s.f.close();}
});

test("a cached definitive profile rejection advances once to recover without repeating the rejected key",async()=>{
  const s=await setup();try{
    await credential(s);const calls=[],base=adapter("stripe_live",calls),keys=[];
    const provider={...base,createConnectedAccount:async input=>{keys.push(input.idempotencyKey);return keys.length===1?{ok:false,status:"failed",errorCode:"STRIPE_CONNECT_PLATFORM_PROFILE_REQUIRED"}:base.createConnectedAccount(input);}};
    s.config.liveOnboarding={restaurantIds:[s.selected.id],connection:{...s.config.liveOnboarding.connection,paymentProvider:provider,stripeProvider:provider}};
    const recovered=await s.call(`${s.root}/onboarding`,{method:"POST"});assert.equal(recovered.status,200,JSON.stringify(recovered));assert.deepEqual(keys,[`connect-account:stripe_live:${s.selected.id}`,`connect-account:stripe_live:${s.selected.id}:attempt:1`]);
    const attempts=s.f.db.prepare("SELECT * FROM provider_account_setup_attempts ORDER BY attempt_no").all();assert.deepEqual(attempts.map(row=>row.status),["profile_rejected","succeeded"]);assert.equal(attempts[0].outcome_code,"STRIPE_CONNECT_PLATFORM_PROFILE_REQUIRED");assert.equal(attempts[1].provider_reference,"acct_liverestaurant");
    assert.equal(s.f.db.prepare("SELECT COUNT(*) n FROM provider_accounts WHERE restaurant_id=?").get(s.selected.id).n,1);
    assert.throws(()=>s.f.db.prepare("UPDATE provider_account_setup_attempts SET idempotency_key='replacement' WHERE attempt_no=0").run(),/immutable/);
  }finally{await s.f.close();}
});

test("concurrent bank setup clicks share one leased creation and never create competing accounts",async()=>{
  const s=await setup();try{
    await credential(s);const calls=[],base=adapter("stripe_live",calls),keys=[];let release,entered;
    const started=new Promise(resolve=>{entered=resolve;});
    const provider={...base,createConnectedAccount:input=>{keys.push(input.idempotencyKey);entered();return new Promise(resolve=>{release=()=>resolve(base.createConnectedAccount(input));});}};
    s.config.liveOnboarding={restaurantIds:[s.selected.id],connection:{...s.config.liveOnboarding.connection,paymentProvider:provider,stripeProvider:provider}};
    const first=s.call(`${s.root}/onboarding`,{method:"POST"});await started;
    const second=await s.call(`${s.root}/onboarding`,{method:"POST",headers:{"idempotency-key":"concurrent-browser-attempt"}});assert.equal(second.status,409);assert.equal(second.body.error.code,"ACCOUNT_SETUP_IN_PROGRESS");assert.equal(keys.length,1);
    release();assert.equal((await first).status,200);assert.equal(keys.length,1);assert.equal(s.f.db.prepare("SELECT COUNT(*) n FROM provider_account_setup_attempts").get().n,1);assert.equal(s.f.db.prepare("SELECT COUNT(*) n FROM provider_accounts WHERE restaurant_id=?").get(s.selected.id).n,1);
  }finally{await s.f.close();}
});

test("selected owner prepares live banking while other restaurants, customer checkout and workers stay in test mode",async()=>{
  const s=await setup();try{
    const initial=await s.call(s.root);assert.equal(initial.status,200);assert.equal(initial.body.data.providerMode,"stripe_live");assert.equal(initial.body.data.onboardingOnly,true);assert.equal(initial.body.data.customerPaymentsLive,false);assert.equal(initial.body.data.passwordChangeRequired,true);
    for(const [suffix,method]of [["onboarding","POST"],["banking","GET"],["payouts","GET"]]){const denied=await s.call(`${s.root}/${suffix}`,{method});assert.equal(denied.status,403);assert.equal(denied.body.error.code,"LIVE_BANKING_PASSWORD_CHANGE_REQUIRED");}
    assert.equal(s.liveCalls.filter(c=>c.name==="createAccount").length,0);
    await credential(s);
    const linked=await s.call(`${s.root}/onboarding`,{method:"POST"});assert.equal(linked.status,200,JSON.stringify(linked));assert.equal(linked.body.data.providerMode,"stripe_live");assert.equal(linked.body.data.onboardingOnly,true);assert.equal(linked.body.data.customerPaymentsLive,false);assert.match(linked.body.data.url,/acct_liverestaurant/);
    assert.equal(s.f.db.prepare("SELECT provider_mode FROM provider_accounts WHERE restaurant_id=?").get(s.selected.id).provider_mode,"stripe_live");
    for(const [suffix,method]of [["refresh","POST"],["dashboard","POST"],["banking","GET"],["payouts","GET"]]){const response=await s.call(`${s.root}/${suffix}`,{method});assert.equal(response.status,200,JSON.stringify(response));assert.equal(response.body.data.onboardingOnly,true);assert.equal(response.body.data.customerPaymentsLive,false);}
    const otherRoot=`/api/restaurant/restaurants/${s.other.id}/finance/stripe`,other=await s.call(otherRoot,{session:s.otherOwner});assert.equal(other.status,200);assert.equal(other.body.data.providerMode,"stripe_test");assert.equal(other.body.data.onboardingOnly,false);
    const otherLink=await s.call(`${otherRoot}/onboarding`,{session:s.otherOwner,method:"POST"});assert.equal(otherLink.status,200);assert.equal(otherLink.body.data.providerMode,"stripe_test");assert.equal(s.testCalls.filter(c=>c.name==="createAccount").length,1);
    const global=await s.call("/api/payments/config",{session:s.customer});assert.equal(global.body.data.providerMode,"stripe_test");assert.equal(s.config.paymentProvider.mode,"stripe_test");assert.equal(s.config.livePaymentsEnabled,false);
    const customerCookie=await s.f.login("customer@calai.local","LocalCustomer!4310"),item=s.f.db.prepare("SELECT id FROM menu_items WHERE restaurant_id=? LIMIT 1").get(s.selected.id);
    const blocked=await s.f.json("/api/orders",{method:"POST",cookie:customerCookie,headers:{"Idempotency-Key":"live-banking-not-customer-launch"},body:{restaurantId:s.selected.id,items:[{menuItemId:item.id,quantity:1}],paymentMethod:"card",fulfillment:"collection"}});assert.equal(blocked.status,409);assert.equal(blocked.body.error.code,"RESTAURANT_CARD_NOT_READY");assert.equal(s.f.db.prepare("SELECT COUNT(*) n FROM stripe_order_payments").get().n,0);
    const before=s.liveCalls.length;await runStripeConnectWorker(s.f.db,s.config);assert.equal(s.liveCalls.length,before,"Global worker cannot use live onboarding provider");
    assert.equal(s.liveCalls.some(c=>["checkout","capture","transfer"].includes(c.name)),false);
  }finally{await s.f.close();}
});

test("live banking requires genuine owner access, verifies platform identity and never replaces a sandbox binding",async()=>{
  const s=await setup();try{
    await credential(s);
    for(const session of [s.customer,s.otherOwner,s.admin,null]){const denied=await s.call(`${s.root}/onboarding`,{session,method:"POST"});assert.ok([401,403,404].includes(denied.status));}
    const scopedAdmin=scopedAdminRestaurantSession(s.admin,s.selected.id);assert.equal((await s.call(s.root,{session:scopedAdmin})).status,200);
    for(const [suffix,method]of [["onboarding","POST"],["refresh","POST"],["dashboard","POST"],["banking","GET"],["payouts","GET"]])assert.equal((await s.call(`${s.root}/${suffix}`,{session:scopedAdmin,method})).status,403);
    s.f.db.prepare("UPDATE restaurant_memberships SET permission='staff' WHERE restaurant_id=? AND user_id=?").run(s.selected.id,s.owner.user.id);assert.equal((await s.call(s.root)).status,403);s.f.db.prepare("UPDATE restaurant_memberships SET permission='owner' WHERE restaurant_id=? AND user_id=?").run(s.selected.id,s.owner.user.id);
    const stamp=s.config.now().toISOString();s.f.db.prepare("INSERT INTO provider_accounts VALUES(?,?, 'stripe_test','pending','[]','[]','acct_savedtest',?,?)").run(randomUUID(),s.selected.id,stamp,stamp);
    const before={...s.f.db.prepare("SELECT * FROM provider_accounts WHERE restaurant_id=?").get(s.selected.id)};
    for(const [suffix,method]of [["","GET"],["/onboarding","POST"],["/banking","GET"]]){const denied=await s.call(`${s.root}${suffix}`,{method});assert.equal(denied.status,409);assert.equal(denied.body.error.code,"STRIPE_MODE_MISMATCH");}
    assert.deepEqual({...s.f.db.prepare("SELECT * FROM provider_accounts WHERE restaurant_id=?").get(s.selected.id)},before);assert.equal(s.liveCalls.filter(c=>c.name==="createAccount").length,0);
    s.f.db.prepare("DELETE FROM provider_accounts WHERE restaurant_id=?").run(s.selected.id);
    const racedAdapter={...adapter("stripe_live",s.liveCalls),createConnectedAccount:async()=>{s.f.db.prepare("INSERT INTO provider_accounts VALUES(?,?,'stripe_test','pending','[]','[]','acct_racedtest',?,?)").run(randomUUID(),s.selected.id,stamp,stamp);return {status:"pending",providerReference:"acct_liverestaurant",chargesEnabled:false,payoutsEnabled:false};}};
    s.config.liveOnboarding=loadLiveOnboardingConfig({...staged,liveOnboardingRestaurantIds:[s.selected.id],liveOnboardingPaymentProvider:racedAdapter},hosting);
    const raced=await s.call(`${s.root}/onboarding`,{method:"POST"});assert.equal(raced.status,409);assert.equal(raced.body.error.code,"STRIPE_MODE_MISMATCH");assert.equal(s.f.db.prepare("SELECT provider_reference FROM provider_accounts WHERE restaurant_id=?").get(s.selected.id).provider_reference,"acct_racedtest");
    s.f.db.prepare("DELETE FROM provider_accounts WHERE restaurant_id=?").run(s.selected.id);
    s.config.liveOnboarding=loadLiveOnboardingConfig({...staged,liveOnboardingRestaurantIds:[s.selected.id],liveOnboardingPaymentProvider:{...adapter("stripe_live",s.liveCalls),retrievePlatformAccount:async()=>({status:"confirmed",providerReference:"acct_wrongplatform",mode:"stripe_live"})}},hosting);
    const wrong=await s.call(`${s.root}/onboarding`,{method:"POST"});assert.equal(wrong.status,503);assert.equal(wrong.body.error.code,"STRIPE_ACCOUNT_MISMATCH");assert.equal(s.f.db.prepare("SELECT COUNT(*) n FROM provider_accounts WHERE restaurant_id=?").get(s.selected.id).n,0);
  }finally{await s.f.close();}
});

test("archived restaurant orders cannot start or reuse Checkout but can refresh existing payment history",async()=>{
  const s=await setup();try{
    const stamp=s.config.now().toISOString();
    s.f.db.prepare("INSERT INTO provider_accounts VALUES(?,?,'stripe_test','enabled','[\"card_payments\",\"transfers\"]','[]','acct_testrestaurant',?,?)").run(randomUUID(),s.selected.id,stamp,stamp);
    s.f.db.prepare("INSERT INTO stripe_account_readiness VALUES(?,'stripe_test','acct_testrestaurant',1,1,?)").run(s.selected.id,stamp);
    const cookie=await s.f.login("customer@calai.local","LocalCustomer!4310"),item=s.f.db.prepare("SELECT id FROM menu_items WHERE restaurant_id=? LIMIT 1").get(s.selected.id);
    const placed=await s.f.json("/api/orders",{method:"POST",cookie,headers:{"Idempotency-Key":"placed-before-catalogue-archive"},body:{restaurantId:s.selected.id,items:[{menuItemId:item.id,quantity:1}],paymentMethod:"card",fulfillment:"collection"}});assert.equal(placed.status,201,placed.text);
    const order=placed.body.data;
    s.f.db.prepare("UPDATE restaurants SET archived_at=? WHERE id=?").run(stamp,s.selected.id);
    const checkout=()=>s.call(`/api/orders/${order.id}/checkout`,{session:s.customer,method:"POST"});
    assert.equal((await checkout()).body.error.code,"RESTAURANT_UNAVAILABLE");
    s.f.db.prepare("UPDATE stripe_order_payments SET checkout_session_id='cs_archived',checkout_url='https://checkout.stripe.com/c/pay/cs_archived' WHERE order_id=?").run(order.id);
    const reuse=await checkout();assert.equal(reuse.status,409);assert.equal(reuse.body.error.code,"RESTAURANT_UNAVAILABLE");assert.equal(s.testCalls.length,0,"Archive refusal happens before any provider call");
    let refreshCalls=0;s.config.paymentProvider.retrieveCheckoutSession=async()=>{refreshCalls++;return {status:"confirmed",paymentState:"pending",providerReference:"cs_archived",amountMinor:order.totalMinor,currency:"GBP",orderId:order.id,restaurantId:s.selected.id};};
    const refreshed=await s.call(`/api/orders/${order.id}/payment/refresh`,{session:s.customer,method:"POST"});assert.equal(refreshed.status,200,JSON.stringify(refreshed));assert.equal(refreshCalls,1);assert.equal(s.f.db.prepare("SELECT checkout_session_id FROM stripe_order_payments WHERE order_id=?").get(order.id).checkout_session_id,"cs_archived");
  }finally{await s.f.close();}
});
