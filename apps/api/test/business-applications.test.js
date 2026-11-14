import assert from "node:assert/strict";
import test from "node:test";
import {createHash,randomUUID} from "node:crypto";
import {journeyFixture} from "./helpers.js";
import {buildCustomerEmail,runCustomerTransactionalEmails} from "../src/customer-emails.js";
import {verifyPassword} from "../src/auth/passwords.js";
import {hasLiveBankingCredential} from "../src/auth/password-change.js";

const application={name:"Sam Owner",email:"sam-owner@example.test",restaurantName:"Market Kitchen",address:"12 Market Street, London E1 1AA",mobile:"07700 900123"};
const options=body=>({method:"POST",headers:{"Idempotency-Key":"business-application-test-001"},body});
const initialPassword="PrivateInitial!4901";
const passwordBody={password:initialPassword,passwordConfirmation:initialPassword,reason:"Initial access for reviewed restaurant application"};
const passwordRequest=(cookie,body=passwordBody,key="business-password-test-001")=>({method:"POST",cookie,headers:{"Idempotency-Key":key},body});
const ownerFor=(f,id)=>f.db.prepare("SELECT u.* FROM users u JOIN business_application_submissions a ON a.user_id=u.id WHERE a.restaurant_id=?").get(id);

test("business applications require contacts but do not accept a public password",async()=>{
  const f=await journeyFixture();
  try{
    const before=f.db.prepare("SELECT COUNT(*) n FROM users").get().n;
    for(const invalid of [{name:""},{restaurantName:""},{email:"invalid"},{address:""},{address:"12 Market Street"},{mobile:"call me"},{password:"DoNotCollectPasswords!123"}]){
      const result=await f.json("/api/auth/restaurant-register",options({...application,...invalid}));
      assert.equal(result.status,400,result.text);assert.equal(result.body.error.code,"VALIDATION_ERROR");
    }
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM users").get().n,before);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM customer_transactional_email_outbox WHERE event_kind='business_application'").get().n,0);
  }finally{await f.close();}
});

test("passwordless application is private, sessionless, retry-safe and sends one acknowledgement while login is disabled",async()=>{
  const f=await journeyFixture({rateLimit:{attempts:40,windowMs:60000}});
  try{
    const admin=await f.login("admin@calai.local","LocalAdmin!4310");
    const first=await f.json("/api/auth/restaurant-register",{...options(application),cookie:admin});assert.equal(first.status,201,first.text);
    const received=first.body.data,restaurant=f.db.prepare("SELECT * FROM restaurants WHERE id=?").get(received.restaurantId),user=ownerFor(f,restaurant.id);
    assert.equal(first.headers.has("set-cookie"),false);assert.equal("user" in received,false);assert.equal("token" in received,false);
    assert.equal((await f.json("/api/auth/me",{cookie:admin})).body.data.user.role,"admin");
    assert.equal(received.applicationStatus,"pending");assert.equal(received.loginPreparedByAdmin,true);assert.match(received.message,/Calai team.*72 hours/);
    assert.equal(user.account_enabled,0);assert.equal(user.phone,application.mobile);assert.equal(restaurant.status,"pending");assert.equal(restaurant.address,application.address);assert.equal(restaurant.phone,application.mobile);
    assert.equal((await f.json("/api/restaurants")).body.data.some(row=>row.id===restaurant.id),false);
    const retry=await f.json("/api/auth/restaurant-register",options(application));assert.equal(retry.status,200,retry.text);assert.equal(retry.body.data.restaurantId,restaurant.id);
    assert.equal((await f.json("/api/auth/restaurant-register",options({...application,address:"22 Other Street, London E1 1AA"}))).status,409);
    assert.equal((await f.json("/api/auth/restaurant-register",{method:"POST",body:application})).status,409);
    assert.equal((await f.json("/api/auth/login",{method:"POST",body:{email:application.email,password:"123456"}})).status,401);
    const rows=f.db.prepare("SELECT * FROM customer_transactional_email_outbox WHERE event_kind='business_application'").all();assert.equal(rows.length,1);
    const mail=buildCustomerEmail(rows[0],f.config);assert.equal(mail.from,"caleats-support@calai.info");assert.match(mail.text,/The Calai team will contact you within 72 hours/);assert.match(mail.text,/prepare your business login/);assert.match(mail.html,/Pending review/);assert.doesNotMatch(mail.html,/View your application|Sign in to the business platform to view/);assert.equal(mail.text.includes(application.address),false);
    let sends=0;const worker=await runCustomerTransactionalEmails(f.db,f.config,{adapter:async(message,{beforeSend})=>{assert.equal(beforeSend(),true);assert.equal(message.to,application.email);sends++;return{status:"unknown",errorCode:"TEST_UNCERTAIN"};}});assert.equal(worker.unknown,1);
    await runCustomerTransactionalEmails(f.db,f.config,{adapter:async()=>{sends++;return{status:"sent"};}});assert.equal(sends,1);
    const detail=await f.json(`/api/admin/restaurants/${restaurant.id}/application`,{cookie:admin});assert.equal(detail.status,200,detail.text);assert.equal(detail.body.data.applicant.email,application.email);assert.equal(detail.body.data.access.passwordSetupRequired,true);assert.equal(detail.body.data.access.loginEnabled,false);assert.equal(detail.body.data.access.canSetInitialPassword,true);
    assert.equal((await f.json(`/api/admin/restaurants/${restaurant.id}/application`)).status,401);
  }finally{await f.close();}
});

