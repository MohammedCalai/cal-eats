import test from "node:test";
import assert from "node:assert/strict";
import {createOrderingTerminalClient, installOrderingTerminalClient, isTerminalOperation, terminalOperation} from "../src/ordering-terminal-client.js";
import {api} from "../src/api.js";

const restaurantId="restaurant-123", terminalId="terminal-123", orderPath="/api/restaurant/orders/order-123/status";
const csrfToken="c".repeat(43);
const userProof="u".repeat(43);
function fixture({paired=true,registered=terminalId,visible=()=>true,proofReady=true,localReply=null}={}) {
  const calls=[], updates=[];let now=1000;
  const request=async(path,options={})=>{
    const body=options.body?JSON.parse(options.body):null;calls.push({via:"browser",path,body});
    if(path.endsWith("session-handoff"))return {terminalId:registered,handoffToken:"h".repeat(43)};
    if(path.endsWith("screen-challenge"))return {terminalId:registered,challenge:"s".repeat(43)};
    if(path.endsWith("pairing-code"))return {terminalId,code:"one-time-code",challenge:"p".repeat(43),expiresAt:new Date(now+60_000).toISOString()};
    return {registered:true,deviceId:registered,status:"online",isReady:true};
  };
  const fetchImpl=async(url,options)=>{
    const path=new URL(url).pathname,body=options.body?JSON.parse(options.body):null;calls.push({via:"local",path,body,headers:options.headers,credentials:options.credentials});
    if(localReply){const response=await localReply(path,options);if(response)return response;}
    let data;
    if(path==="/v1/bootstrap")return Response.json({product:"cal-eats-terminal",terminalId,paired,csrfToken});
    assert.equal(options.headers["X-Cal-Eats-CSRF"],csrfToken);
    if(path==="/v1/pair"){paired=true;data={paired:true,terminalId,restaurantId};}
    else if(path==="/v1/session")data={connected:true,userProof,expiresAt:new Date(now+3_600_000).toISOString()};
    else if(path==="/v1/screen-heartbeat")data={deviceId:terminalId,status:"online",isReady:proofReady};
    else if(path==="/v1/request")data=body.method==="GET"?{restaurantId,tablet:{status:"offline"}}:body.path.includes("/incidents/")?{read:true}:{order:{id:"order-123",status:body.body.status}};
    return Response.json({data});
  };
  const client=createOrderingTerminalClient({restaurantId,screenId:"ordering-screen-123",canProcess:true,request,fetchImpl,visible,clock:()=>now,onChange:value=>updates.push(value)});
  return {client,calls,updates,advance:ms=>{now+=ms;}};
}

test("ordinary browser never sends operational writes unsigned; management and messages stay ordinary",async()=>{
  assert.equal(isTerminalOperation(orderPath,"PATCH"),true);
  assert.equal(isTerminalOperation("/api/restaurant/restaurants/restaurant-123/printers/printer-123/test-receipt","POST"),true);
  assert.equal(isTerminalOperation("/api/restaurant/restaurants/restaurant-123/printers/printer-123/jobs/job-1234/check","POST"),true);
  for(const path of ["/api/restaurant/restaurants/restaurant-123/printers/printer-123","/api/restaurant/restaurants/restaurant-123/printers/printer-123/setup-package","/api/orders/order-123/messages","/api/restaurant/restaurants/restaurant-123/terminal/pairing-code"])assert.equal(isTerminalOperation(path,"POST"),false,path);
  const original=globalThis.fetch;let sent=0;globalThis.fetch=async()=>{sent++;throw new Error("Must not call unsigned API");};
  try{await assert.rejects(api(orderPath,{method:"PATCH",body:'{"status":"accepted"}'}),{code:"PAIRED_TERMINAL_REQUIRED"});assert.equal(sent,0);}finally{globalThis.fetch=original;}
});

