import test from "node:test";
import assert from "node:assert/strict";
import {createHash,randomBytes,sign} from "node:crypto";
import {businessDeviceFixture} from "../../api/test/business-device-fixture.js";
import {TerminalClient} from "../src/terminal-client.js";
import {createCompanionServer} from "../src/terminal-companion.js";
import {createOrderingTerminalClient} from "../../portal/src/ordering-terminal-client.js";

const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const hash=value=>createHash("sha256").update(value).digest("hex");
async function fixture(){
  let captures=0,signGate=null,fetchGate=null,sessionResponseFault=null;
  const f=await businessDeviceFixture({withPrinter:false,mockCapture:()=>{captures++;return {ok:true};}}),root=`/api/restaurant/restaurants/${f.restaurant.id}`;
  const staffEmail="browser-isolation-staff@example.invalid",password="BrowserIsolation!4310";
  const staffCreated=await f.json(`${root}/staff`,{method:"POST",cookie:f.owner,body:{name:"Browser A operator",email:staffEmail,password}});assert.equal(staffCreated.status,201,staffCreated.text);
  const cookieA=await f.login(staffEmail,password),cookieB=f.owner,customer=await f.login("customer@calai.local","LocalCustomer!4310"),userA=f.db.prepare("SELECT id FROM users WHERE email=?").get(staffEmail).id,userB=f.db.prepare("SELECT id FROM users WHERE email='restaurant@calai.local'").get().id;
  const cloudCalls=[],gates=[];
  const cloudFetch=async(url,options)=>{
    const target=url.pathname+url.search,headers=Object.fromEntries(new Headers(options.headers)),grant=headers["x-cal-eats-terminal-session"],userId=grant?f.db.prepare("SELECT user_id FROM ordering_terminal_sessions WHERE token_hash=?").get(hash(grant))?.user_id:null;
    const call={path:target,method:options.method,userId};cloudCalls.push(call);
    const responseFault=target.endsWith("/session")?sessionResponseFault:null;if(responseFault)sessionResponseFault=null;
    if(fetchGate?.match(call)){const gate=fetchGate;fetchGate=null;gate.started.resolve();await gate.release.promise;}
    const response=await f.request(target,{method:options.method,headers,...(options.body===undefined?{}:{body:JSON.parse(options.body)})});
    if(responseFault&&response.status<400){if(responseFault==="network")throw Error("Synthetic lost handoff response");return new Response(JSON.stringify({data:{}}),{status:response.status,headers:{"content-type":"application/json"}});}
    return new Response(response.bodyBuffer,{status:response.status,headers:Object.fromEntries(response.headers)});
  };
  const terminal=new TerminalClient({baseUrl:f.config.origin,identityPath:"unused-synthetic-terminal.json",clock:()=>f.config.now().getTime(),fetchImpl:cloudFetch,keyFactory:()=>({sign:async canonical=>{if(signGate?.match(canonical)){const gate=signGate;signGate=null;gate.started.resolve();await gate.release.promise;}return sign("sha256",Buffer.from(canonical),{key:f.keys.privateKey,dsaEncoding:"ieee-p1363"}).toString("base64url");}})});
  // Enrollment was completed through the actual API by businessDeviceFixture;
  // the adapter uses only that isolated synthetic identity/key, never Windows CNG.
  terminal.identity={schemaVersion:1,product:"cal-eats-terminal",terminalId:f.terminalId,restaurantId:f.restaurant.id,publicKeySpki:f.keys.publicKey.export({type:"spki",format:"der"}).toString("base64"),paired:true};
  const server=createCompanionServer({client:terminal,port:0,allowedOrigins:[f.config.origin]});await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const localOrigin=`http://127.0.0.1:${server.address().port}`,proofs=new Map(),clients=[];
  async function localFetch(label,url,options={}){
    const target=new URL(url);assert.equal(target.origin,"http://127.0.0.1:17863");const headers=new Headers(options.headers);headers.set("Origin",f.config.origin);
    const response=await fetch(localOrigin+target.pathname,{...options,headers});
    if(target.pathname==="/v1/session"&&response.ok){const payload=await response.clone().json();proofs.set(label,payload.data?.userProof);}
    return response;
  }
  const browser=(label,cookie)=>{
    const request=async(path,options={})=>{const response=await f.json(path,{method:options.method??"GET",cookie,headers:{Origin:f.config.origin,...options.headers},...(options.body===undefined?{}:{body:JSON.parse(options.body)})});if(response.status>=400)throw Object.assign(Error(response.body.error.message),{status:response.status,code:response.body.error.code});return response.body.data;};
    const client=createOrderingTerminalClient({restaurantId:f.restaurant.id,screenId:randomBytes(18).toString("base64url"),canProcess:true,request,fetchImpl:(url,options)=>localFetch(label,url,options),clock:()=>f.config.now().getTime(),visible:()=>true});clients.push(client);return client;
  };
  const a=browser("a",cookieA),b=browser("b",cookieB),health=`${root}/operations-health`;
  const bootstrap=await fetch(localOrigin+"/v1/bootstrap",{headers:{Origin:f.config.origin}}).then(response=>response.json());
  const raw=async(path,body,proof)=>{const response=await fetch(localOrigin+path,{method:"POST",headers:{Origin:f.config.origin,"Content-Type":"application/json","X-Cal-Eats-CSRF":bootstrap.csrfToken,...(proof?{"X-Cal-Eats-User-Proof":proof}:{})},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const gate=(kind,match)=>{const value={match,started:deferred(),release:deferred()};gates.push(value);if(kind==="sign")signGate=value;else fetchGate=value;return value;};
  const place=async()=>{const item=f.db.prepare("SELECT id FROM menu_items WHERE restaurant_id=? AND available=1 LIMIT 1").get(f.restaurant.id),response=await f.json("/api/orders",{method:"POST",cookie:customer,headers:{"Idempotency-Key":randomBytes(16).toString("hex")},body:{restaurantId:f.restaurant.id,items:[{menuItemId:item.id,quantity:1}],fulfillment:"collection",paymentMethod:"mock_card"}});assert.equal(response.status,201,response.text);return response.body.data;};
  return {...f,root,terminal,server,a,b,browser,raw,bootstrap,proofs,health,cloudCalls,gate,place,userA,userB,cookieA,cookieB,failNextSessionResponse:kind=>{sessionResponseFault=kind;},captures:()=>captures,async close(){for(const value of gates)value.release.resolve();for(const client of clients)client.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await f.close();}};
}
const started=(gate,pending)=>Promise.race([gate.started.promise,pending.then(()=>{throw Error("The guarded operation completed before reaching the intended race");})]);

test("same-origin bootstrap/CSRF and stale browser proofs cannot borrow another USER or disconnect it",async()=>{
  const f=await fixture();try{
    await f.a.connect();const oldProof=f.proofs.get("a");assert.match(oldProof,/^[A-Za-z0-9_-]{43}$/);await f.b.connect();const currentProof=f.proofs.get("b");assert.notEqual(oldProof,currentProof);assert.equal(f.bootstrap.userProof,undefined);
    const order=await f.place(),path=`/api/restaurant/orders/${order.id}/status`;
    assert.equal((await f.raw("/v1/request",{method:"PATCH",path,body:{status:"accepted"}})).status,403);
    assert.equal((await f.raw("/v1/screen-heartbeat",{screenId:"untrusted-browser",challenge:randomBytes(24).toString("base64url")})).status,403);
    assert.equal((await f.raw("/v1/disconnect",{})).status,403);
    const noCookie=f.browser("anonymous",undefined);await assert.rejects(noCookie.connect(),error=>error.status===401);
    const customer=await f.login("customer@calai.local","LocalCustomer!4310"),customerBrowser=f.browser("customer",customer);await assert.rejects(customerBrowser.connect(),error=>error.status===403);
    assert.equal((await f.raw("/v1/session",{terminalId:f.terminalId,handoffToken:randomBytes(32).toString("base64url")})).status,401,"A definite invalid handoff cannot clear the currently connected USER");
    assert.equal((await f.raw("/v1/disconnect",{},oldProof)).status,403);assert.equal((await f.raw("/v1/request",{method:"GET",path:f.health},oldProof)).status,403);
    await assert.rejects(f.a.forward(path,{method:"PATCH",body:JSON.stringify({status:"accepted"})}),error=>[401,403].includes(error.status));
    assert.equal(f.captures(),0);assert.equal(f.db.prepare("SELECT status FROM orders WHERE id=?").get(order.id).status,"placed");
    assert.equal((await f.b.forward(f.health)).restaurantId,f.restaurant.id);
    await f.b.forward(path,{method:"PATCH",body:JSON.stringify({status:"accepted"})});assert.equal(f.captures(),1);assert.equal(f.db.prepare("SELECT actor_user_id FROM order_events WHERE order_id=? AND to_status='accepted'").get(order.id).actor_user_id,f.userB);
    f.a.dispose();await new Promise(resolve=>setTimeout(resolve,0));assert.equal((await f.b.forward(f.health)).restaurantId,f.restaurant.id);
  }finally{await f.close();}
});

test("a USER request paused inside signing cannot dispatch later using the replacement USER grant",async()=>{
  const f=await fixture();try{
    await f.a.connect();const order=await f.place(),path=`/api/restaurant/orders/${order.id}/status`,gate=f.gate("sign",canonical=>canonical.includes(`\nPATCH\n${path}\n`));
    const old=f.a.forward(path,{method:"PATCH",body:JSON.stringify({status:"accepted"})});await started(gate,old);await f.b.connect();gate.release.resolve();
    await assert.rejects(old,error=>[401,403].includes(error.status));assert.equal(f.cloudCalls.filter(call=>call.path===path).length,0,"Reject changed local authority before sending the old operation");
    assert.equal(f.captures(),0);assert.equal((await f.b.forward(f.health)).restaurantId,f.restaurant.id);
  }finally{await f.close();}
});

test("late rejection of an old USER fetch cannot clear the newly connected USER",async()=>{
  const f=await fixture();try{
    await f.a.connect();const gate=f.gate("fetch",call=>call.path===f.health&&call.userId===f.userA),old=f.a.forward(f.health);await started(gate,old);
    await f.b.connect();gate.release.resolve();await assert.rejects(old,error=>[401,403].includes(error.status));
    assert.equal((await f.b.forward(f.health)).restaurantId,f.restaurant.id,"The old response must not erase the replacement in-memory grant");
  }finally{await f.close();}
});

test("a superseded handoff paused during signing cannot revoke a newer USER session on the backend",async()=>{
  const f=await fixture();try{
    await f.b.connect();const sessionPath=`/api/terminal-devices/${f.terminalId}/session`,before=f.cloudCalls.filter(call=>call.path===sessionPath).length,gate=f.gate("sign",canonical=>canonical.includes(`\nPOST\n${sessionPath}\n`));
    const old=f.a.connect();await started(gate,old);await f.b.connect();gate.release.resolve();await assert.rejects(old);
    assert.equal(f.cloudCalls.filter(call=>call.path===sessionPath).length,before+1,"Only the newer handoff may reach the backend after it supersedes the old signing intent");
    assert.equal((await f.b.forward(f.health)).restaurantId,f.restaurant.id);
  }finally{await f.close();}
});

test("a stale handoff rejected after a newer login cannot automatically retry and reclaim its USER session",async()=>{
  const f=await fixture();try{
    await f.b.connect();const sessionPath=`/api/terminal-devices/${f.terminalId}/session`,gate=f.gate("fetch",call=>call.path===sessionPath);
    const old=f.a.connect();await started(gate,old);await f.b.connect();gate.release.resolve();
    await assert.rejects(old,error=>error.code==="LOCAL_USER_SESSION_CHANGED");
    assert.equal((await f.b.forward(f.health)).restaurantId,f.restaurant.id,"An old in-flight browser cannot reclaim the newer operator through the fresh-handoff retry");
  }finally{await f.close();}
});

for(const responseFault of ["network","malformed"]){
  test(`a ${responseFault} successful handoff response requires explicit reconnect and exposes no old USER authority`,async()=>{
    const f=await fixture();try{
      await f.b.connect();const oldProof=f.proofs.get("b"),sessionPath=`/api/terminal-devices/${f.terminalId}/session`,before=f.cloudCalls.filter(call=>call.path===sessionPath).length;
      f.failNextSessionResponse(responseFault);
      await assert.rejects(f.a.connect(),error=>error.code==="TERMINAL_HANDOFF_UNCERTAIN");
      assert.equal(f.cloudCalls.filter(call=>call.path===sessionPath).length,before+1,"An ambiguous consumed handoff must never auto-retry");
      assert.equal(f.terminal.session,null);assert.equal((await f.raw("/v1/request",{method:"GET",path:f.health},oldProof)).status,403);
      await f.b.connect();assert.notEqual(f.proofs.get("b"),oldProof);assert.equal((await f.b.forward(f.health)).restaurantId,f.restaurant.id);
    }finally{await f.close();}
  });
}

test("local proxy proof does not override current backend processing permission or original-session logout",async()=>{
  const f=await fixture();try{
    await f.a.connect();assert.equal((await f.a.forward(f.health)).restaurantId,f.restaurant.id);
    const update=await f.json(`${f.root}/staff/${f.userA}/capabilities`,{method:"PATCH",cookie:f.owner,body:{canProcessOrders:false}});assert.equal(update.status,200,update.text);
    await assert.rejects(f.a.forward(f.health),error=>error.status===403);
    await f.json(`${f.root}/staff/${f.userA}/capabilities`,{method:"PATCH",cookie:f.owner,body:{canProcessOrders:true}});await f.a.connect();
    assert.equal((await f.json("/api/auth/logout",{method:"POST",cookie:f.cookieA,body:{}})).status,200);await assert.rejects(f.a.forward(f.health),error=>error.status===401);
    await f.b.connect();assert.equal((await f.json(`${f.root}/terminal/revoke`,{method:"POST",cookie:f.owner,body:{}})).status,200);await assert.rejects(f.b.forward(f.health),error=>error.status===403);
  }finally{await f.close();}
});
