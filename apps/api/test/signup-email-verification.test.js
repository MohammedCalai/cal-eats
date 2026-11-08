import test from "node:test";
import assert from "node:assert/strict";
import { journeyFixture } from "./helpers.js";
import { runAccountAccessEmails } from "../src/account-access-email.js";

const password="Signup fixture password 2026!";
const cookie=response=>response.headers.get("set-cookie")?.split(";",1)[0];
const localToken=(db,email)=>db.prepare("SELECT body FROM local_mail_sink WHERE recipient=? AND kind='email_verification' ORDER BY rowid DESC LIMIT 1").get(email)?.body.match(/#verify-email=([A-Za-z0-9_-]+)/)?.[1];
const financial=db=>Object.fromEntries(["orders","ledger_entries","journal_postings","marketplace_operations","stripe_order_payments","offer_grants","platform_voucher_redemptions"].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

test("every web/native customer signup welcomes once, verifies before a new order and preserves access, cooldown and existing recovery",async()=>{
  let time=Date.parse("2026-01-01T01:00:00.000Z");const f=await journeyFixture({now:()=>new Date(time),rateLimit:{attempts:100,windowMs:60000}});
  try{
    const owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),oldCustomer=await f.login("customer@calai.local","LocalCustomer!4310");
    const restaurant=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0],item=(await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
    const orderBody={restaurantId:restaurant.id,items:[{menuItemId:item.id,quantity:1}],paymentMethod:"cash",fulfillment:"collection"};
    assert.equal((await f.json("/api/auth/email-verification/status",{cookie:oldCustomer})).body.data.canOrder,true,"Existing accounts are grandfathered, not silently forced into new verification");
    for(const native of [false,true]){
      const email=native?"native-signup@example.test":"web-signup@example.test",signup=await f.json(native?"/api/native/auth/register":"/api/auth/register",{method:"POST",body:{name:native?"Native customer":"Web customer",email,password}});assert.equal(signup.status,201,signup.text);
      const auth=native?{headers:{authorization:`Bearer ${signup.body.data.token}`}}:{cookie:cookie(signup)},userId=signup.body.data.user.id,statusPath=native?"/api/native/auth/email-verification/status":"/api/auth/email-verification/status",sendPath=native?"/api/native/auth/email-verification/send":"/api/auth/email-verification/send",confirmPath=native?"/api/native/auth/email-verification/confirm":"/api/auth/email-verification/confirm";
      assert.equal(signup.body.data.emailVerification.verificationRequired,true);assert.equal(signup.body.data.emailVerification.canOrder,false);assert.equal(signup.body.data.emailVerification.delivery,"local_simulation");
      assert.equal(f.db.prepare("SELECT email_verification_required FROM users WHERE id=?").get(userId).email_verification_required,1);
      const mail=f.db.prepare("SELECT * FROM local_mail_sink WHERE user_id=?").all(userId);assert.equal(mail.length,1);assert.match(mail[0].subject,/Welcome to Cal-Eats/);assert.match(mail[0].body,/24 hours/);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM account_access_email_outbox WHERE user_id=?").get(userId).n,0);
      assert.equal((await f.json(native?"/api/native/auth/me":"/api/auth/me",auth)).status,200);assert.equal((await f.json("/api/account/erasure-requests",auth)).status,200);assert.equal((await f.json("/api/restaurants",auth)).status,200);assert.equal((await f.json("/api/account",auth)).status,200);
      const before=financial(f.db),blocked=await f.json("/api/orders",{...auth,method:"POST",headers:{...auth.headers,"Idempotency-Key":`unverified-${native}`},body:orderBody});assert.equal(blocked.status,428,blocked.text);assert.equal(blocked.body.error.code,"EMAIL_VERIFICATION_REQUIRED");assert.deepEqual(financial(f.db),before);
      const token=localToken(f.db,email);assert.ok(token);assert.equal((await f.json(sendPath,{...auth,method:"POST",body:{}})).body.data.resent,false);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM account_access_tokens WHERE user_id=?").get(userId).n,1);
      const scanner=await f.json(`${confirmPath}?token=${token}`);assert.equal(scanner.status,404);assert.equal(f.db.prepare("SELECT consumed_at FROM account_access_tokens WHERE user_id=?").get(userId).consumed_at,null);
      time+=61000;const resend=await Promise.all([1,2].map(()=>f.json(sendPath,{...auth,method:"POST",body:{}})));assert.deepEqual(resend.map(r=>r.body.data.resent).sort(),[false,true]);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM account_access_tokens WHERE user_id=?").get(userId).n,2);
      assert.equal((await f.json(confirmPath,{method:"POST",body:{token}})).body.error.code,"TOKEN_INVALID","A superseded welcome link cannot verify");
      const replacement=localToken(f.db,email);assert.equal((await f.json(confirmPath,{method:"POST",body:{token:replacement}})).status,200);assert.equal((await f.json(confirmPath,{method:"POST",body:{token:replacement}})).body.error.code,"TOKEN_INVALID");
      assert.equal((await f.json(statusPath,auth)).body.data.canOrder,true);assert.equal((await f.json(statusPath,auth)).body.data.verificationRequired,false);
      const order=await f.json("/api/orders",{...auth,method:"POST",headers:{...auth.headers,"Idempotency-Key":`verified-${native}`},body:orderBody});assert.equal(order.status,201,order.text);
      // An existing successful order remains recoverable if the address is later changed.
      f.db.prepare("UPDATE users SET email=? WHERE id=?").run(`changed-${email}`,userId);assert.equal((await f.json(statusPath,auth)).body.data.canOrder,false);const beforeReplay=financial(f.db),replay=await f.json("/api/orders",{...auth,method:"POST",headers:{...auth.headers,"Idempotency-Key":`verified-${native}`},body:orderBody});assert.equal(replay.status,200,replay.text);assert.equal(replay.body.data.id,order.body.data.id);assert.deepEqual(financial(f.db),beforeReplay);
      assert.equal((await f.json("/api/orders",{...auth,method:"POST",headers:{...auth.headers,"Idempotency-Key":`changed-new-${native}`},body:orderBody})).body.error.code,"EMAIL_VERIFICATION_REQUIRED");
    }
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length,0);
  }finally{await f.close();}
});