test("matching local identity, one-use session and fresh screen proof are required before an order can be changed",async()=>{
  const f=fixture();assert.equal(f.client.canOperate(restaurantId),false);
  await f.client.connect();assert.equal(f.client.canOperate(restaurantId),true);assert.equal(f.client.canOperate("another-restaurant"),false);
  const remove=installOrderingTerminalClient(f.client);
  try{
    const result=await terminalOperation(orderPath,{method:"PATCH",body:'{"status":"accepted"}',headers:{"Idempotency-Key":"confirm-same-intent"}});
    assert.equal(result.order.status,"accepted");
    const forwarded=f.calls.find(c=>c.path==="/v1/request");
    assert.equal(forwarded.headers["X-Cal-Eats-User-Proof"],userProof);
    assert.equal(f.calls.find(c=>c.path==="/v1/screen-heartbeat").headers["X-Cal-Eats-User-Proof"],userProof);
    assert.deepEqual(forwarded.body,{method:"PATCH",path:orderPath,body:{status:"accepted"},idempotencyKey:"confirm-same-intent"});
    assert.equal(forwarded.credentials,"omit");
    assert.equal(f.calls.some(c=>c.via==="browser"&&c.path===orderPath),false);
    const serialised=JSON.stringify(f.client.getSnapshot());assert.doesNotMatch(serialised,/handoffToken|csrfToken|userProof|sessionToken|privateKey/);assert.equal(serialised.includes(userProof),false);
    f.advance(40_001);await assert.rejects(f.client.forward(orderPath,{method:"PATCH"}),{code:"PAIRED_TERMINAL_REQUIRED"});
    await f.client.pulse();assert.equal(f.client.canOperate(restaurantId),true);
  }finally{remove();f.client.dispose();}
});

test("a registered tablet somewhere else or an unready screen cannot enable this browser",async()=>{
  const mismatch=fixture({registered:"different-tablet"});await mismatch.client.connect();assert.equal(mismatch.client.canOperate(restaurantId),false);assert.equal(mismatch.calls.some(c=>c.path==="/v1/session"),false);mismatch.client.dispose();
  const unready=fixture({proofReady:false});await unready.client.connect();assert.equal(unready.client.canOperate(restaurantId),false);unready.client.dispose();
  const unpaired=fixture({paired:false});await unpaired.client.connect();assert.equal(unpaired.client.canOperate(restaurantId),false);assert.equal(unpaired.calls.some(c=>c.path.endsWith("session-handoff")),false);unpaired.client.dispose();
});

test("hidden/closed screens and delayed old-scope proofs cannot retain processing authority",async()=>{
  let showing=true,release;const f=fixture({visible:()=>showing});await f.client.connect();showing=false;
  assert.equal(f.client.canOperate(restaurantId),false);await f.client.pulse();assert.equal(f.client.getSnapshot().ready,false);f.client.dispose();
  const delayed=fixture({localReply:async path=>path==="/v1/screen-heartbeat"?await new Promise(resolve=>{release=resolve;}):null});
  const connecting=delayed.client.connect();while(!release)await new Promise(resolve=>setImmediate(resolve));const before=delayed.updates.length;
  delayed.client.dispose();release(Response.json({data:{deviceId:terminalId,isReady:true}}));
  await assert.rejects(connecting,{code:"TERMINAL_SCOPE_ENDED"});assert.equal(delayed.client.canOperate(restaurantId),false);assert.equal(delayed.updates.length,before);
});

test("pairing response loss retries the same one-use intent instead of generating a new Windows identity",async()=>{
  let attempts=0;const f=fixture({paired:false,localReply:async path=>{if(path==="/v1/pair"&&++attempts===1)throw new Error("response lost");return null;}});
  await assert.rejects(f.client.pair({deviceName:"Kitchen tablet"}));
  await f.client.pair({deviceName:"Kitchen tablet"});assert.equal(f.calls.filter(c=>c.path.endsWith("pairing-code")).length,1);
  assert.deepEqual(f.calls.filter(c=>c.path==="/v1/pair").map(c=>c.body.terminalId),[terminalId,terminalId]);assert.equal(f.client.canOperate(restaurantId),true);f.client.dispose();
});

test("paired diagnostic reads survive a stale screen without enabling processing or arbitrary reads",async()=>{
  const f=fixture(),path=`/api/restaurant/restaurants/${restaurantId}/operations-health`;
  assert.equal(f.client.canReadHealth(restaurantId),false);await assert.rejects(f.client.forward(path,{method:"GET"}),{code:"PAIRED_TERMINAL_REQUIRED"});
  await f.client.connect();f.advance(61000);
  assert.equal(f.client.canOperate(restaurantId),false);assert.equal(f.client.canReadHealth(restaurantId),true);
  assert.equal((await f.client.forward(path,{method:"GET"})).restaurantId,restaurantId);
  const forwarded=f.calls.filter(call=>call.path==="/v1/request").at(-1);assert.deepEqual(forwarded.body,{method:"GET",path});
  assert.equal(Object.hasOwn(forwarded.body,"body"),false,"A diagnostic GET must not request JSON body signing");
  assert.equal(f.calls.some(call=>call.via==="browser"&&call.path===path),false);
  for(const target of [path+"?scope=all","/api/restaurant/restaurants/another-restaurant/operations-health",`/api/restaurant/restaurants/${restaurantId}/finance/stripe/banking`])await assert.rejects(f.client.forward(target,{method:"GET"}),{code:"PAIRED_TERMINAL_REQUIRED"});
  await assert.rejects(f.client.forward(path,{method:"GET",body:"{}"}),{code:"TERMINAL_BODY_INVALID"});
  assert.equal((await f.client.forward("/api/restaurant/incidents/incident-123/read",{method:"PATCH",body:'{"read":true}'})).read,true);
  await assert.rejects(f.client.forward(orderPath,{method:"PATCH",body:'{"status":"accepted"}'}),{code:"PAIRED_TERMINAL_REQUIRED"});
  f.advance(3_600_000);assert.equal(f.client.canReadHealth(restaurantId),false);await assert.rejects(f.client.forward(path,{method:"GET"}),{code:"PAIRED_TERMINAL_REQUIRED"});f.client.dispose();
});

