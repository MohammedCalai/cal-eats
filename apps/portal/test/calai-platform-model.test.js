import test from "node:test";
import assert from "node:assert/strict";
import {adminProduct,calaiNavigation,calaiReady,calaiMoney,calaiPage,platformReturnPath,platformLoginMode,platformLoginRequest,tenantEditPayload,telephonyPayload,calaiRequestPresentation,calaiRequestStatusPath} from "../src/calai-platform-model.js";

test("administrator credentials wait for an initial choice, then retain their chosen destination across late settings",()=>{
 assert.equal(platformLoginMode(null,{loading:true}),null);
 assert.equal(platformLoginMode(null,{loginAvailable:false}),"local");
 assert.equal(platformLoginMode(null,{loginAvailable:true}),"calai");
 // Explicit local access works before the settings response and must not become source authentication later.
 let chosen=platformLoginMode("local",{loading:true});
 chosen=platformLoginMode(chosen,{loginAvailable:true});
 assert.equal(chosen,"local");
 assert.equal(platformLoginMode("calai",{loginAvailable:false}),"calai");
 assert.equal(platformLoginMode(null,{}),"local");
});
test("local administrator recovery never sends credentials to Calai or accepts a source return destination",()=>{
 const local=platformLoginRequest("local"," Admin@Example.invalid "," exact local password ","/admin/calai/tenants");
 assert.deepEqual(local,{path:"/api/platform-auth/local-login",body:{email:"Admin@Example.invalid",password:" exact local password "},destination:"/admin/connection"});
 const source=platformLoginRequest("calai"," Owner@Example.invalid ","different source password","/admin/calai/tenants?page=2");
 assert.deepEqual(source,{path:"/api/platform-auth/login",body:{email:"Owner@Example.invalid",password:"different source password"},destination:"/admin/calai/tenants?page=2"});
 assert.equal(platformLoginRequest("calai","owner@example.invalid","source","https://outside.invalid/admin/tenants").destination,"/admin/calai/dashboard");
 for(const mode of [null,undefined,"automatic","owner"])assert.throws(()=>platformLoginRequest(mode,"a@example.invalid","password"),/Choose an administrator/);
});