test("hosted signup fails closed, commits encrypted welcome atomically and rejects expired, changed and reused verification links",async()=>{
  let time=Date.parse("2026-01-01T01:00:00.000Z");const origin="https://eats.example.test",f=await journeyFixture({runMode:"hosted-preview",nodeEnv:"production",origin,now:()=>new Date(time),rateLimit:{attempts:100,windowMs:60000},messageEncryptionKey:Buffer.alloc(32,23).toString("base64"),orderAlertEmail:{mode:"smtp",enabled:true,host:"smtp.ionos.co.uk",port:465,user:"caleats-support@calai.info",from:"caleats-support@calai.info",password:"isolated-fixture-not-a-real-password"}});
  try{
    const email="signup.verification.fixture@gmail.com",request=(path,body,auth={})=>f.json(path,{method:"POST",...auth,headers:{Origin:origin,...auth.headers},body}),signup=(address=email)=>request("/api/auth/register",{name:"Signup customer",email:address,password}),counts=()=>Object.fromEntries(["users","sessions","account_access_tokens","account_access_email_outbox","customer_legal_acceptances"].map(table=>[table,f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));
    const untouched=counts(),key=f.config.messageEncryptionKey;f.config.messageEncryptionKey="invalid";let response=await signup();assert.equal(response.status,503,response.text);assert.equal(response.body.error.code,"SIGNUP_EMAIL_UNAVAILABLE");assert.deepEqual(counts(),untouched);f.config.messageEncryptionKey=key;
    f.config.orderAlertEmail.enabled=false;response=await signup();assert.equal(response.status,503);assert.deepEqual(counts(),untouched);f.config.orderAlertEmail.enabled=true;
    f.db.exec("CREATE TRIGGER fixture_signup_queue_failure BEFORE INSERT ON account_access_email_outbox BEGIN SELECT RAISE(ABORT,'fixture queue rollback'); END;");response=await signup();assert.equal(response.status,500,response.text);assert.deepEqual(counts(),untouched);f.db.exec("DROP TRIGGER fixture_signup_queue_failure");
    response=await signup();assert.equal(response.status,201,response.text);const userId=response.body.data.user.id,auth={cookie:cookie(response)},outbox=f.db.prepare("SELECT * FROM account_access_email_outbox WHERE user_id=?").get(userId);assert.equal(outbox.status,"pending");assert.ok(outbox.ciphertext);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM local_mail_sink").get().n,0);
    let welcome;
    await runAccountAccessEmails(f.db,f.config,{adapter:async(message,{beforeSend})=>{assert.equal(beforeSend(),true);welcome=message;return{status:"sent"};}});assert.match(welcome.subject,/Welcome to Cal-Eats/);assert.match(welcome.text,/first order/);const token=welcome.text.match(/#verify-email=([A-Za-z0-9_-]+)/)[1];assert.ok(!JSON.stringify(f.db.prepare("SELECT * FROM account_access_email_outbox").all()).includes(token));assert.notEqual(f.db.prepare("SELECT token_hash FROM account_access_tokens WHERE user_id=?").get(userId).token_hash,token);
    f.db.prepare("UPDATE users SET email='changed.signup.fixture@gmail.com' WHERE id=?").run(userId);assert.equal((await request("/api/auth/email-verification/confirm",{token})).body.error.code,"TOKEN_INVALID");f.db.prepare("UPDATE users SET email=? WHERE id=?").run(email,userId);assert.equal((await request("/api/auth/email-verification/confirm",{token})).body.error.code,"TOKEN_INVALID","Changing the email back must not revive a consumed link");
    time+=61000;assert.equal((await request("/api/auth/email-verification/send",{},auth)).body.data.resent,true);let expiresToken;
    await runAccountAccessEmails(f.db,f.config,{adapter:async(message,{beforeSend})=>{assert.equal(beforeSend(),true);expiresToken=message.text.match(/#verify-email=([A-Za-z0-9_-]+)/)[1];return{status:"sent"};}});time+=24*60*60*1000+1;assert.equal((await request("/api/auth/email-verification/confirm",{token:expiresToken})).body.error.code,"TOKEN_INVALID");auth.cookie=cookie(await request("/api/auth/login",{email,password}));
    assert.equal((await request("/api/auth/email-verification/confirm",{token:"not-a-real-token"})).body.error.code,"TOKEN_INVALID");
    assert.equal((await request("/api/auth/email-verification/send",{},auth)).body.data.resent,true);let finalToken;
    await runAccountAccessEmails(f.db,f.config,{adapter:async(message,{beforeSend})=>{assert.equal(beforeSend(),true);finalToken=message.text.match(/#verify-email=([A-Za-z0-9_-]+)/)[1];return{status:"sent"};}});const confirmed=await Promise.all([1,2].map(()=>request("/api/auth/email-verification/confirm",{token:finalToken})));assert.deepEqual(confirmed.map(r=>r.status).sort(),[200,400]);assert.equal((await f.json("/api/auth/email-verification/status",auth)).body.data.canOrder,true);assert.equal((await request("/api/auth/email-verification/send",{},auth)).body.data.resent,false);
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length,0);
  }finally{await f.close();}
});
