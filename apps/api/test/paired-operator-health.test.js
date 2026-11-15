import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes,randomUUID,sign} from "node:crypto";
import {businessDeviceFixture} from "./business-device-fixture.js";
import {terminalCanonicalRequest} from "../src/ordering-terminals.js";

async function operatorFixture(){
 const f=await businessDeviceFixture(),owner=f.db.prepare("SELECT password_hash FROM users WHERE email='restaurant@calai.local'").get(),userId=randomUUID(),email="terminal-operator@example.invalid",stamp=f.config.now().toISOString();
 f.db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,'restaurant',?)").run(userId,"Terminal operator",email,owner.password_hash,stamp);
 f.db.prepare("INSERT INTO restaurant_memberships(restaurant_id,user_id,permission,created_at,can_process_orders,can_view_devices) VALUES(?,?,'staff',?,1,0)").run(f.restaurant.id,userId,stamp);
 const cookie=await f.login(email,"LocalRestaurant!4310"),root=`/api/restaurant/restaurants/${f.restaurant.id}`,screenId=randomBytes(18).toString("base64url");let grant;
 function headers(method,path,body,at=f.config.now().getTime()){
  const timestamp=String(at),nonce=randomBytes(18).toString("base64url"),raw=body===undefined?Buffer.alloc(0):Buffer.from(JSON.stringify(body));
  return {"X-Cal-Eats-Terminal-Id":f.terminalId,"X-Cal-Eats-Terminal-Timestamp":timestamp,"X-Cal-Eats-Terminal-Nonce":nonce,"X-Cal-Eats-Terminal-Signature":sign("sha256",Buffer.from(terminalCanonicalRequest({terminalId:f.terminalId,timestamp,nonce,method,path,body:raw})),{key:f.keys.privateKey,dsaEncoding:"ieee-p1363"}).toString("base64url"),...(grant?{"X-Cal-Eats-Terminal-Session":grant}:{})};
 }
 const signed=(path,method="GET",body)=>f.json(path,{method,headers:headers(method,path,body),...(body===undefined?{}:{body})});
 async function connect(){
  const handoff=await f.json(`${root}/terminal/session-handoff`,{method:"POST",cookie,body:{screenId}});assert.equal(handoff.status,201,handoff.text);
  const session=await f.headless(`/api/terminal-devices/${f.terminalId}/session`,{handoffToken:handoff.body.data.handoffToken});assert.equal(session.status,201,session.text);grant=session.body.data.sessionToken;
  const challenge=await f.json(`${root}/terminal/screen-challenge`,{method:"POST",cookie,body:{screenId}});assert.equal(challenge.status,201,challenge.text);
  const proof=await signed(`/api/terminal-devices/${f.terminalId}/screen-heartbeat`,"POST",{screenId,challenge:challenge.body.data.challenge});assert.equal(proof.status,200,proof.text);
 }
 return {...f,userId,email,cookie,root,headers,signed,connect};
}

test("process-only staff diagnostics require a real local USER grant; ordinary owner reads remain allowed",async()=>{
 const f=await operatorFixture();try{
  const path=`${f.root}/operations-health`;
  assert.equal((await f.json(path,{cookie:f.owner})).status,200,"Remote owners retain their explicit device access");
  assert.equal((await f.json(path,{cookie:f.cookie})).status,403,"Processing eligibility alone is not remote device access");
  const native=await f.json("/api/native/business/auth/login",{method:"POST",body:{email:f.email,password:"LocalRestaurant!4310"}});assert.equal(native.status,200,native.text);
  assert.equal((await f.json(path,{headers:{Authorization:`Bearer ${native.body.data.token}`}})).status,403,"A phone cannot use the tablet exception");
  await f.connect();let health=await f.signed(path);assert.equal(health.status,200,health.text);assert.equal(health.body.data.restaurantId,f.restaurant.id);
  const unsigned=await f.json(path,{cookie:f.cookie,headers:f.headers("GET",path,undefined)});assert.equal(unsigned.status,403,"A browser cookie cannot substitute for the delegated USER session");
  await f.report("needs_attention","windows_spooler",["cover_open"]);health=await f.signed(path);const incident=health.body.data.incidents.find(item=>item.faultCode==="cover_open");assert.ok(incident);
  const incidentPath=`/api/restaurant/incidents/${incident.id}/read`;
  assert.equal((await f.json(incidentPath,{method:"PATCH",cookie:f.cookie,body:{read:true}})).status,403);
  assert.equal((await f.signed(incidentPath,"PATCH",{read:true})).status,200);
  f.advance(61000);health=await f.signed(path);assert.equal(health.status,200,"Fresh signed diagnostic reads remain available when the screen is stale");assert.equal(health.body.data.tablet.status,"offline");
  const stale=f.headers("GET",path,undefined,f.config.now().getTime()-61000);assert.equal((await f.json(path,{headers:stale})).status,401,"The request signature itself must be fresh");
  const foreign=f.db.prepare("SELECT id FROM restaurants WHERE id<>? LIMIT 1").get(f.restaurant.id);assert.equal((await f.signed(`/api/restaurant/restaurants/${foreign.id}/operations-health`)).status,404);
  const emptyBodySignature=f.headers("GET",path,undefined);assert.equal((await f.json(path,{method:"GET",headers:emptyBodySignature,body:{}})).status,401,"GET proofs hash the actual empty bytes, not a JSON object");
 }finally{await f.close();}
});

test("diagnostic delegation cannot survive permission loss, original-session logout or terminal revocation",async()=>{
 const f=await operatorFixture();try{
  const path=`${f.root}/operations-health`;await f.connect();
  f.db.prepare("UPDATE restaurant_memberships SET can_process_orders=0 WHERE restaurant_id=? AND user_id=?").run(f.restaurant.id,f.userId);assert.equal((await f.signed(path)).status,403);
  f.db.prepare("UPDATE restaurant_memberships SET can_process_orders=1 WHERE restaurant_id=? AND user_id=?").run(f.restaurant.id,f.userId);
  assert.equal((await f.json("/api/auth/logout",{method:"POST",cookie:f.cookie,body:{}})).status,200);assert.equal((await f.signed(path)).status,401);
  assert.equal((await f.json(`${f.root}/terminal/revoke`,{method:"POST",cookie:f.owner,body:{}})).status,200);assert.equal((await f.signed(path)).status,403);
 }finally{await f.close();}
});
