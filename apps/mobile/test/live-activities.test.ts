import test from "node:test";
import assert from "node:assert/strict";
import { createLiveActivityController } from "../src/live-activity-controller.ts";
import type { LiveOrderInstance } from "../src/live-activity-controller.ts";
import { eligibleLiveOrder, liveOrderPaymentEligible, parseLiveActivityOrderLink, parseLiveOrderContent, LIVE_ACTIVITY_LIFETIME_MS } from "../src/live-activity-model.ts";
import type { LiveActivityBinding, LiveActivityIdentity, LiveActivityRegistration, LiveOrderCandidate, LiveOrderContent } from "../src/live-activity-model.ts";
const now = Date.parse("2026-11-07T12:00:00Z"), orderId="10000000-0000-4000-8000-000000000001", userId="20000000-0000-4000-8000-000000000001";
const scope:LiveActivityIdentity={token:"session-a",userId,installationId:"30000000-0000-4000-8000-000000000001"};
const content=(id=orderId,statusLabel="Preparing your food"):LiveOrderContent=>({orderId:id,restaurantName:"Fixture restaurant",statusLabel,etaLabel:"Delivery 12:45",etaUnix:Math.floor(now/1000)+2700,fulfillment:"delivery",updatedAtUnix:Math.floor(now/1000)});
const candidate=(id=orderId,revision=1):LiveOrderCandidate=>({orderId:id,createdAt:new Date(now-60000).toISOString(),scheduledFor:null,serverRevision:revision,content:content(id)});
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
function fixture(initial:LiveActivityBinding[]=[]){
  let stored=structuredClone(initial),clock=now,number=0,refuse=false,paymentEligible=true,orderStatus="preparing",initialToken:string|null="a".repeat(64);
  const instances=new Map<string,Fake>(),registrations:Array<{session:string;activityId:string;orderId:string;pushToken:string}>=[],revoked:Array<{session:string;id:string}>=[];
  let response:((input:{activityId:string;orderId:string;pushToken:string})=>Promise<LiveActivityRegistration>)|null=null;
  class Fake implements LiveOrderInstance{
    id=`activity-${++number}`;ended=false;token:string|null=initialToken;updates:LiveOrderContent[]=[];expiry:Date|undefined;props:LiveOrderContent;listeners=new Set<(e:{activityId:string;pushToken:string})=>void>();
    constructor(props:LiveOrderContent,expiry?:Date){this.props=props;this.expiry=expiry;instances.set(this.id,this);}
    getId(){return this.id;}async update(c:LiveOrderContent){this.updates.push(c);this.props=c;}async end(){this.ended=true;}async getPushToken(){return this.token;}
    addPushTokenListener(fn:(e:{activityId:string;pushToken:string})=>void){this.listeners.add(fn);return{remove:()=>{this.listeners.delete(fn);}};}
    rotate(value:string){this.token=value;for(const fn of this.listeners)fn({activityId:this.id,pushToken:value});}
  }
  const controller=()=>createLiveActivityController({factory:{getInstances:()=>[...instances.values()].filter(x=>!x.ended),start:(c,_url,expiry)=>{if(refuse)throw Error("Permission disabled");return new Fake(c,expiry);}},read:async()=>structuredClone(stored),write:async rows=>{stored=structuredClone(rows);},now:()=>clock,register:async(identity,input)=>{registrations.push({session:identity.token,...input});if(response)return response(input);return{registered:true,activityId:input.activityId,expiresAt:new Date(clock+LIVE_ACTIVITY_LIFETIME_MS).toISOString(),content:content(input.orderId),serverRevision:1,updatesEnabled:true,action:"update"};},unregister:async(identity,id)=>{revoked.push({session:identity.token,id});},orderState:async()=>({status:orderStatus,paymentEligible})});
  return{controller,instances,registrations,revoked,get stored(){return stored;},set response(value:typeof response){response=value;},set refuse(value:boolean){refuse=value;},set initialToken(value:string|null){initialToken=value;},set paymentEligible(value:boolean){paymentEligible=value;},set orderStatus(value:string){orderStatus=value;},set clock(value:number){clock=value;}};
}
test("only recent scheduled-window candidates and explicit lock-screen fields/links are accepted",()=>{
  assert.ok(eligibleLiveOrder(candidate(),now));assert.equal(eligibleLiveOrder({...candidate(),createdAt:new Date(now-LIVE_ACTIVITY_LIFETIME_MS-1).toISOString()},now),null);
  assert.equal(eligibleLiveOrder({...candidate(),scheduledFor:new Date(now+3*3600000).toISOString()},now),null);
  const parsed=parseLiveOrderContent({...content(),deliveryAddress:"private",customerName:"private",message:"private"});assert.deepEqual(parsed,content());
  assert.equal(parseLiveActivityOrderLink(`caleats://order/${orderId}`),orderId);
  for(const bad of [`https://eats.calai.info/order/${orderId}`,`caleats://order:44/${orderId}`,`caleats://order/${orderId}?url=bad`,`caleats://order/${orderId}/extra`,`caleats://owner/${orderId}`])assert.equal(parseLiveActivityOrderLink(bad),null);
  for(const [paymentMethod,paymentStatus]of [["cash","cash_due"],["mock_card","mock_captured"],["card","stripe_authorized"],["voucher","voucher_redeemed"]])assert.equal(liveOrderPaymentEligible({paymentMethod:paymentMethod!,paymentStatus:paymentStatus!}),true);
  for(const [paymentMethod,paymentStatus]of [["cash","cancelled"],["mock_card","mock_failed"],["card","stripe_refunded"],["card","stripe_partially_refunded"],["voucher","voucher_released"]])assert.equal(liveOrderPaymentEligible({paymentMethod:paymentMethod!,paymentStatus:paymentStatus!}),false);
});
test("scheduled orders use fulfillment time instead of yesterday's creation time for the live window",()=>{
  const oldCreated=new Date(now-24*3600000).toISOString(),scheduledFor=new Date(now+3600000).toISOString();
  const order={...candidate(),createdAt:oldCreated,scheduledFor};
  const eligible=eligibleLiveOrder(order,now);
  assert.ok(eligible);assert.equal(eligible.createdAt,oldCreated);assert.equal(eligible.scheduledFor,scheduledFor);
  assert.equal(eligibleLiveOrder({...order,scheduledFor:new Date(now-LIVE_ACTIVITY_LIFETIME_MS).toISOString()},now),null);
  assert.equal(eligibleLiveOrder({...order,scheduledFor:new Date(now-LIVE_ACTIVITY_LIFETIME_MS-1).toISOString()},now),null);
  assert.equal(eligibleLiveOrder({...order,scheduledFor:new Date(now+2*3600000+1).toISOString()},now),null);
  assert.equal(eligibleLiveOrder({...order,scheduledFor:"invalid"},now),null);
  assert.ok(eligibleLiveOrder({...order,createdAt:new Date(now+1_000).toISOString()},now));
  assert.ok(eligibleLiveOrder({...order,createdAt:new Date(now+60_000).toISOString()},now));
  assert.equal(eligibleLiveOrder({...order,createdAt:new Date(now+60_001).toISOString()},now),null);
  assert.equal(eligibleLiveOrder({...order,scheduledFor:null},now),null);
});
test("multiple orders start once; unchanged polling and bound APNs updates never rewrite local state",async()=>{
  const f=fixture(),c=f.controller(),second="10000000-0000-4000-8000-000000000002";await c.activate(scope);
  const feed={updatesEnabled:true,items:[candidate(),candidate(second)]};await c.sync(scope,feed);await c.sync(scope,feed);
  assert.equal(f.instances.size,2);assert.equal(f.registrations.length,2);assert.ok([...f.instances.values()].every(x=>x.updates.length===0));
  const changed={...candidate(orderId,2),content:content(orderId,"Your food is on its way")};await c.sync(scope,{updatesEnabled:true,items:[changed,candidate(second)]});
  assert.equal(f.registrations.length,3);assert.ok([...f.instances.values()].every(x=>!x.ended&&x.updates.length===0));
  assert.equal([...f.instances.values()][0]!.expiry!.getTime(),now+60*60000); // ETA +15min, no heartbeat.
});
test("delayed token rotation binds once and a terminal registration ends without exposing stale content",async()=>{
  const f=fixture();f.initialToken=null;
  const c=f.controller();await c.activate(scope);await c.sync(scope,{updatesEnabled:true,items:[candidate()]});
  const handle=[...f.instances.values()][0]!;assert.equal(f.registrations.length,0);handle.rotate("b".repeat(64));await c.sync(scope,{updatesEnabled:true,items:[candidate()]});assert.equal(f.registrations.length,1);
  handle.rotate("b".repeat(64));await c.sync(scope,{updatesEnabled:true,items:[candidate()]});assert.equal(f.registrations.length,1);
  f.response=async input=>({registered:false,activityId:input.activityId,expiresAt:null,content:content(input.orderId,"Delivered"),serverRevision:2,updatesEnabled:true,action:"end"});handle.rotate("c".repeat(64));await c.sync(scope,{updatesEnabled:true,items:[candidate()]});
  assert.equal(handle.ended,true);assert.equal(f.stored[0]?.suppressed,true);
  await c.sync(scope,{updatesEnabled:true,items:[candidate()]});assert.equal(f.instances.size,1);
});
test("user dismissal and permission refusal stay suppressed, including after process restore",async()=>{
  const f=fixture(),c=f.controller();await c.activate(scope);await c.sync(scope,{updatesEnabled:true,items:[candidate()]});const h=[...f.instances.values()][0]!;h.ended=true;
  await c.sync(scope,{updatesEnabled:true,items:[candidate()]});assert.equal(f.stored[0]?.suppressed,true);assert.equal(f.instances.size,1);
  const restored=f.controller();await restored.activate(scope);await restored.sync(scope,{updatesEnabled:true,items:[candidate()]});assert.equal(f.instances.size,1);
  const denied=fixture();denied.refuse=true;const d=denied.controller();await d.activate(scope);await d.sync(scope,{updatesEnabled:true,items:[candidate()]});denied.refuse=false;await d.sync(scope,{updatesEnabled:true,items:[candidate()]});assert.equal(denied.instances.size,0);
});
test("logout waits for a late registration; re-login may resume but old authorization cannot end the new activity",async()=>{
  const f=fixture(),pending=deferred<LiveActivityRegistration>();f.response=()=>pending.promise;const c=f.controller();await c.activate(scope);
  const syncing=c.sync(scope,{updatesEnabled:true,items:[candidate()]});while(!f.registrations.length)await new Promise(resolve=>setImmediate(resolve));
  const oldId=f.registrations[0]!.activityId,stopping=c.stop();pending.resolve({registered:true,activityId:oldId,expiresAt:new Date(now+LIVE_ACTIVITY_LIFETIME_MS).toISOString(),content:content(),serverRevision:1,updatesEnabled:true,action:"update"});await syncing;await stopping;
  assert.ok(f.revoked.some(x=>x.session===scope.token&&x.id===oldId));assert.ok([...f.instances.values()].every(x=>x.ended));
  f.response=null;const next={...scope,token:"session-b"};await c.activate(next);await c.sync(next,{updatesEnabled:true,items:[candidate()]});assert.equal(f.instances.size,2);const current=[...f.instances.values()][1]!;assert.equal(current.ended,false);
  await c.loseAuthorization(scope);assert.equal(current.ended,false);await c.loseAuthorization(next);assert.equal(current.ended,true);
});
test("a no-token activity ends when payment ceases to be payable; transient registration failure preserves tracking",async()=>{
  const f=fixture();f.response=async()=>{throw Object.assign(Error("Offline"),{status:0});};const c=f.controller();await c.activate(scope);await c.sync(scope,{updatesEnabled:true,items:[candidate()]});const h=[...f.instances.values()][0]!;assert.equal(h.ended,false);
  h.token=null;f.paymentEligible=false;await c.sync(scope,{updatesEnabled:true,items:[]});assert.equal(h.ended,true);assert.ok(f.revoked.length);
});
test("cold-restored activities never overwrite a newer APNs state with an older foreground fetch",async()=>{
  const f=fixture(),c=f.controller();await c.activate(scope);await c.sync(scope,{updatesEnabled:true,items:[candidate()]});
  const h=[...f.instances.values()][0]!;h.props=content(orderId,"Your food is on its way");
  const restored=f.controller();await restored.activate(scope);await restored.sync(scope,{updatesEnabled:true,items:[{...candidate(orderId,2),content:content(orderId,"Order confirmed")}]});
  assert.equal(h.props.statusLabel,"Your food is on its way");assert.equal(h.updates.length,0);
});
