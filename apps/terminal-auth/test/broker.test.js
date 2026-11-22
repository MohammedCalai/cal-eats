import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {TerminalDevice} from "../src/device.js";
import {createBrokerServer} from "../src/broker.js";
import {requestAllowed,requestCanonical} from "../src/protocol.js";
const terminalId="b2222222-2222-4222-8222-222222222222",businessId="a1111111-1111-4111-8111-111111111111",restaurantId="c3333333-3333-4333-8333-333333333333",userId="d4444444-4444-4444-8444-444444444444",screenId="e5555555-5555-4555-8555-555555555555";
const code="one-use-printer-device-code",challenge="c".repeat(43),token="s".repeat(43);
test('terminal transport excludes native call-summary side effects and source financial analytics',()=>{
  for(const target of ['/api/business/calai/calls','/api/business/calai/analytics','/api/business/calai/billing-history','/api/business/calai/my-subscription'])assert.equal(requestAllowed('GET',target,restaurantId,businessId),false);
  for(const target of ['/api/business/calai/orders','/api/business/calai/hours'])assert.equal(requestAllowed('GET',target,restaurantId,businessId),true);
});
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"calai-terminal-auth-"));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const keys=crypto.generateKeyPairSync("ec",{namedCurve:"prime256v1"}),publicKeySpki=keys.publicKey.export({type:"spki",format:"der"}).toString("base64");
  const keyFactory=()=>({publicKey:async()=>({publicKeySpki}),sign:async canonical=>crypto.sign("sha256",Buffer.from(canonical),{key:keys.privateKey,dsaEncoding:"ieee-p1363"}).toString("base64url")});
  const calls=[];let now=Date.parse("2026-11-17T16:00:00Z"),revoke=false,grantOverrides={},grantNumber=0,loseSignOutAcknowledgement=false;
  const fetchImpl=async(url,options)=>{
    calls.push({url:String(url),...options});
    let data={ok:true};
    if(url.pathname==="/api/terminal-devices/pair")data={terminalId,businessId};
    else{
      const h=options.headers;
      assert.equal(h["X-Cal-Eats-Terminal-Id"],terminalId);
      const canonical=requestCanonical({terminalId,timestamp:h["X-Cal-Eats-Terminal-Timestamp"],nonce:h["X-Cal-Eats-Terminal-Nonce"],method:options.method,target:url.pathname+url.search,body:options.body||""});
      assert.ok(crypto.verify("sha256",Buffer.from(canonical),{key:keys.publicKey,dsaEncoding:"ieee-p1363"},Buffer.from(h["X-Cal-Eats-Terminal-Signature"],"base64url")));
      if(revoke)return new Response(JSON.stringify({error:{code:"TERMINAL_REVOKED",message:"private server text"}}),{status:403});
      if(url.pathname.endsWith("/operator-session")){grantNumber++;data={terminalId,businessId,restaurantId,user:{id:userId,name:"Restaurant tablet",role:"restaurant",secret:"never expose"},principalKind:"terminal",products:{calai:{active:true,linked:true,token:"never expose"},"cal-eats":{active:true}},token:grantNumber===1?token:crypto.createHash("sha256").update("synthetic-grant-"+grantNumber).digest("base64url"),expiresAt:new Date(now+1800000).toISOString(),...grantOverrides};}
      if(loseSignOutAcknowledgement&&url.pathname===`/api/business/accounts/${businessId}/surface/heartbeat`&&JSON.parse(options.body).state==="signed_out")throw new TypeError("Synthetic connection loss after server logout");
    }
    return new Response(JSON.stringify({data}),{status:200,headers:{"content-type":"application/json"}});
  };
  const identityPath=path.join(directory,"identity.json"),device=await new TerminalDevice({identityPath,apiBaseUrl:"http://127.0.0.1:4310",fetchImpl,keyFactory,clock:()=>now}).load();
  return {device,calls,directory,identityPath,keyFactory,fetchImpl,setNow:value=>{now=value;},getNow:()=>now,revoke:()=>{revoke=true;},grantOverrides:value=>{grantOverrides=value;},loseSignOutAcknowledgement:()=>{loseSignOutAcknowledgement=true;},enrol:()=>device.enrol({terminalId,businessId,code,challenge,deviceName:"Registered tablet"})};
}
test("registered tablet restarts with its protected key but never stores a server grant, pairing code or user proof",async t=>{
  const f=await fixture(t);await f.enrol();
  const session=await f.device.automaticSession({screenId});
  assert.equal(session.principalKind,"terminal");assert.equal(session.user.role,"restaurant");assert.equal(session.user.secret,undefined);assert.equal(session.products.calai.token,undefined);
  assert.equal(session.token,undefined);assert.equal(session.screenId,screenId);
  const disk=await fs.readFile(f.identityPath,"utf8");
  for(const secret of [token,code,session.windowProof])assert.ok(!disk.includes(secret));
  const restarted=await new TerminalDevice({identityPath:f.identityPath,apiBaseUrl:"http://127.0.0.1:4310",fetchImpl:f.fetchImpl,keyFactory:f.keyFactory,clock:f.getNow}).load();
  assert.equal(restarted.bootstrap().paired,true);assert.equal(restarted.grant,null);assert.equal(restarted.windows.size,0);
  const resumed=await restarted.automaticSession({screenId});assert.equal(resumed.businessId,businessId);assert.notEqual(resumed.windowProof,session.windowProof);
});
test("automatic grant is deduplicated, renewed and signed; only bounded Idempotency-Key reaches the server",async t=>{
  const f=await fixture(t);await f.enrol();
  const sessions=await Promise.all([f.device.automaticSession({screenId}),f.device.automaticSession({screenId:"f6666666-6666-4666-8666-666666666666"})]);
  assert.equal(f.calls.filter(c=>c.url.endsWith("/operator-session")).length,1);
  const jobPath="/api/restaurant/orders/12345678-1234-4123-8123-123456789abc/status";
  await f.device.forward({method:"PATCH",path:jobPath,body:{status:"confirmed"},headers:{"Idempotency-Key":"test-order-command-01"}},{windowProof:sessions[0].windowProof});
  const request=f.calls.at(-1);assert.equal(request.headers["X-Cal-Eats-Terminal-Session"],token);assert.equal(request.headers["Idempotency-Key"],"test-order-command-01");assert.equal(request.headers.Cookie,undefined);assert.equal(request.headers.Authorization,undefined);
  await f.device.forward({method:"GET",path:"/api/auth/me",body:null},{windowProof:sessions[0].windowProof});assert.equal(f.calls.at(-1).body,undefined);
  f.setNow(f.getNow()+1740001);await f.device.forward({method:"GET",path:"/api/business/context"},{windowProof:sessions[0].windowProof});
  assert.equal(f.calls.filter(c=>c.url.endsWith("/operator-session")).length,2);
  assert.equal(new Set(f.calls.filter(c=>c.headers["X-Cal-Eats-Terminal-Nonce"]).map(c=>c.headers["X-Cal-Eats-Terminal-Nonce"])).size,f.calls.length-1);
});