test("an old setup without a browser USER proof fails closed before its first screen pulse",async()=>{
  const f=fixture({localReply:async path=>path==="/v1/session"?Response.json({data:{connected:true,expiresAt:new Date(3_601_000).toISOString()}}):null});
  await assert.rejects(f.client.connect(),{code:"TERMINAL_SESSION_INVALID"});
  assert.equal(f.client.canOperate(restaurantId),false);assert.equal(f.client.canReadHealth(restaurantId),false);
  assert.equal(f.calls.some(call=>call.path==="/v1/screen-heartbeat"),false);
  const attempts=f.calls.length;await f.client.pulse();assert.equal(f.calls.length,attempts,"A missing proof requires an explicit reconnect, not an automatic handoff loop");f.client.dispose();
});

test("a lost session response discards the old browser proof and requires a new explicit handoff",async()=>{
  let exchanges=0;const f=fixture({localReply:async path=>{if(path==="/v1/session"&&++exchanges===2)throw new Error("Connection lost after the handoff was consumed");return null;}});
  await f.client.connect();await assert.rejects(f.client.connect(),{code:"TERMINAL_LOCAL_UNAVAILABLE"});
  assert.equal(f.client.canReadHealth(restaurantId),false);assert.equal(f.client.getSnapshot().sessionVerified,false);
  await f.client.pulse();assert.equal(exchanges,2,"An ambiguous response must not silently reuse or replace an operator grant");
  await f.client.connect();assert.equal(exchanges,3);assert.equal(f.client.canOperate(restaurantId),true);f.client.dispose();
  const cleanup=f.calls.at(-1);assert.equal(cleanup.path,"/v1/disconnect");assert.equal(cleanup.headers["X-Cal-Eats-User-Proof"],userProof);
});

test("a rejected stale browser proof cannot automatically reclaim the shared tablet from another operator",async()=>{
  let rejected=false;const f=fixture({localReply:async path=>path==="/v1/request"&&rejected?Response.json({error:{code:"LOCAL_USER_PROOF_REQUIRED",message:"Another operator has connected"}},{status:403}):null});
  await f.client.connect();rejected=true;await assert.rejects(f.client.forward(orderPath,{method:"PATCH",body:'{"status":"accepted"}'}),{code:"LOCAL_USER_PROOF_REQUIRED"});
  assert.equal(f.client.canReadHealth(restaurantId),false);const handoffs=f.calls.filter(call=>call.path.endsWith("session-handoff")).length;
  await f.client.pulse();assert.equal(f.calls.filter(call=>call.path.endsWith("session-handoff")).length,handoffs);
  rejected=false;await f.client.connect();assert.equal(f.client.canOperate(restaurantId),true);f.client.dispose();
});

test("a definitely superseded one-use handoff gets only one retry from this browser's authenticated session",async()=>{
  let exchanges=0;const f=fixture({localReply:async path=>path==="/v1/session"&&++exchanges===1?Response.json({error:{code:"TERMINAL_HANDOFF_INVALID",message:"Handoff replaced"}},{status:403}):null});
  await f.client.connect();assert.equal(exchanges,2);assert.equal(f.calls.filter(call=>call.path.endsWith("session-handoff")).length,2);assert.equal(f.client.canOperate(restaurantId),true);f.client.dispose();
  let rejected=0;const invalid=fixture({localReply:async path=>{if(path!=="/v1/session")return null;rejected++;return Response.json({error:{code:"TERMINAL_HANDOFF_INVALID",message:"Handoff rejected"}},{status:403});}});
  await assert.rejects(invalid.client.connect(),{code:"TERMINAL_HANDOFF_INVALID"});assert.equal(rejected,2);invalid.client.dispose();
});