test("only the administrator prepares an applicant's strong initial password, with audited one-time setup and unchanged approval/banking checks",async()=>{
  const f=await journeyFixture({rateLimit:{attempts:40,windowMs:60000}});
  try{
    const created=await f.json("/api/auth/restaurant-register",options(application)),id=created.body.data.restaurantId,path=`/api/admin/restaurants/${id}/application/password`,before=ownerFor(f,id);
    const admin=await f.login("admin@calai.local","LocalAdmin!4310"),owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),customer=await f.login("customer@calai.local","LocalCustomer!4310");
    assert.equal((await f.json(path,passwordRequest(null))).status,401);
    for(const cookie of [owner,customer])assert.equal((await f.json(path,passwordRequest(cookie))).status,403);
    for(const invalid of [{password:"short",passwordConfirmation:"short"},{password:"longlettersbutnonumbers",passwordConfirmation:"longlettersbutnonumbers"},{passwordConfirmation:"different"},{reason:""},{reason:`Do not save ${initialPassword} in audit`}])assert.equal((await f.json(path,passwordRequest(admin,{...passwordBody,...invalid}))).status,400);
    assert.equal(ownerFor(f,id).password_hash,before.password_hash);assert.equal(ownerFor(f,id).account_enabled,0);
    const saved=await f.json(path,passwordRequest(admin));assert.equal(saved.status,200,saved.text);assert.equal(saved.body.data.changed,true);assert.equal(saved.body.data.loginEnabled,true);
    const after=ownerFor(f,id);assert.equal(await verifyPassword(initialPassword,after.password_hash),true);assert.equal(after.account_enabled,1);assert.equal(f.db.prepare("SELECT status FROM restaurants WHERE id=?").get(id).status,"pending");assert.equal(hasLiveBankingCredential(f.db,after.id),false);
    const replay=await f.json(path,passwordRequest(admin));assert.equal(replay.status,200,replay.text);assert.equal(replay.body.data.changed,false);assert.equal(ownerFor(f,id).password_hash,after.password_hash);
    assert.equal((await f.json(path,passwordRequest(admin,passwordBody,"business-password-other-002"))).status,409);
    const other="AnotherInitial!4902";assert.equal((await f.json(path,passwordRequest(admin,{...passwordBody,password:other,passwordConfirmation:other}))).status,409);
    const audits=f.db.prepare("SELECT * FROM audit_events WHERE action='business_initial_password_set' AND entity_id=?").all(id);assert.equal(audits.length,1);assert.equal(audits[0].actor_user_id,f.db.prepare("SELECT id FROM users WHERE email='admin@calai.local'").get().id);assert.equal(audits[0].details.includes(initialPassword),false);assert.equal(audits[0].details.includes(after.password_hash),false);
    const cookie=await f.login(application.email,initialPassword),owned=await f.json("/api/restaurant/restaurants",{cookie});assert.equal(owned.body.data[0].status,"pending");assert.equal(owned.body.data[0].acceptingOrders,false);
    const native=await f.json("/api/native/business/auth/login",{method:"POST",body:{email:application.email,password:initialPassword}});assert.equal(native.status,200,native.text);assert.equal(native.body.data.user.role,"restaurant");
    const customerBoundary=await f.json("/api/native/auth/login",{method:"POST",body:{email:application.email,password:initialPassword}});assert.equal(customerBoundary.status,401);assert.equal(customerBoundary.body.error.code,"CUSTOMER_ACCOUNT_REQUIRED");
    assert.equal((await f.json(`/api/admin/restaurants/${owned.body.data[0].id}/application`,{cookie})).status,403);
    const existing=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0];assert.equal((await f.json(`/api/admin/restaurants/${existing.id}/application/password`,passwordRequest(admin))).status,404);
    assert.equal((await f.json("/api/auth/login",{method:"POST",body:{email:"restaurant@calai.local",password:"LocalRestaurant!4310"}})).status,200);
  }finally{await f.close();}
});

