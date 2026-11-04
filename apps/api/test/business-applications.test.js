import assert from "node:assert/strict";
import test from "node:test";
import { journeyFixture } from "./helpers.js";
import { buildCustomerEmail, runCustomerTransactionalEmails } from "../src/customer-emails.js";

const application={name:"Sam Owner",email:"sam-owner@example.test",password:"A long new password",restaurantName:"Market Kitchen",address:"12 Market Street, London E1 1AA",mobile:"07700 900123"};
const options=body=>({method:"POST",headers:{"Idempotency-Key":"business-application-test-001"},body});

test("business applications require complete contact details and the existing password minimum",async()=>{
  const f=await journeyFixture();
  try{
    const before=f.db.prepare("SELECT COUNT(*) n FROM users").get().n;
    for(const invalid of [{name:""},{restaurantName:""},{email:"invalid"},{address:""},{address:"12 Market Street"},{mobile:"call me"},{password:"short"}]){
      const result=await f.json("/api/auth/restaurant-register",options({...application,...invalid}));
      assert.equal(result.status,400,result.text);assert.equal(result.body.error.code,"VALIDATION_ERROR");
    }
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM users").get().n,before);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM customer_transactional_email_outbox WHERE event_kind='business_application'").get().n,0);
  }finally{await f.close();}
});

test("a private pending application stores contacts and queues one branded acknowledgement across retries and login",async()=>{
  const f=await journeyFixture({rateLimit:{attempts:30,windowMs:60000}});
  try{
    const first=await f.json("/api/auth/restaurant-register",options(application));assert.equal(first.status,201,first.text);
    const received=first.body.data,cookie=first.headers.get("set-cookie").split(";",1)[0];
    assert.equal(received.applicationStatus,"pending");assert.match(received.message,/Calai team.*72 hours/);
    const user=f.db.prepare("SELECT * FROM users WHERE id=?").get(received.user.id),restaurant=f.db.prepare("SELECT * FROM restaurants WHERE id=?").get(received.restaurantId);
    assert.equal(user.phone,application.mobile);assert.notEqual(user.password_hash,application.password);assert.equal(restaurant.status,"pending");assert.equal(restaurant.address,application.address);assert.equal(restaurant.phone,application.mobile);
    const owned=await f.json("/api/restaurant/restaurants",{cookie});assert.equal(owned.body.data[0].profile.address,application.address);assert.equal(owned.body.data[0].acceptingOrders,false);
    const publicList=await f.json("/api/restaurants");assert.equal(publicList.body.data.some(row=>row.id===restaurant.id),false);
    const retry=await f.json("/api/auth/restaurant-register",options(application));assert.equal(retry.status,200,retry.text);assert.equal(retry.body.data.restaurantId,restaurant.id);
    const conflict=await f.json("/api/auth/restaurant-register",options({...application,password:"Different long password"}));assert.equal(conflict.status,409);
    const login=await f.json("/api/auth/login",{method:"POST",body:{email:application.email,password:application.password}});assert.equal(login.status,200,login.text);
    const duplicate=await f.json("/api/auth/restaurant-register",{method:"POST",body:application});assert.equal(duplicate.status,409);
    const rows=f.db.prepare("SELECT * FROM customer_transactional_email_outbox WHERE event_kind='business_application'").all();assert.equal(rows.length,1);
    const mail=buildCustomerEmail(rows[0],f.config);assert.equal(mail.from,"caleats-support@calai.info");assert.match(mail.text,/The Calai team will contact you within 72 hours/);assert.match(mail.html,/Cal-Eats/);assert.match(mail.html,/Pending review/);assert.equal(mail.text.includes(application.password),false);assert.equal(mail.text.includes(application.address),false);
    let sends=0;const worker=await runCustomerTransactionalEmails(f.db,f.config,{adapter:async(message,{beforeSend})=>{assert.equal(beforeSend(),true);assert.equal(message.to,application.email);sends++;return{status:"unknown",errorCode:"TEST_UNCERTAIN"};}});assert.equal(worker.unknown,1);
    await runCustomerTransactionalEmails(f.db,f.config,{adapter:async()=>{sends++;return{status:"sent"};}});assert.equal(sends,1);
    const admin=await f.login("admin@calai.local","LocalAdmin!4310"),detail=await f.json(`/api/admin/restaurants/${restaurant.id}/application`,{cookie:admin});assert.equal(detail.status,200,detail.text);assert.equal(detail.body.data.applicant.email,application.email);assert.equal(detail.body.data.mobile,application.mobile);assert.equal(detail.body.data.address,application.address);
    assert.equal((await f.json(`/api/admin/restaurants/${restaurant.id}/application`,{cookie})).status,403);
  }finally{await f.close();}
});

test("native restaurant application acknowledges receipt without signing a business into the customer app",async()=>{
  const f=await journeyFixture();
  try{
    const result=await f.json("/api/native/business/auth/apply",options({...application,email:"native-owner@example.test"}));assert.equal(result.status,201,result.text);assert.equal(result.body.data.applicationStatus,"pending");assert.equal(result.headers.has("set-cookie"),false);assert.equal("token" in result.body.data,false);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM native_sessions WHERE user_id=?").get(result.body.data.user.id).n,0);
  }finally{await f.close();}
});
