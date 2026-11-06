import test from "node:test";
import assert from "node:assert/strict";
import {publicUser} from "../../../packages/contracts/src/index.js";
import {journeyFixture} from "./helpers.js";

test("own identity includes only a saved phone and omits empty optional fields and private data",()=>{
  const identity={id:"customer",name:"Customer",email:"customer@example.test",role:"customer"};
  for(const phone of [undefined,null,"","   "])assert.deepEqual(publicUser({...identity,phone,password_hash:"private-hash",bankDetails:"private-bank"}),identity);
  assert.deepEqual(publicUser({...identity,phone:"07700900002",password_hash:"private-hash",bankDetails:"private-bank"}),{...identity,phone:"07700900002"});
});

test("saved customer phone survives browser and native login/me and reflects later profile changes",async()=>{
  const f=await journeyFixture();
  try{
    const body={email:"customer@calai.local",password:"LocalCustomer!4310"},initial=await f.json("/api/auth/login",{method:"POST",body});assert.equal(initial.status,200);assert.equal("phone" in initial.body.data.user,false);
    const user=f.db.prepare("SELECT id,name,email,role FROM users WHERE email=?").get(body.email);f.db.prepare("UPDATE users SET phone='07700900002' WHERE id=?").run(user.id);
    const browser=await f.json("/api/auth/login",{method:"POST",body});assert.equal(browser.status,200);assert.deepEqual(browser.body.data.user,{...user,phone:"07700900002"});
    const cookie=browser.headers.get("set-cookie").split(";",1)[0],native=await f.json("/api/native/auth/login",{method:"POST",body});assert.equal(native.status,200);assert.deepEqual(native.body.data.user,{...user,phone:"07700900002"});
    const nativeHeaders={authorization:`Bearer ${native.body.data.token}`};
    for(const [path,options]of [["/api/auth/me",{cookie}],["/api/native/auth/me",{headers:nativeHeaders}]]){
      const current=await f.json(path,options);assert.equal(current.status,200);assert.deepEqual(current.body.data.user,{...user,phone:"07700900002"});
    }
    f.db.prepare("UPDATE users SET phone='07700900003' WHERE id=?").run(user.id);
    assert.equal((await f.json("/api/auth/me",{cookie})).body.data.user.phone,"07700900003");assert.equal((await f.json("/api/native/auth/me",{headers:nativeHeaders})).body.data.user.phone,"07700900003");
    f.db.prepare("UPDATE users SET phone='' WHERE id=?").run(user.id);
    assert.equal("phone" in (await f.json("/api/auth/me",{cookie})).body.data.user,false);assert.equal("phone" in (await f.json("/api/native/auth/me",{headers:nativeHeaders})).body.data.user,false);
  }finally{await f.close();}
});
