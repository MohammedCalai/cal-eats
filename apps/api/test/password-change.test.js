import test from "node:test";
import assert from "node:assert/strict";
import {journeyFixture} from "./helpers.js";
import {hasLiveBankingCredential,requireLiveBankingCredential} from "../src/auth/password-change.js";
import {hashPassword} from "../src/auth/passwords.js";

test("owner-chosen secure credentials gate real banking, revoke other sessions and cannot survive a later password reset",async()=>{
  const f=await journeyFixture({orderAlertEmail:{mode:"off"},rateLimit:{attempts:100,windowMs:60000}});
  try{
    const route="/api/auth/password",owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),other=await f.login("restaurant@calai.local","LocalRestaurant!4310"),administrator=await f.login("admin@calai.local","LocalAdmin!4310"),id=f.db.prepare("SELECT id FROM users WHERE email='restaurant@calai.local'").get().id;
    assert.equal((await f.json(route,{method:"POST",body:{}})).status,401);
    assert.equal((await f.json(route,{cookie:owner})).status,405);
    assert.equal((await f.json("/api/auth/password-security",{cookie:owner})).body.data.passwordChangeRequired,true);
    for(const next of["short1","123456123456abc","AllLettersOnlyLong"]){const result=await f.json(route,{method:"POST",cookie:owner,body:{currentPassword:"LocalRestaurant!4310",newPassword:next}});assert.equal(result.status,400);}
    assert.equal((await f.json(route,{method:"POST",cookie:owner,body:{currentPassword:"WrongCurrent!2026",newPassword:"FixtureOwnerAccess!2026"}})).status,403);
    const changed=await f.json(route,{method:"POST",cookie:owner,body:{currentPassword:"LocalRestaurant!4310",newPassword:"FixtureOwnerAccess!2026"}});assert.equal(changed.status,200,changed.text);assert.equal(changed.body.data.changed,true);
    assert.equal((await f.json("/api/auth/me",{cookie:owner})).status,200);assert.equal((await f.json("/api/auth/me",{cookie:other})).status,401);
    assert.equal(hasLiveBankingCredential(f.db,id),true);
    assert.throws(()=>requireLiveBankingCredential(f.db,id),error=>error.code==="PLATFORM_BANKING_PASSWORD_CHANGE_REQUIRED");
    const administratorChanged=await f.json(route,{method:"POST",cookie:administrator,body:{currentPassword:"LocalAdmin!4310",newPassword:"FixtureAdminAccess!2026"}});assert.equal(administratorChanged.status,200,administratorChanged.text);
    assert.doesNotThrow(()=>requireLiveBankingCredential(f.db,id));
    assert.equal((await f.json("/api/auth/password-security",{cookie:owner})).body.data.passwordChangeRequired,false);
    const audit=f.db.prepare("SELECT details FROM audit_events WHERE entity_id=? AND action='password_changed'").get(id).details;assert.ok(!audit.includes("FixtureOwnerAccess!2026"));assert.ok(!changed.text.includes("password_hash"));
    f.db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(await hashPassword("LaterResetAccess!2026"),id);
    assert.equal(hasLiveBankingCredential(f.db,id),false);assert.throws(()=>requireLiveBankingCredential(f.db,id),error=>error.code==="LIVE_BANKING_PASSWORD_CHANGE_REQUIRED");
  }finally{await f.close();}
});
