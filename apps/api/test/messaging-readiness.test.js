import assert from "node:assert/strict";
import test from "node:test";
import {randomBytes} from "node:crypto";
import {messageEncryptionReadiness} from "../src/message-encryption.js";
import {journeyFixture} from "./helpers.js";
test("hosted messaging readiness requires a valid configured key without exposing it",()=>{
 assert.deepEqual(messageEncryptionReadiness({runMode:"hosted-preview",messageEncryptionKey:"invalid"}),{configured:false,keyVersion:null});
 const key=randomBytes(32).toString("base64"),readiness=messageEncryptionReadiness({runMode:"hosted-preview",messageEncryptionKey:key});assert.deepEqual(readiness,{configured:true,keyVersion:"v1"});assert.equal(JSON.stringify(readiness).includes(key),false);
});

test("hosted support reports unavailable replies and retries the same reply after configuration is restored",async()=>{
 const f=await journeyFixture();try{
  const owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),admin=await f.login("admin@calai.local","LocalAdmin!4310");
  const ticket=(await f.json("/api/support",{cookie:owner,method:"POST",body:{subject:"Hosted readiness",message:"Original request must remain visible"}})).body.data;
  f.config.runMode="hosted-preview";f.config.messageEncryptionKey="invalid-key";
  const before=(await f.json(`/api/support/${ticket.id}`,{cookie:admin})).body.data;assert.equal(before.canReply,false);assert.match(before.replyUnavailableReason,/temporarily unavailable/);assert.equal(before.message,"Original request must remain visible");
  assert.equal((await f.json("/api/admin/operational-settings",{cookie:admin})).body.data.messaging.configured,false);
  const send=()=>f.json(`/api/support/${ticket.id}/messages`,{cookie:admin,method:"POST",headers:{Origin:f.config.origin,"Idempotency-Key":"recover-hosted-reply"},body:{message:"Reply after configuration is ready"}});
  assert.equal((await send()).status,503);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM support_case_messages").get().n,0);
  f.config.messageEncryptionKey=randomBytes(32).toString("base64");assert.equal((await send()).status,201);assert.equal((await send()).status,200);
  const after=(await f.json(`/api/support/${ticket.id}`,{cookie:owner})).body.data;assert.equal(after.canReply,true);assert.equal(after.messages.length,1);assert.equal(after.messages[0].message,"Reply after configuration is ready");assert.equal(after.message,before.message);
  const readiness=(await f.json("/api/admin/operational-settings",{cookie:admin})).body.data.messaging;assert.deepEqual(readiness,{configured:true,keyVersion:"v1"});assert.equal(JSON.stringify(readiness).includes(f.config.messageEncryptionKey),false);
 }finally{await f.close();}
});