test("password recovery cannot bypass pending administrator setup, even after a separate account-enable action",async()=>{
  const f=await journeyFixture();
  try{
    const created=await f.json("/api/auth/restaurant-register",options(application)),id=created.body.data.restaurantId,user=ownerFor(f,id),original=user.password_hash;
    f.db.prepare("UPDATE users SET account_enabled=1 WHERE id=?").run(user.id);
    assert.equal((await f.json("/api/auth/password/forgot",{method:"POST",body:{email:application.email}})).status,202);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM account_access_tokens WHERE user_id=?").get(user.id).n,0);
    const token="x".repeat(43),stamp=f.config.now().toISOString();
    f.db.prepare("INSERT INTO account_access_tokens(id,user_id,purpose,token_hash,expires_at,consumed_at,created_at,issued_email) VALUES(?,?,'password_reset',?,?,NULL,?,?)").run(randomUUID(),user.id,createHash("sha256").update(token).digest("hex"),"2026-01-02T00:00:00.000Z",stamp,user.email);
    const reset=await f.json("/api/auth/password/reset",{method:"POST",body:{token,password:"RecoveryMustNotWork!123"}});assert.equal(reset.status,400,reset.text);assert.equal(ownerFor(f,id).password_hash,original);
    const admin=await f.login("admin@calai.local","LocalAdmin!4310");assert.equal((await f.json(`/api/admin/restaurants/${id}/application/password`,passwordRequest(admin))).status,200);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM account_access_tokens WHERE user_id=? AND consumed_at IS NULL").get(user.id).n,0);
    assert.equal((await f.json("/api/auth/password/forgot",{method:"POST",body:{email:application.email}})).status,202);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM account_access_tokens WHERE user_id=? AND consumed_at IS NULL").get(user.id).n,1);
  }finally{await f.close();}
});

test("native applications also create no login or customer session",async()=>{
  const f=await journeyFixture();
  try{
    const result=await f.json("/api/native/business/auth/apply",options({...application,email:"native-owner@example.test"}));assert.equal(result.status,201,result.text);assert.equal(result.body.data.applicationStatus,"pending");assert.equal(result.headers.has("set-cookie"),false);assert.equal("token" in result.body.data,false);assert.equal("user" in result.body.data,false);
    const user=ownerFor(f,result.body.data.restaurantId);assert.equal(user.account_enabled,0);for(const table of ["sessions","native_sessions","native_business_sessions"])assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get(user.id).n,0);
  }finally{await f.close();}
});
