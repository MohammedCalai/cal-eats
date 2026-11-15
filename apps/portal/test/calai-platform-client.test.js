import test from "node:test";
import assert from "node:assert/strict";
import {createCalaiMutationClient} from "../src/calai-platform-client.js";
const id="a1111111-1111-4111-8111-111111111111",path=`/tenants/${id}`,requestId="b2222222-2222-4222-8222-222222222222";
const success=()=>Response.json({data:{name:"Updated"},meta:{source:"calai",requestId,state:"confirmed"}});
test("confirmed changes use a same-origin cookie and stable intent key rather than forwarding upstream credentials",async()=>{
 const calls=[],client=createCalaiMutationClient({createKey:()=>"stable-admin-intent",fetchImpl:async(url,options)=>{calls.push({url,...options});return success();}});
 await client.send(path,"PATCH",{name:"Updated"});await client.send(path,"PATCH",{name:"Updated"});
 assert.equal(calls[0].url,`/api/admin/calai${path}`);assert.equal(calls[0].credentials,"include");assert.equal(calls[0].redirect,"error");
 assert.equal(calls[0].headers["Idempotency-Key"],calls[1].headers["Idempotency-Key"]);assert.equal(Object.keys(calls[0].headers).some(key=>/authorization|token|password/i.test(key)),false);
});
test("uncertain and in-progress responses block resending even when the form is changed",async()=>{
 for(const code of ["CALAI_MUTATION_UNCERTAIN","CALAI_MUTATION_IN_PROGRESS","CALAI_MUTATION_REVIEWED"]){let calls=0;const client=createCalaiMutationClient({fetchImpl:async()=>{calls++;return Response.json({error:{code,message:"Not confirmed",details:{requestId}},meta:{requestId,state:"unknown"}},{status:409});}});
 await assert.rejects(client.send(path,"PATCH",{name:"First"}),error=>error.code===code&&error.requestId===requestId);
 await assert.rejects(client.send(path,"PATCH",{name:"Changed"}),{code});assert.equal(calls,1);}
});
test("lost or malformed responses cannot turn into a second upstream mutation",async()=>{
 for(const fetchImpl of [async()=>{throw Error("response lost");},async()=>new Response("invalid JSON",{status:200}),async()=>Response.json({data:{name:"No confirmed metadata"}})]){
  let calls=0;const client=createCalaiMutationClient({createKey:()=>"calai-lost-response-intent",fetchImpl:async(...args)=>{calls++;return fetchImpl(...args);}});
  await assert.rejects(client.send(path,"PATCH",{name:"Updated"}),error=>error.code==="CALAI_MUTATION_UNCERTAIN"&&error.requestKey==="calai-lost-response-intent");await assert.rejects(client.send(path,"PATCH",{name:"Updated"}),{code:"CALAI_MUTATION_UNCERTAIN"});assert.equal(calls,1);
 }
});
test("definite validation rejection permits a corrected new intent and duplicate in-flight clicks share one request",{timeout:5000},async()=>{
 let key=0,release,calls=[];const client=createCalaiMutationClient({createKey:()=>`intent-${++key}`,fetchImpl:async(_url,options)=>{calls.push(options);if(calls.length===1)return Response.json({error:{code:"CALAI_FILTER_INVALID",message:"Name required"}},{status:400});return await new Promise(resolve=>{release=()=>resolve(success());});}});
 await assert.rejects(client.send(path,"PATCH",{name:""}),{code:"CALAI_FILTER_INVALID"});
 const first=client.send(path,"PATCH",{name:"Corrected"}),duplicate=client.send(path,"PATCH",{name:"Corrected"});while(!release)await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,2);assert.notEqual(calls[0].headers["Idempotency-Key"],calls[1].headers["Idempotency-Key"]);release();await Promise.all([first,duplicate]);assert.equal(calls.length,2);
});
test("file uploads use only fixed JSON upload routes and cannot dispatch after the administrator view closes",async()=>{
 let active=true,calls=0;const client=createCalaiMutationClient({beforeDispatch:()=>{if(!active)throw Object.assign(Error("Closed"),{code:"CALAI_VIEW_CLOSED",status:403});},fetchImpl:async()=>{calls++;return success();}});
 const pending=client.send("/agent/create","POST",{fields:{businessId:id,agent_name:"Selected agent"},files:[]});active=false;await assert.rejects(pending,{code:"CALAI_VIEW_CLOSED"});assert.equal(calls,0);
 for(const [target,method]of [["/agent/create","POST"],["/agent/upload-special-offers","POST"],["/settings/logo","PATCH"]]){active=true;await client.send(target,method,{fields:{},files:[]});}
 assert.equal(calls,3);await assert.rejects(client.send("/settings/logo","POST",{fields:{},files:[]}),{code:"CALAI_ROUTE_NOT_ALLOWED"});
});
test("mutation transport cannot target an external origin or unrelated API",async()=>{
 let calls=0;const client=createCalaiMutationClient({fetchImpl:async()=>{calls++;return success();}});
 for(const target of ["https://api.calai.info/system-owner/tenants","/auth/login","/tenants/../../auth/login","/telephony?redirect=1",`/tenants/${id}/impersonate`])await assert.rejects(client.send(target,"POST",{}),{code:"CALAI_ROUTE_NOT_ALLOWED"});
 assert.equal(calls,0);
});