for(const uncertain of [false,true])test(`Surface logout clears the native grant ${uncertain?"even when its acknowledgement is lost":"after confirmation"}; reopening requires a fresh grant, not reenrolment`,async t=>{
  const f=await fixture(t);await f.enrol();const first=await f.device.automaticSession({screenId});
  const originalIdentity=await fs.readFile(f.identityPath,"utf8");
  const path=`/api/business/accounts/${businessId}/surface/heartbeat`;
  await f.device.forward({method:"POST",path,body:{sequence:1,state:"active"}},{windowProof:first.windowProof});
  assert.equal(f.device.grant.token,token);
  if(uncertain)f.loseSignOutAcknowledgement();
  const signOut=()=>f.device.forward({method:"POST",path,body:{sequence:2,state:"signed_out"}},{windowProof:first.windowProof});
  if(uncertain)await assert.rejects(signOut,e=>e.code==="TABLET_NETWORK_UNAVAILABLE");else await signOut();
  assert.equal(f.device.grant,null);assert.equal(f.device.windows.size,0);
  assert.equal(f.device.bootstrap().paired,true);assert.equal(f.device.bootstrap().revoked,false);
  await assert.rejects(f.device.forward({method:"GET",path:"/api/auth/me"},{windowProof:first.windowProof}),e=>e.code==="TABLET_WINDOW_PROOF_REQUIRED");
  const resumed=await f.device.automaticSession({screenId});
  assert.notEqual(resumed.windowProof,first.windowProof);assert.notEqual(f.device.grant.token,token);
  await f.device.forward({method:"POST",path,body:{sequence:1,state:"active"}},{windowProof:resumed.windowProof});
  assert.equal(f.calls.filter(call=>call.url.endsWith("/operator-session")).length,2);
  assert.equal(f.calls.filter(call=>call.url.endsWith("/pair")).length,1);
  assert.equal(await fs.readFile(f.identityPath,"utf8"),originalIdentity);
});
test("unpaired, foreign-business and elevated user grants cannot become terminal sessions",async t=>{
  const f=await fixture(t);
  await assert.rejects(f.device.automaticSession({screenId}),e=>e.code==="TABLET_NOT_ENROLLED");
  await f.enrol();f.grantOverrides({businessId:"11111111-1111-4111-8111-111111111111"});
  await assert.rejects(f.device.automaticSession({screenId}),e=>e.code==="TABLET_SESSION_RESPONSE_INVALID");
  f.grantOverrides({user:{id:userId,role:"admin"}});await assert.rejects(f.device.automaticSession({screenId}),e=>e.code==="TABLET_SESSION_RESPONSE_INVALID");
  assert.equal(f.device.grant,null);
});
test("revocation clears every local window proof and keeps identity for owner-controlled replacement",async t=>{
  const f=await fixture(t);await f.enrol();const session=await f.device.automaticSession({screenId});f.revoke();
  await assert.rejects(f.device.forward({method:"GET",path:"/api/business/context"},{windowProof:session.windowProof}),e=>e.code==="TERMINAL_REVOKED");
  assert.equal(f.device.grant,null);assert.equal(f.device.windows.size,0);assert.equal(f.device.bootstrap().revoked,true);assert.equal(f.device.bootstrap().terminalId,terminalId);
  await assert.rejects(f.device.automaticSession({screenId}),e=>e.code==="TERMINAL_REVOKED");
  await assert.rejects(f.device.enrol({terminalId:"11111111-1111-4111-8111-111111111111",code,challenge,deviceName:"Replacement"}),e=>e.code==="TABLET_LOCAL_REPLACEMENT_REQUIRED");
});
test("request allowlist rejects owner/admin/auth commands, arbitrary paths, malformed JSON and browser headers",async t=>{
  const f=await fixture(t);await f.enrol();const session=await f.device.automaticSession({screenId});
  for(const target of ["/api/admin/restaurants","/api/restaurant/restaurants/"+restaurantId+"/bank-details","/api/business/calai/agents","/api/business/calai/settings","/api/auth/logout","https://eats.calai.info/api/auth/me","/api/business/../auth/me","/api/%61uth/me","/api/auth/me#x","/api/auth/me?token=private"])assert.equal(requestAllowed("GET",target,restaurantId),false,target);
  for(const headers of [{Authorization:"Bearer secret"},{Cookie:"private"},{"Idempotency-Key":"bad\nkey"}])await assert.rejects(f.device.forward({method:"GET",path:"/api/auth/me",headers},{windowProof:session.windowProof}));
  await assert.rejects(f.device.forward({method:"GET",path:"/api/auth/me"},{windowProof:"x".repeat(43)}),e=>e.code==="TABLET_WINDOW_PROOF_REQUIRED");
  await assert.rejects(f.device.forward({method:"PATCH",path:"/api/restaurant/orders/12345678/status",body:{n:NaN}},{windowProof:session.windowProof}),e=>e.code==="TABLET_BODY_INVALID");
});
test("loopback broker enforces exact Origin, Host, per-process CSRF and per-window proofs with no generic signing route",async t=>{
  const f=await fixture(t);await f.enrol();const server=createBrokerServer({device:f.device,port:0});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>{server.close();server.closeAllConnections();});
  const base="http://127.0.0.1:"+server.address().port,origin="https://eats.calai.info";
  assert.equal((await fetch(base+"/v1/bootstrap")).status,403);
  assert.equal((await fetch(base+"/v1/bootstrap",{headers:{Origin:"https://evil.example"}})).status,403);
  const wrongHost=await new Promise((resolve,reject)=>{const request=http.get(base+"/v1/bootstrap",{headers:{Origin:origin,Host:"evil.example"}},response=>{response.resume();resolve(response.statusCode);});request.once("error",reject);});
  assert.equal(wrongHost,403);
  const bootstrap=(await(await fetch(base+"/v1/bootstrap",{headers:{Origin:origin}})).json()).data;
  assert.equal(bootstrap.product,"calai-business-terminal");assert.equal(bootstrap.token,undefined);
  const post=(route,body,extra={})=>fetch(base+route,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json","X-Calai-Terminal-CSRF":bootstrap.csrfToken,...extra},body:JSON.stringify(body)});
  assert.equal((await fetch(base+"/v1/automatic-session",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({screenId})})).status,403);
  const response=await post("/v1/automatic-session",{screenId}),session=(await response.json()).data;
  assert.equal(session.principalKind,"terminal");assert.equal(session.token,undefined);
  assert.equal((await post("/v1/request",{method:"GET",path:"/api/auth/me",body:null})).status,403);
  assert.equal((await post("/v1/request",{method:"GET",path:"/api/auth/me",body:null},{"X-Calai-Terminal-Window":session.windowProof})).status,200);
  assert.equal((await post("/v1/sign",{bytes:"anything"})).status,404);
  const preflight=await fetch(base+"/v1/request",{method:"OPTIONS",headers:{Origin:origin,"Access-Control-Request-Method":"POST","Access-Control-Request-Headers":"authorization"}});
  assert.equal(preflight.status,403);
});