test("platform navigation separates Calai tenant tools from every existing Cal-Eats admin area",()=>{
 assert.equal(calaiNavigation.length,6);assert.equal(new Set(calaiNavigation.map(([,path])=>path)).size,6);
 for(const [,path]of calaiNavigation)assert.equal(adminProduct(path),"calai");
 for(const path of ["/admin/restaurants","/admin/finance","/admin/orders","/admin/customers"])assert.equal(adminProduct(path),"cal-eats");
 assert.equal(platformReturnPath("/admin/calai/tenants?id=1"),"/admin/calai/tenants?id=1");
 for(const path of ["//evil.invalid/admin/x","https://evil.invalid/admin/x","/owner/dashboard","/admin/login","/admin/\\evil.invalid","/admin/calai/../login","/admin/calai/../../owner/dashboard"])assert.equal(platformReturnPath(path),"/admin/calai/dashboard");
});
test("lost-response recovery uses a read-only own-key lookup and prefers an existing exact request reference",()=>{
 const id="a1111111-1111-4111-8111-111111111111";
 assert.equal(calaiRequestStatusPath(id,"calai-own-intent"),`/api/admin/platform-connection/requests/${id}`);
 assert.equal(calaiRequestStatusPath(null,"calai-own-intent"),"/api/admin/platform-connection/requests/lookup?key=calai-own-intent");
 assert.equal(new URL(calaiRequestStatusPath(null,"intent:own.123"),"https://eats.calai.info").searchParams.get("key"),"intent:own.123");
 for(const key of [null,"https://evil.invalid","valid-key&user=someone","short"])assert.throws(()=>calaiRequestStatusPath(null,key),/no usable reference/);
});
test("administrator outcome reports never become provider confirmation or an automatic retry",()=>{
 const now=Date.parse("2026-11-15T18:00:00Z");
 assert.equal(calaiRequestPresentation({status:"confirmed",providerConfirmed:true},now).confirmed,true);
 assert.equal(calaiRequestPresentation({status:"confirmed",providerConfirmed:false},now).confirmed,false);
 const applied=calaiRequestPresentation({status:"operator_reported_applied",providerConfirmed:false,review:{result:"applied"},canSubmitNewIntent:false},now);
 assert.equal(applied.confirmed,false);assert.equal(applied.allowNewIntent,false);assert.match(applied.notice,/operator report, not provider confirmation/);
 const notApplied={status:"operator_reported_not_applied",review:{result:"not_applied"},canSubmitNewIntent:true};assert.equal(calaiRequestPresentation(notApplied,now).allowNewIntent,true);assert.equal(calaiRequestPresentation({...notApplied,canSubmitNewIntent:false},now).allowNewIntent,false);
 assert.equal(calaiRequestPresentation({status:"unknown"},now).canReview,true);
 assert.equal(calaiRequestPresentation({status:"dispatching",updatedAt:new Date(now-60_000).toISOString()},now).canReview,false);
 assert.equal(calaiRequestPresentation({status:"dispatching",updatedAt:new Date(now-120_000).toISOString()},now).canReview,true);
});
test("a linked email alone never makes Calai data available without this session's explicit authority",()=>{
 const ready={enabled:true,configured:true,linked:true,session:{federated:true},capabilities:{read:true}};assert.equal(calaiReady(ready),true);
 for(const key of ["enabled","configured","linked"])assert.equal(calaiReady({...ready,[key]:false}),false);
 assert.equal(calaiReady({...ready,session:null}),false);assert.equal(calaiReady({...ready,capabilities:{read:false}}),false);assert.equal(calaiReady(null),false);
});
test("reported finance amounts never infer pounds when the upstream currency is missing",()=>{
 assert.equal(calaiMoney(12.5,"USD"),"US$12.50");assert.equal(calaiMoney(12.5,"GBP"),"£12.50");
 assert.match(calaiMoney(12.5),/currency not confirmed/);assert.match(calaiMoney(12.5,""),/currency not confirmed/);
 for(const value of [null,undefined,"","  ",NaN,true,false,{}])assert.equal(calaiMoney(value,"GBP"),"Not available");
 assert.equal(calaiMoney(0,"GBP"),"£0.00");
});
test("tenant pagination keeps identifiers separate even when names match and resets an out-of-range page",()=>{
 const items=Array.from({length:62},(_,index)=>({id:`tenant-${index}`,name:index<2?"Same business":`Tenant ${index}`,status:"active"}));
 const page=calaiPage(items,"",2);assert.equal(page.items.length,25);assert.equal(page.page,2);assert.equal(page.total,62);
 const filtered=calaiPage(items,"same business",8);assert.equal(filtered.page,1);assert.deepEqual(filtered.items.map(row=>row.id),["tenant-0","tenant-1"]);
});
test("tenant/telephony edits use only the actual source's allowed fields and international routing numbers",()=>{
 assert.deepEqual(tenantEditPayload({name:" Updated ",status:"active",email:"ignored@example.invalid"},{name:"Original",status:"active"}),{name:"Updated"});
 assert.deepEqual(tenantEditPayload({name:"Original",status:"active"},{name:"Original",status:"active"}),{});
 assert.throws(()=>tenantEditPayload({name:" ",status:"active"},{}));assert.throws(()=>tenantEditPayload({name:"Name",status:"admin"},{}));
 assert.deepEqual(telephonyPayload({twilioNumber:" +441234567890 ",managerNumber:"+447123456789"}),{twilioNumber:"+441234567890",managerNumber:"+447123456789"});
 assert.throws(()=>telephonyPayload({twilioNumber:"01234567890",managerNumber:"+447123456789"}));
 assert.deepEqual(telephonyPayload({businessId:"tenant",assistant_id:"agent",twilioNumber:"+441234567890",managerNumber:"+447123456789"},true),{businessId:"tenant",assistant_id:"agent",twilio_number:"+441234567890",manager_number:"+447123456789"});
});
