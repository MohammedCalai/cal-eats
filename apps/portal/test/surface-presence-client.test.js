import test from "node:test";
import assert from "node:assert/strict";
import {createSurfacePresenceClient} from "../src/surface-presence-client.js";
const flush=async()=>{for(let n=0;n<5;n++)await new Promise(resolve=>setImmediate(resolve));};
const active=()=>({status:"ready",paired:true,terminalId:"terminal-a",context:{principalKind:"terminal",businessId:"business-a",restaurantId:"restaurant-a",terminalId:"terminal-a"}});
const disconnected=()=>({status:"connection_unavailable",paired:true,terminalId:"terminal-a",context:null,reconnectEligible:true});
const selected={businessId:"business-a",restaurantId:"restaurant-a"};
function fixture(override={}){
 let snapshot=active(),counter=0,handle=0;const calls=[],scheduled=new Map(),states=[];
 const request=override.request||(async(path,options={})=>{calls.push({path,...options,parsed:options.body?JSON.parse(options.body):null});return options.method==="POST"?{accepted:true,receivedAt:"2026-11-22T12:00:00Z",heartbeatSeconds:30}:{items:[]};});
 const client=createSurfacePresenceClient({status:()=>snapshot,request,nextSequence:()=>++counter,schedule:(fn,delay)=>{const id=++handle;scheduled.set(id,{fn,delay});return id;},cancel:id=>scheduled.delete(id),onState:value=>states.push(value),...override});
 return{client,calls,scheduled,states,setStatus:value=>{snapshot=value;},async next(){const [id,{fn}]=scheduled.entries().next().value;scheduled.delete(id);fn();await flush();}};
}
test("human sessions, wrong businesses and wrong restaurants cannot generate presence",async()=>{
 for(const snapshot of [{status:"ready",context:{...active().context,principalKind:"human"}},{...active(),context:{...active().context,businessId:"other"}},{...active(),context:{...active().context,restaurantId:"other"}}]){const f=fixture();f.setStatus(snapshot);f.client.start(selected);await flush();assert.equal(f.calls.length,0);f.client.stop();}
});
test("a signed own-order receive check precedes each heartbeat and no browser or customer fields are sent",async()=>{
 const f=fixture();f.client.start(selected);await flush();
 assert.equal(f.calls[0].path,"/api/restaurant/orders/pending-confirmation?restaurantId=restaurant-a");
 assert.equal(f.calls[1].path,"/api/business/accounts/business-a/surface/heartbeat");assert.deepEqual(f.calls[1].parsed,{sequence:1,state:"active"});assert.equal([...f.scheduled.values()][0].delay,30000);
 await f.next();assert.deepEqual(f.calls[3].parsed,{sequence:2,state:"active"});f.client.stop();assert.equal(f.scheduled.size,0);
});
test("failed order receiving cannot keep the Surface online and requests never overlap",async()=>{
 let resolveRead;const calls=[];const f=fixture({request:(path,options={})=>{calls.push({path,...options});return new Promise(resolve=>{resolveRead=resolve;});}});
 f.client.start(selected);await f.client.tick();await f.client.tick();assert.equal(calls.length,1);
 f.setStatus({status:"revoked",context:null});resolveRead({items:[]});await flush();assert.equal(calls.length,1);await f.next();assert.equal(f.scheduled.size,0);f.client.stop();
 const failed=fixture({request:async()=>{throw Object.assign(Error("offline"),{status:500});}});failed.client.start(selected);await flush();assert.equal(failed.states.some(row=>row.state==="reporting"),false);assert.equal(failed.scheduled.size,1);failed.client.stop();
});
test("effect remounts retain the monotonic sequence rather than replaying the previous heartbeat",async()=>{
 const f=fixture();f.client.start(selected);await flush();f.client.stop();f.client.start(selected);await flush();assert.deepEqual(f.calls.filter(row=>row.parsed).map(row=>row.parsed.sequence),[1,2]);f.client.stop();
});
test("known logout cancels an in-flight receive check, reports signed_out once, then never sends active again",async()=>{
 const calls=[];let reads=0;
 const f=fixture({request:(path,options={})=>{calls.push({path,parsed:options.body?JSON.parse(options.body):null});if(!options.method){reads++;return new Promise((resolve,reject)=>options.signal.addEventListener("abort",()=>reject(Object.assign(Error("aborted"),{code:"TERMINAL_ABORTED"})),{once:true}));}return Promise.resolve({accepted:true});}});
 f.client.start(selected);const first=f.client.signedOut(),second=f.client.signedOut();assert.equal(first,second);assert.deepEqual(await first,{sent:true});await f.client.tick();await flush();assert.equal(reads,1);assert.deepEqual(calls.filter(row=>row.parsed).map(row=>row.parsed),[{sequence:1,state:"signed_out"}]);assert.equal(f.scheduled.size,0);
});
test("lost active acknowledgement cannot overtake a later signed-out sequence or be blindly retried",async()=>{
 const posts=[];let activeEntered;const entered=new Promise(resolve=>{activeEntered=resolve;});
 const f=fixture({request:async(path,options={})=>{if(!options.method)return{items:[]};const body=JSON.parse(options.body);posts.push(body);if(body.state==="active"){activeEntered();await new Promise((resolve,reject)=>options.signal.addEventListener("abort",()=>reject(Error("lost acknowledgement")),{once:true}));}return{accepted:true};}});
 f.client.start(selected);await entered;assert.deepEqual(await f.client.signedOut(),{sent:true});assert.deepEqual(posts,[{sequence:1,state:"active"},{sequence:2,state:"signed_out"}]);await f.client.tick();assert.equal(posts.length,2);
});
test("Strict Mode remount during a pending read starts one fresh generation and discards the old completion",async()=>{
 let reads=0;const posts=[];
 const f=fixture({request:async(path,options={})=>{if(options.method){posts.push(JSON.parse(options.body));return{accepted:true};}reads++;if(reads===1)await new Promise((resolve,reject)=>options.signal.addEventListener("abort",()=>reject(Error("unmounted")),{once:true}));return{items:[]};}});
 f.client.start(selected);f.client.stop();f.client.start(selected);await flush();assert.equal(reads,2);assert.deepEqual(posts,[{sequence:1,state:"active"}]);f.client.stop();
});
test("session denial stops reporting without automatic retries and server timing is bounded",async()=>{
 const denied=fixture({request:async()=>{throw Object.assign(Error("revoked"),{status:403});}});denied.client.start(selected);await flush();assert.equal(denied.scheduled.size,0);
 const timed=fixture({request:async(path,options={})=>options.method?{accepted:true,heartbeatSeconds:60}:{items:[]}});timed.client.start(selected);await flush();assert.equal([...timed.scheduled.values()][0].delay,60000);timed.client.stop();
});
test("only a previously verified paired scope reconnects and failed operational requests are never replayed",async()=>{
 let snapshot=active(),failed=false,reconnections=0;const bodies=[],timers=new Map();let timerId=0;
 const client=createSurfacePresenceClient({status:()=>snapshot,schedule:(fn,delay)=>{timers.set(++timerId,{fn,delay});return timerId;},cancel:id=>timers.delete(id),reconnect:async()=>{reconnections++;snapshot=active();},request:async(path,options={})=>{if(!failed){failed=true;snapshot=disconnected();throw Object.assign(Error("network lost"),{status:0});}if(options.body)bodies.push(JSON.parse(options.body));return options.method?{heartbeatSeconds:30}:{items:[]};}});
 client.start(selected);await flush();assert.equal([...timers.values()][0].delay,5000);const timer=[...timers.values()][0];timers.clear();timer.fn();await flush();assert.equal(reconnections,1);assert.deepEqual(bodies.map(row=>row.state),["active"]);client.stop();
 const noProof=fixture({status:disconnected,reconnect:async()=>{throw Error("must not reconnect an unverified scope");}});noProof.client.start(selected);await flush();assert.equal(noProof.states.some(row=>row.code==="TERMINAL_RECONNECT_UNAVAILABLE"),false);noProof.client.stop();
});
test("reconnect backoff is bounded and explicit logout cannot be undone by a late effect restart",async()=>{
 let snapshot=active(),reads=0;const timers=new Map(),delays=[];let id=0,reconnects=0;
 const client=createSurfacePresenceClient({status:()=>snapshot,schedule:(fn,delay)=>{delays.push(delay);timers.set(++id,fn);return id;},cancel:key=>timers.delete(key),request:async()=>{reads++;snapshot=disconnected();throw Object.assign(Error("offline"),{status:0});},reconnect:async()=>{reconnects++;throw Error("still offline");}});
 client.start(selected);await flush();for(let n=0;n<4;n++){const [key,fn]=timers.entries().next().value;timers.delete(key);fn();await flush();}
 assert.deepEqual(delays.slice(0,5),[5000,10000,30000,60000,60000]);assert.equal(reads,1);assert.equal(reconnects,4);await client.signedOut();client.start(selected);await client.tick();assert.equal(timers.size,0);assert.equal(reconnects,4);
});

test("only a verified native sign-in can reset logout, and resetting alone cannot send presence",async()=>{
 const f=fixture();f.client.start(selected);await flush();await f.client.signedOut();const previous=f.calls.length;
 f.setStatus({status:"offline",paired:true,context:null});assert.equal(f.client.resetAfterVerifiedSignIn(),false);f.client.start(selected);await flush();assert.equal(f.calls.length,previous);
 f.setStatus(active());assert.equal(f.client.resetAfterVerifiedSignIn(),true);await flush();assert.equal(f.calls.length,previous,"A verified reset alone is not a receiving application");
 f.client.start(selected);await flush();assert.equal(f.calls[previous].path,"/api/restaurant/orders/pending-confirmation?restaurantId=restaurant-a");assert.equal(f.calls.at(-1).parsed.state,"active");f.client.stop();
});
