import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { journeyFixture } from "./helpers.js";
import { planCustomerErasure, applyCustomerErasure, runCustomerErasureConfirmations } from "../src/customer-erasure.js";
import { customerErasureDueAt } from "../src/privacy-deadline.js";

const policy={enabled:true,version:"privacy-fixture-v1",approvedAt:"2026-01-01T00:00:00.000Z",approvalReference:"isolated-fixture-review-only",deletionTargetDays:30,deletionTargetCalendarMonths:1,retention:{chatDays:30,allergyDays:30,orderContactDays:90,resolvedSupportDays:30,accountingYears:6}};
const note="Identity and intent verified using in-app password confirmation. No unresolved work or legal hold remains.";
const insert=(db,table,row)=>db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(()=>"?").join(",")})`).run(...Object.values(row));
const digest=db=>createHash("sha256").update(JSON.stringify({orders:db.prepare("SELECT id,customer_id,restaurant_id,status,currency,subtotal_minor,delivery_fee_minor,total_minor,commission_minor,payment_method,payment_status,contract_rate_bps,contract_policy_version,commission_base,gross_food_minor,restaurant_discount_minor,customer_payable_minor,platform_voucher_minor FROM orders ORDER BY id").all(),items:db.prepare("SELECT id,order_id,menu_item_id,name,unit_price_minor,quantity,base_price_minor,is_offer_item FROM order_items ORDER BY id").all(),ledger:db.prepare("SELECT * FROM ledger_entries ORDER BY id").all(),journal:db.prepare("SELECT * FROM journal_postings ORDER BY id").all(),operations:db.prepare("SELECT id,order_id,kind,status,amount_minor,currency,provider_mode,provider_reference FROM marketplace_operations ORDER BY id").all()})).digest("hex");

test("deletion targets use the earlier of 30 elapsed days and a clamped calendar month",()=>{
  assert.equal(customerErasureDueAt("2026-01-31T01:00:00.000Z"),"2026-02-28T01:00:00.000Z");
  assert.equal(customerErasureDueAt("2024-01-31T01:00:00.000Z"),"2024-02-29T01:00:00.000Z");
  assert.equal(customerErasureDueAt("2026-03-01T01:00:00.000Z"),"2026-03-31T01:00:00.000Z");
  assert.equal(customerErasureDueAt("2026-04-01T01:00:00.000Z"),"2026-05-01T01:00:00.000Z");
  assert.throws(()=>customerErasureDueAt("not a date"),/valid original request time/);
});

test("verified customer deletion: review, blockers, atomic minimisation, financial preservation and safe completion",async()=>{
  let stamp="2026-01-31T01:00:00.000Z";
  const f=await journeyFixture({now:()=>new Date(stamp),customerPrivacy:policy,rateLimit:{attempts:100,windowMs:60000}});
  try{
    const customer=await f.login("customer@calai.local","LocalCustomer!4310"),admin=await f.login("admin@calai.local","LocalAdmin!4310"),owner=await f.login("restaurant@calai.local","LocalRestaurant!4310");
    const user=f.db.prepare("SELECT * FROM users WHERE email='customer@calai.local'").get(),adminId=f.db.prepare("SELECT id FROM users WHERE email='admin@calai.local'").get().id,ownerId=f.db.prepare("SELECT id FROM users WHERE email='restaurant@calai.local'").get().id;
    const intake=(cookie=customer,body={password:"LocalCustomer!4310",confirm:"DELETE MY ACCOUNT"})=>f.json("/api/account/deletion-requests/verified",{method:"POST",cookie,body});
    assert.equal((await intake(owner)).status,403);assert.equal((await intake(admin)).status,403);
    assert.equal((await intake(customer,{password:"incorrect",confirm:"DELETE MY ACCOUNT"})).status,401);
    assert.equal((await intake(customer,{password:"LocalCustomer!4310",confirm:"yes"})).status,400);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM customer_erasure_requests").get().n,0);
    const legacy=await f.json("/api/account/deletion-requests",{method:"POST",cookie:customer,body:{reason:"An earlier optional reason"}});assert.equal(legacy.status,201,legacy.text);
    f.db.prepare("UPDATE deletion_requests SET created_at='2026-01-01T01:00:00.000Z' WHERE id=?").run(legacy.body.data.id);
    insert(f.db,"deletion_requests",{id:randomUUID(),user_id:user.id,reason:"Later duplicate request",status:"requested",note:"",created_at:"2026-01-20T01:00:00.000Z",updated_at:stamp});
    const unverified=await f.json(`/api/admin/deletion-requests/${legacy.body.data.id}/erasure-preview`,{cookie:admin});assert.equal(unverified.status,200,unverified.text);assert.ok(unverified.body.data.blockers.some(b=>b.code==="VERIFIED_REQUEST_REQUIRED"));
    const requested=await intake();assert.equal(requested.status,201,requested.text);assert.equal(requested.body.data.id,legacy.body.data.id);assert.equal(requested.body.data.requestedAt,"2026-01-01T01:00:00.000Z");assert.equal(requested.body.data.verifiedAt,stamp);assert.equal(requested.body.data.dueAt,"2026-01-31T01:00:00.000Z");
    assert.deepEqual((await intake()).body,requested.body);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM deletion_requests WHERE user_id=?").get(user.id).n,2);
    const requestId=requested.body.data.id,route=`/api/admin/deletion-requests/${requestId}`;
    const preview=()=>f.json(`${route}/erasure-preview`,{cookie:admin}),erase=(previewHash,cookie=admin)=>f.json(`${route}/erase-customer`,{method:"POST",cookie,body:{confirm:"ERASE CUSTOMER DATA",note,previewHash}});
    assert.equal((await f.json("/api/account/erasure-requests",{cookie:customer})).body.data[0].id,requestId);
    assert.equal((await erase("x",owner)).status,403);
    // Holding membership alone disqualifies even a role accidentally left as customer.
    const restaurant=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0],item=(await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
    insert(f.db,"restaurant_memberships",{restaurant_id:restaurant.id,user_id:user.id,created_at:stamp,permission:"staff"});assert.throws(()=>planCustomerErasure(f.db,user.id,{config:f.config,requestId}),e=>e.code==="CUSTOMER_ERASURE_ONLY");f.db.prepare("DELETE FROM restaurant_memberships WHERE user_id=?").run(user.id);
    const placed=await f.json("/api/orders",{method:"POST",cookie:customer,headers:{"Idempotency-Key":"privacy-financial-order"},body:{restaurantId:restaurant.id,items:[{menuItemId:item.id,quantity:2}],paymentMethod:"cash",fulfillment:"collection"}});assert.equal(placed.status,201,placed.text);const orderId=placed.body.data.id;
    assert.ok((await preview()).body.data.blockers.some(b=>b.code==="ACTIVE_ORDERS"));assert.equal((await erase((await preview()).body.data.previewHash)).body.error.code,"CUSTOMER_ERASURE_BLOCKED");
    for(const status of ["accepted","preparing","ready","completed"]){const changed=await f.json(`/api/restaurant/orders/${orderId}/status`,{method:"PATCH",cookie:owner,body:{status}});assert.equal(changed.status,200,changed.text);}
    const holdId=randomUUID();insert(f.db,"customer_erasure_holds",{id:holdId,user_id:user.id,reason_code:"dispute",created_by:adminId,created_at:stamp});assert.ok((await preview()).body.data.blockers.some(b=>b.code==="LEGAL_HOLD"));f.db.prepare("UPDATE customer_erasure_holds SET released_at=? WHERE id=?").run(stamp,holdId);
    const opId=randomUUID();insert(f.db,"marketplace_operations",{id:opId,operation_key:opId,restaurant_id:restaurant.id,order_id:orderId,kind:"payment_capture",status:"unknown",amount_minor:100,currency:"GBP",provider_mode:"local_simulator",metadata:JSON.stringify({customerEmail:user.email,feeMinor:7}),created_at:stamp,updated_at:stamp});assert.ok((await preview()).body.data.blockers.some(b=>b.code==="UNFINISHED_FINANCIAL_OPERATIONS"));f.db.prepare("UPDATE marketplace_operations SET status='cancelled' WHERE id=?").run(opId);
    const caseId=randomUUID();insert(f.db,"support_cases",{id:caseId,user_id:user.id,order_id:orderId,subject:"Private help subject",message:"Private initial help",status:"open",created_at:stamp,updated_at:stamp,waiting_for:"team"});assert.ok((await preview()).body.data.blockers.some(b=>b.code==="OPEN_SUPPORT_CASES"));f.db.prepare("UPDATE support_cases SET status='resolved',waiting_for='none' WHERE id=?").run(caseId);
    const otherId=randomUUID();insert(f.db,"users",{id:otherId,name:"Unrelated Customer",email:"unrelated@privacy-fixture.invalid",password_hash:user.password_hash,role:"customer",created_at:stamp,phone:"07000000002"});
    for(const id of [user.id,otherId])insert(f.db,"saved_addresses",{id:randomUUID(),user_id:id,label:"Home",line1:id===user.id?"Private Road":"Other Road",line2:"",city:"Luton",postcode:"LU1 1AA",created_at:stamp,updated_at:stamp});
    f.db.prepare("UPDATE users SET phone='07000000001',merchant_offers=1 WHERE id=?").run(user.id);
    f.db.prepare("UPDATE orders SET customer_name='Private Name',customer_email=?,customer_phone='07000000001',delivery_address='Private Road',delivery_instructions='Private gate code',allergy_notes='Private allergy',offer_snapshot=? WHERE id=?").run(user.email,JSON.stringify({id:"offer-reference",title:"Private Name offer",discountMinor:100,fundingParty:"restaurant"}),orderId);
    const threadId=randomUUID();insert(f.db,"restaurant_customer_threads",{id:threadId,restaurant_id:restaurant.id,customer_id:user.id,status:"resolved",created_at:stamp,updated_at:stamp,last_message_at:stamp});
    insert(f.db,"restaurant_customer_messages",{id:randomUUID(),thread_id:threadId,sender_user_id:user.id,sender_role:"customer",idempotency_key:"message",request_hash:"fixture",ciphertext:"private-encrypted-content",nonce:"fixture",auth_tag:"fixture",key_version:"v1",created_at:stamp,expires_at:"2026-03-01T00:00:00.000Z",ingest_sequence:1});
    insert(f.db,"order_messages",{id:randomUUID(),order_id:orderId,sender_user_id:user.id,sender_role:"customer",idempotency_key:"message",request_hash:"fixture",ciphertext:"private-order-message",nonce:"fixture",auth_tag:"fixture",key_version:"v1",created_at:stamp,expires_at:"2026-03-01T00:00:00.000Z"});
    insert(f.db,"support_case_messages",{id:randomUUID(),case_id:caseId,sender_user_id:user.id,sender_role:"customer",idempotency_key:"message",request_hash:"fixture",ciphertext:"private-support-message",nonce:"fixture",auth_tag:"fixture",key_version:"v1",created_at:stamp});
    insert(f.db,"restaurant_customer_workflows",{restaurant_id:restaurant.id,customer_id:user.id,workflow_status:"vip",note:"Private restaurant note",updated_by_user_id:ownerId,updated_at:stamp});
    insert(f.db,"restaurant_order_ratings",{order_id:orderId,restaurant_id:restaurant.id,customer_id:user.id,stars:5,created_at:stamp});
    const nativeId=randomUUID();insert(f.db,"native_sessions",{id:nativeId,user_id:user.id,token_hash:"fixture-native-token",created_at:stamp,expires_at:"2026-03-01T00:00:00.000Z"});
    const deviceId=randomUUID();insert(f.db,"customer_push_devices",{id:deviceId,installation_id:randomUUID(),user_id:user.id,session_id:nativeId,token_hash:"fixture-push-token",ciphertext:"private-push-token",nonce:"fixture",auth_tag:"fixture",key_version:"v1",platform:"ios",project_id:randomUUID(),generation:1,sound_enabled:0,expires_at:"2026-03-01T00:00:00.000Z",created_at:stamp,updated_at:stamp});
    const activityId=randomUUID();insert(f.db,"customer_order_live_activities",{id:activityId,activity_id:randomUUID(),installation_id:randomUUID(),user_id:user.id,session_id:nativeId,order_id:orderId,project_id:randomUUID(),token_hash:"fixture-activity-token",ciphertext:"private-activity-token",key_version:"v1",generation:1,state:"ended",expires_at:"2026-03-01T00:00:00.000Z",created_at:stamp,updated_at:stamp});
    const notificationId=randomUUID();insert(f.db,"user_notifications",{id:notificationId,user_id:user.id,type:"order_message",title:"Private notification",message:"Private summary",order_id:orderId,event_key:notificationId,created_at:stamp});
    f.db.prepare("UPDATE customer_push_outbox SET status='claimed',attempts=1,lease_owner='fixture',lease_expires_at='2026-02-01T01:00:00.000Z' WHERE notification_id=?").run(notificationId);assert.ok((await preview()).body.data.blockers.some(b=>b.code==="PUSH_DISPATCH_IN_PROGRESS"));f.db.prepare("UPDATE customer_push_outbox SET status='cancelled' WHERE user_id=?").run(user.id);
    insert(f.db,"order_live_activity_outbox",{activity_id:activityId,generation:1,revision:1,status:"cancelled",attempts:0,updated_at:stamp});
    insert(f.db,"local_mail_sink",{id:randomUUID(),user_id:user.id,kind:"password_reset",recipient:user.email,subject:"Private subject",body:"Private token",created_at:stamp});
    const otherBefore=f.db.prepare("SELECT * FROM users WHERE id=?").get(otherId),otherAddresses=f.db.prepare("SELECT * FROM saved_addresses WHERE user_id=?").all(otherId),moneyBefore=digest(f.db);
    const ready=(await preview()).body.data;assert.equal(ready.eligible,true,JSON.stringify(ready.blockers));assert.ok(ready.counts.savedAddresses>0);assert.ok(!JSON.stringify(ready).includes(user.email));assert.ok(!JSON.stringify(ready).includes("Private Road"));
    // A stale preview cannot authorise deleting newly changed data.
    f.db.prepare("UPDATE saved_addresses SET line1='Changed private road' WHERE user_id=?").run(user.id);assert.equal((await erase(ready.previewHash)).body.error.code,"ERASURE_PREVIEW_CHANGED");
    // Force a failure midway through the transaction: every earlier deletion must roll back.
    const current=(await preview()).body.data;
    f.db.exec("CREATE TRIGGER fixture_erasure_rollback BEFORE UPDATE OF password_hash ON users WHEN NEW.password_hash='!deleted' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;");
    assert.throws(()=>applyCustomerErasure(f.db,user.id,{requestId,adminId,config:f.config,note,previewHash:current.previewHash}),/fixture rollback/);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM saved_addresses WHERE user_id=?").get(user.id).n,1);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM order_messages WHERE order_id=?").get(orderId).n,1);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM customer_erasure_tombstones").get().n,0);assert.equal(digest(f.db),moneyBefore);f.db.exec("DROP TRIGGER fixture_erasure_rollback");
    const completed=await erase((await preview()).body.data.previewHash);assert.equal(completed.status,200,completed.text);assert.equal(completed.body.data.status,"completed");assert.equal(digest(f.db),moneyBefore);
    const erased=f.db.prepare("SELECT * FROM users WHERE id=?").get(user.id);assert.equal(erased.name,"Deleted customer");assert.equal(erased.email,`deleted-${user.id}@account.invalid`);assert.equal(erased.password_hash,"!deleted");assert.equal(erased.phone,"");assert.equal(erased.account_enabled,0);
    for(const table of ["saved_addresses","sessions","native_sessions","native_business_sessions","account_access_tokens","local_mail_sink","customer_push_devices","customer_push_outbox","customer_order_live_activities","marketing_preferences"])assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get(user.id).n,0,table);
    for(const table of ["order_messages","support_case_messages","restaurant_customer_messages","restaurant_order_ratings","restaurant_customer_workflows","user_notifications"])assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,table);
    const order=f.db.prepare("SELECT * FROM orders WHERE id=?").get(orderId);for(const field of ["customer_name","customer_email","customer_phone","delivery_instructions","allergy_notes"])assert.equal(order[field],"",field);assert.equal(order.delivery_address,null);assert.deepEqual(JSON.parse(order.offer_snapshot),{id:"offer-reference",discountMinor:100,fundingParty:"restaurant"});
    assert.equal(f.db.prepare("SELECT message FROM support_cases WHERE id=?").get(caseId).message,"");assert.equal(f.db.prepare("SELECT COUNT(*) n FROM order_live_activity_outbox").get().n,0);
    assert.deepEqual(f.db.prepare("SELECT * FROM users WHERE id=?").get(otherId),otherBefore);assert.deepEqual(f.db.prepare("SELECT * FROM saved_addresses WHERE user_id=?").all(otherId),otherAddresses);
    const retry=await erase("stale-preview-does-not-mutate-completed-account");assert.equal(retry.status,200,retry.text);assert.deepEqual(retry.body,completed.body);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='customer_data_erased'").get().n,1);
    assert.equal((await f.json("/api/auth/me",{cookie:customer})).status,401);
    assert.throws(()=>insert(f.db,"saved_addresses",{id:randomUUID(),user_id:user.id,label:"Restored",line1:"Must not return",line2:"",city:"Luton",postcode:"LU1 1AA",created_at:stamp,updated_at:stamp}),/erased/);
    assert.throws(()=>f.db.prepare("UPDATE users SET account_enabled=1 WHERE id=?").run(user.id),/cannot be restored/);
    assert.throws(()=>f.db.prepare("UPDATE orders SET customer_name='Restore leak' WHERE id=?").run(orderId),/cannot be restored/);
    const confirmation=f.db.prepare("SELECT * FROM customer_erasure_confirmation_outbox").get();assert.equal(confirmation.status,"pending");assert.ok(!JSON.stringify(confirmation).includes(user.email));
    let sent;
    const delivery=await runCustomerErasureConfirmations(f.db,f.config,{adapter:async(message,{beforeSend})=>{assert.equal(f.db.prepare("SELECT COUNT(*) n FROM customer_erasure_tombstones WHERE user_id=?").get(user.id).n,1);assert.equal(beforeSend(),true);sent=message;return{status:"sent"};}});assert.equal(delivery.sent,1);assert.equal(sent.to,user.email);assert.match(sent.text,/does not require you to sign in/);assert.equal(f.db.prepare("SELECT ciphertext FROM customer_erasure_confirmation_outbox").get().ciphertext,null);
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length,0);
  }finally{await f.close();}
});

test("privacy erasure remains off without reviewed policy and completion receipts expire without delivery",async()=>{
  let stamp="2026-01-01T01:00:00.000Z";const f=await journeyFixture({now:()=>new Date(stamp),rateLimit:{attempts:100,windowMs:60000}});
  try{
    const customer=await f.login("customer@calai.local","LocalCustomer!4310"),body={password:"LocalCustomer!4310",confirm:"DELETE MY ACCOUNT"};
    assert.equal((await f.json("/api/customer/privacy-policy")).body.data.enabled,false);
    assert.equal((await f.json("/api/customer/privacy-policy")).body.data.deletionTargetDays,30);
    const denied=await f.json("/api/account/deletion-requests/verified",{method:"POST",cookie:customer,body});assert.equal(denied.status,503,denied.text);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM customer_erasure_requests").get().n,0);
    f.config.customerPrivacy=policy;const accepted=await f.json("/api/account/deletion-requests/verified",{method:"POST",cookie:customer,body});assert.equal(accepted.status,201,accepted.text);
    const userId=f.db.prepare("SELECT id FROM users WHERE email='customer@calai.local'").get().id,adminId=f.db.prepare("SELECT id FROM users WHERE email='admin@calai.local'").get().id,requestId=accepted.body.data.id;
    applyCustomerErasure(f.db,userId,{requestId,adminId,config:f.config,note,previewHash:planCustomerErasure(f.db,userId,{config:f.config,requestId,now:stamp}).previewHash});
    stamp="2026-01-09T01:00:00.000Z";let calls=0;await runCustomerErasureConfirmations(f.db,f.config,{adapter:async()=>{calls++;return{status:"sent"};}});assert.equal(calls,0);const row=f.db.prepare("SELECT status,ciphertext FROM customer_erasure_confirmation_outbox").get();assert.equal(row.status,"cancelled");assert.equal(row.ciphertext,null);
  }finally{await f.close();}
});
