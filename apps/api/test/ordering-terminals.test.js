import test from "node:test";
import assert from "node:assert/strict";
import {createHash,generateKeyPairSync,randomBytes,sign} from "node:crypto";
import {journeyFixture} from "./helpers.js";
import {terminalCanonicalRequest,terminalPairingProof,orderingTerminalStatus} from "../src/ordering-terminals.js";
import {openDatabase,migrateDatabase} from "../src/db/index.js";
import {migrations} from "../src/db/migrations.js";
import {seedDemoData} from "../src/seed.js";
import {recordOrderFinancialEnvironment} from "../src/financial-environment.js";
import {enrollRestaurantDevice} from "./business-device-fixture.js";

const sha=value=>createHash("sha256").update(value).digest("hex");
async function fixture(){
  let now=Date.parse("2026-01-01T01:00:00.000Z");const f=await journeyFixture({now:()=>new Date(now),rateLimit:{attempts:200,windowMs:60000}});
  const owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),admin=await f.login("admin@calai.local","LocalAdmin!4310");
  const restaurant=f.db.prepare("SELECT r.* FROM restaurants r JOIN restaurant_memberships m ON m.restaurant_id=r.id JOIN users u ON u.id=m.user_id WHERE u.email='restaurant@calai.local'").get();
  const base=`/api/restaurant/restaurants/${restaurant.id}/terminal`,keys=generateKeyPairSync("ec",{namedCurve:"prime256v1"});
  let terminalId,token,browserCookie=owner,screenId=randomBytes(18).toString("base64url");
  const signed=async(path,{body={},method="POST",cookie,sessionToken=token,headers={}}={})=>{
    const timestamp=String(now),nonce=randomBytes(18).toString("base64url"),canonical=terminalCanonicalRequest({terminalId,timestamp,nonce,method,path,body:Buffer.from(JSON.stringify(body))});
    const all={"X-Cal-Eats-Terminal-Id":terminalId,"X-Cal-Eats-Terminal-Timestamp":timestamp,"X-Cal-Eats-Terminal-Nonce":nonce,"X-Cal-Eats-Terminal-Signature":sign("sha256",Buffer.from(canonical),{key:keys.privateKey,dsaEncoding:"ieee-p1363"}).toString("base64url"),...(sessionToken?{"X-Cal-Eats-Terminal-Session":sessionToken}:{}),...headers};
    return f.json(path,{method,body,cookie,headers:all});
  };
  const enroll=async(replace=false)=>{
    const issued=await f.json(`${base}/pairing-code`,{method:"POST",cookie:owner,body:{replace}});assert.equal(issued.status,201,issued.text);terminalId=issued.body.data.terminalId;
    const publicKeySpki=keys.publicKey.export({type:"spki",format:"der"}).toString("base64"),body={terminalId,code:issued.body.data.code,deviceName:"Test ordering tablet",publicKeySpki,challengeSignature:sign("sha256",Buffer.from(terminalPairingProof({...issued.body.data,publicKeySpki})),{key:keys.privateKey,dsaEncoding:"ieee-p1363"}).toString("base64url")};
    const paired=await f.json("/api/terminal-devices/pair",{method:"POST",body});assert.equal(paired.status,201,paired.text);return {issued,body,paired};
  };
  const link=async(cookie=owner)=>{
    browserCookie=cookie;const handoff=await f.json(`${base}/session-handoff`,{method:"POST",cookie,body:{screenId}});assert.equal(handoff.status,201,handoff.text);
    const grant=await signed(`/api/terminal-devices/${terminalId}/session`,{body:{handoffToken:handoff.body.data.handoffToken},sessionToken:null});assert.equal(grant.status,201,grant.text);token=grant.body.data.sessionToken;return pulse();
  };
  const pulse=async()=>{
    const challenge=await f.json(`${base}/screen-challenge`,{method:"POST",cookie:browserCookie,body:{screenId}});assert.equal(challenge.status,201,challenge.text);
    const result=await signed(`/api/terminal-devices/${terminalId}/screen-heartbeat`,{body:{screenId,challenge:challenge.body.data.challenge}});assert.equal(result.status,200,result.text);return {challenge,result};
  };
  const place=async()=>{
    const customer=await f.login("customer@calai.local","LocalCustomer!4310"),item=f.db.prepare("SELECT id FROM menu_items WHERE restaurant_id=? AND available=1 LIMIT 1").get(restaurant.id);
    const result=await f.json("/api/orders",{method:"POST",cookie:customer,headers:{"Idempotency-Key":randomBytes(16).toString("hex")},body:{restaurantId:restaurant.id,items:[{menuItemId:item.id,quantity:1}],fulfillment:"collection",paymentMethod:"mock_card"}});assert.equal(result.status,201,result.text);return {...result.body.data,customer};
  };
  return {...f,owner,admin,restaurant,base,keys,signed,enroll,link,pulse,place,terminalId:()=>terminalId,token:()=>token,screenId,advance:ms=>{now+=ms;}};
}

test("terminal enrollment is owner controlled, hashed, idempotent for its exact key and revocable",async()=>{
  const f=await fixture();try{
    const staff=f.db.prepare("SELECT u.id FROM users u WHERE u.email='staff@calai.local'").get();
    if(staff){const staffCookie=await f.login("staff@calai.local","LocalStaff!4310");assert.equal((await f.json(`${f.base}/pairing-code`,{method:"POST",cookie:staffCookie,body:{}})).status,403);}
    const {issued,body}=await f.enroll(),row=f.db.prepare("SELECT * FROM ordering_terminal_pair_codes WHERE terminal_id=?").get(f.terminalId());
    assert.equal(row.code_hash,sha(issued.body.data.code));assert.notEqual(row.code_hash,issued.body.data.code);assert.ok(row.consumed_at);
    assert.equal((await f.json("/api/terminal-devices/pair",{method:"POST",body})).status,201);
    const other=generateKeyPairSync("ec",{namedCurve:"prime256v1"}),publicKeySpki=other.publicKey.export({type:"spki",format:"der"}).toString("base64");
    const altered={...body,publicKeySpki,challengeSignature:sign("sha256",Buffer.from(terminalPairingProof({...issued.body.data,publicKeySpki})),{key:other.privateKey,dsaEncoding:"ieee-p1363"}).toString("base64url")};
    assert.equal((await f.json("/api/terminal-devices/pair",{method:"POST",body:altered})).status,401);
    assert.equal((await f.json(`${f.base}/pairing-code`,{method:"POST",cookie:f.owner,body:{}})).status,409);
    assert.equal((await f.signed(`/api/terminal-devices/${f.terminalId()}/heartbeat`,{sessionToken:null})).status,200);
    assert.equal((await f.json(`${f.base}/revoke`,{method:"POST",cookie:f.admin,body:{}})).status,200);
    assert.equal((await f.signed(`/api/terminal-devices/${f.terminalId()}/heartbeat`,{sessionToken:null})).status,403);
    assert.equal((await f.json("/api/terminal-devices/pair",{method:"POST",body})).status,401);
    const audits=JSON.stringify(f.db.prepare("SELECT details FROM audit_events WHERE entity_type='ordering_terminal'").all());assert.ok(!audits.includes(issued.body.data.code));
  }finally{await f.close();}
});

test("only fresh browser proof plus signed terminal grants order authority; native and ordinary web logins cannot",async()=>{
  const f=await fixture();try{
    await f.enroll();assert.equal(orderingTerminalStatus(f.db,f.config,f.restaurant.id).isReady,false);
    await f.signed(`/api/terminal-devices/${f.terminalId()}/heartbeat`,{sessionToken:null});assert.equal(orderingTerminalStatus(f.db,f.config,f.restaurant.id).isReady,false,"Background companion must not pretend the ordering screen is open");
    await f.link();assert.equal(orderingTerminalStatus(f.db,f.config,f.restaurant.id).isReady,true);
    const publicMembership=(await f.json("/api/restaurant/restaurants",{cookie:f.owner})).body.data.find(row=>row.id===f.restaurant.id);assert.equal(publicMembership.eligibleTerminalOperator,true);assert.equal(publicMembership.capabilities.canPrint,false);assert.equal(publicMembership.capabilities.canProcessOrders,false);
    const order=await f.place(),path=`/api/restaurant/orders/${order.id}/status`;
    assert.equal((await f.json(path,{method:"PATCH",cookie:f.owner,body:{status:"accepted"}})).status,403);
    const login=await f.json("/api/native/business/auth/login",{method:"POST",body:{email:"restaurant@calai.local",password:"LocalRestaurant!4310"}});assert.equal(login.status,200,login.text);assert.equal(login.body.data.businessAccess.canProcessOrders,false);assert.equal(login.body.data.businessAccess.canPrint,false);
    assert.equal((await f.json(path,{method:"PATCH",headers:{Authorization:`Bearer ${login.body.data.token}`},body:{status:"accepted"}})).status,403);
    const printer=await f.json(`/api/restaurant/restaurants/${f.restaurant.id}/printers`,{method:"POST",cookie:f.owner,body:{name:"Concurrent confirmation printer",enabled:true}});assert.equal(printer.status,201,printer.text);
    const simultaneous=await Promise.all([f.signed(path,{method:"PATCH",body:{status:"accepted"}}),f.signed(path,{method:"PATCH",body:{status:"accepted"}})]);for(const response of simultaneous)assert.equal(response.status,200,response.text);
    assert.equal((await f.signed(path,{method:"PATCH",body:{status:"accepted"}})).status,200,"Distinct signed retry preserves order confirmation idempotency");
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM order_events WHERE order_id=? AND to_status='accepted'").get(order.id).n,1);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM device_print_jobs WHERE order_id=? AND printer_id=? AND manual_reprint=0").get(order.id,printer.body.data.id).n,1,"Concurrent confirmation creates exactly one automatic printer operation");
    const delegatedChallenge=await f.signed(`${f.base}/screen-challenge`,{body:{screenId:f.screenId}});assert.equal(delegatedChallenge.status,403,"Only the original browser can issue screen-presence proofs");
    f.advance(60001);await f.signed(`/api/terminal-devices/${f.terminalId()}/heartbeat`,{sessionToken:null});assert.equal(orderingTerminalStatus(f.db,f.config,f.restaurant.id).isReady,false);
    assert.equal((await f.signed(path,{method:"PATCH",body:{status:"preparing"}})).status,409);
    await f.pulse();assert.equal((await f.signed(path,{method:"PATCH",body:{status:"preparing"}})).status,200);
    await f.json("/api/auth/logout",{method:"POST",cookie:f.owner,body:{}});assert.equal((await f.signed(path,{method:"PATCH",body:{status:"ready"}})).status,401,"Revoking the original web session revokes delegated authority immediately");
  }finally{await f.close();}
});

test("signatures bind exact body and route, reject replay and stale time, and do not allow another restaurant",async()=>{
  const f=await fixture();try{
    await f.enroll();await f.link();
    const path=`/api/terminal-devices/${f.terminalId()}/heartbeat`,timestamp=String(f.config.now().getTime()),nonce=randomBytes(18).toString("base64url");
    const headers={"X-Cal-Eats-Terminal-Id":f.terminalId(),"X-Cal-Eats-Terminal-Timestamp":timestamp,"X-Cal-Eats-Terminal-Nonce":nonce,"X-Cal-Eats-Terminal-Signature":sign("sha256",Buffer.from(terminalCanonicalRequest({terminalId:f.terminalId(),timestamp,nonce,method:"POST",path,body:Buffer.from("{}")})),{key:f.keys.privateKey,dsaEncoding:"ieee-p1363"}).toString("base64url")};
    assert.equal((await f.json(path,{method:"POST",body:{changed:true},headers})).status,401);
    assert.equal((await f.json(`${path}?changed=true`,{method:"POST",body:{},headers})).status,401);
    assert.equal((await f.json(path,{method:"POST",body:{},headers})).status,200);
    assert.equal((await f.json(path,{method:"POST",body:{},headers})).status,409);
    f.advance(60001);assert.equal((await f.json(path,{method:"POST",body:{},headers})).status,401);
    const foreign=f.db.prepare("SELECT id FROM restaurants WHERE id<>? LIMIT 1").get(f.restaurant.id);
    assert.equal((await f.signed(`/api/restaurant/restaurants/${foreign.id}/printers/not-real/test-receipt`)).status,403);
  }finally{await f.close();}
});

test("manual print, retry, ETA updates and headless printer claims cannot bypass terminal authority",async()=>{
  const f=await fixture();try{
    await f.enroll();await f.link();const order=await f.place();
    for(const [path,method,body] of [[`/api/orders/${order.id}/print-jobs`,"POST",{}],[`/api/restaurant/orders/${order.id}/preparation`,"PATCH",{estimatedReadyAt:"2026-01-01T01:30:00.000Z"}],[`/api/restaurant/restaurants/${f.restaurant.id}/printers/not-real/test-receipt`,"POST",{}]])assert.equal((await f.json(path,{method,cookie:f.owner,body})).status,403,path);
    const signed=await f.signed(`/api/orders/${order.id}/print-jobs`);assert.equal(signed.status,201,signed.text);
    assert.equal((await f.json(`/api/print-jobs/${signed.body.data.id}`,{method:"PATCH",cookie:f.owner,body:{status:"browser_opened"}})).status,403);
    for(const status of ["accepted","preparing","ready","completed"]){const moved=await f.signed(`/api/restaurant/orders/${order.id}/status`,{method:"PATCH",body:{status}});assert.equal(moved.status,200,moved.text);}
    assert.equal((await f.request(`/api/orders/${order.id}/receipt.pdf`,{cookie:order.customer})).status,200,"Customer receipt viewing stays available after completion");
    const now=f.config.now().toISOString(),pid=randomBytes(12).toString("hex"),device=randomBytes(12).toString("hex"),token=randomBytes(32).toString("base64url");
    f.db.prepare("INSERT INTO restaurant_printers(id,restaurant_id,name,enabled,created_at,updated_at) VALUES(?,?,?,1,?,?)").run(pid,f.restaurant.id,"Test printer",now,now);
    f.db.prepare("INSERT INTO printer_devices(id,printer_id,restaurant_id,name,token_hash,created_at) VALUES(?,?,?,?,?,?)").run(device,pid,f.restaurant.id,"Test device",sha(token),now);
    assert.equal((await f.json("/api/devices/jobs/claim",{method:"POST",headers:{Authorization:`Bearer ${token}`},body:{}})).status,403);
    const claimed=await f.signed("/api/devices/jobs/claim",{sessionToken:null,headers:{Authorization:`Bearer ${token}`}});assert.equal(claimed.status,200,claimed.text);
    assert.equal(f.db.prepare("SELECT ordering_terminal_id FROM printer_devices WHERE id=?").get(device).ordering_terminal_id,f.terminalId());
  }finally{await f.close();}
});

test("explicit staff capabilities permit only matching management routes and never banking or terminal enrollment",async()=>{
  const f=await fixture();try{
    const created=await f.json(`/api/restaurant/restaurants/${f.restaurant.id}/staff`,{method:"POST",cookie:f.owner,body:{name:"Manager",email:"manager-terminal@example.invalid",password:"ManagerTerminal!4310"}});assert.equal(created.status,201,created.text);
    const staff=f.db.prepare("SELECT id FROM users WHERE email='manager-terminal@example.invalid'").get(),cookie=await f.login("manager-terminal@example.invalid","ManagerTerminal!4310"),base=`/api/restaurant/restaurants/${f.restaurant.id}`;
    assert.equal((await f.json(`${base}/finance/summary`,{cookie})).status,403);
    const grant=await f.json(`${base}/staff/${staff.id}/capabilities`,{method:"PATCH",cookie:f.owner,body:{canViewFinance:true,canManageMenu:true,canManageCustomers:true}});assert.equal(grant.status,200,grant.text);
    assert.equal((await f.json(`${base}/finance/summary`,{cookie})).status,200);
    assert.equal((await f.json(`${base}/inbox`,{cookie})).status,200);
    assert.equal((await f.json(`${base}/menu`,{method:"POST",cookie,body:{name:"Manager item",priceMinor:100}})).status,201);
    assert.equal((await f.json(`${base}/finance/stripe/onboarding`,{method:"POST",cookie,body:{}})).status,403);
    assert.equal((await f.json(`${f.base}/pairing-code`,{method:"POST",cookie,body:{}})).status,403);
    assert.equal((await f.json(`${base}/staff/${staff.id}/capabilities`,{method:"PATCH",cookie,body:{canManageStaff:true}})).status,403);
    const native=await f.json("/api/native/business/auth/login",{method:"POST",body:{email:"manager-terminal@example.invalid",password:"ManagerTerminal!4310"}});assert.equal(native.body.data.businessAccess.restaurants[0].capabilities.canViewFinance,true);assert.equal(native.body.data.businessAccess.restaurants[0].capabilities.canProcessOrders,false);
    await f.enroll();await f.link();const order=await f.place(),conversation=`${base}/customers/${order.customerId}/conversation`;
    assert.equal((await f.json(`${base}/finance/orders/${order.id}/breakdown`,{cookie})).status,200,"Explicit finance viewers can open an order breakdown");
    const sent=await f.json(conversation,{method:"POST",cookie,headers:{"Idempotency-Key":"manager-conversation"},body:{message:"We can help with your order."}});assert.equal(sent.status,201,sent.text);
    const reply=await f.json(`/api/customer/conversations/${sent.body.data.threadId}/messages`,{method:"POST",cookie:order.customer,headers:{"Idempotency-Key":"manager-customer-reply"},body:{message:"Thank you, please check."}});assert.equal(reply.status,201,reply.text);
    const attention=await f.json(`${base}/message-attention`,{cookie});assert.equal(attention.body.data.unreadCount,1);assert.ok(attention.body.data.revision>0);
    await f.json(`${base}/staff/${staff.id}/capabilities`,{method:"PATCH",cookie:f.owner,body:{canManageCustomers:false}});
    assert.equal((await f.json(conversation,{cookie})).status,403);assert.equal((await f.json(`${base}/message-attention`,{cookie})).body.data.unreadCount,0,"Revoking customer access immediately removes CRM attention without changing the conversation history");
    const printer=await f.json(`${base}/printers`,{method:"POST",cookie:f.owner,body:{name:"Staff receipt review",enabled:true}});assert.equal(printer.status,201,printer.text);
    await f.link(cookie);const confirmed=await f.signed(`/api/restaurant/orders/${order.id}/status`,{method:"PATCH",body:{status:"accepted"}});assert.equal(confirmed.status,200,confirmed.text);
    const job=f.db.prepare("SELECT id FROM device_print_jobs WHERE order_id=? AND printer_id=?").get(order.id,printer.body.data.id);f.db.prepare("UPDATE device_print_jobs SET status='uncertain' WHERE id=?").run(job.id);
    const review=await f.signed(`${base}/printers/${printer.body.data.id}/jobs/${job.id}/check`,{body:{result:"receipt_found"}});assert.equal(review.status,200,review.text);assert.equal(review.body.data.status,"submitted","An authorized staff operator can check a receipt only through the signed active tablet");
    assert.equal((await f.json(`${base}/printers/${printer.body.data.id}/jobs`,{cookie})).status,200);
    await f.json(`${base}/staff/${staff.id}/capabilities`,{method:"PATCH",cookie:f.owner,body:{canProcessOrders:false}});
    assert.equal((await f.signed(`${base}/printers/${printer.body.data.id}/jobs/${job.id}/check`,{body:{result:"receipt_found"}})).status,403,"Revoking operational capability also revokes an existing delegated terminal operator");
    assert.equal((await f.json(`${base}/printers/${printer.body.data.id}/jobs`,{cookie})).status,403);
    await f.json(`${base}/staff/${staff.id}/capabilities`,{method:"PATCH",cookie:f.owner,body:{canViewDevices:true}});
    assert.equal((await f.json(`${base}/printers/${printer.body.data.id}/jobs`,{cookie})).status,200,"Device viewers may inspect history without receiving operational authority");
    assert.equal((await f.signed(`${base}/printers/${printer.body.data.id}/jobs/${job.id}/check`,{body:{result:"receipt_found"}})).status,403);
  }finally{await f.close();}
});

test("screen challenges and user handoffs are one-use and replacement immediately retires the prior identity",async()=>{
  const f=await fixture();try{
    await f.enroll();const oldId=f.terminalId();await f.link();
    const {challenge}=await f.pulse();
    assert.equal((await f.signed(`/api/terminal-devices/${oldId}/screen-heartbeat`,{body:{screenId:f.screenId,challenge:challenge.body.data.challenge}})).status,401,"A signed request with a fresh nonce still cannot reuse screen proof");
    const handoff=await f.json(`${f.base}/session-handoff`,{method:"POST",cookie:f.owner,body:{screenId:f.screenId}});
    const path=`/api/terminal-devices/${oldId}/session`,body={handoffToken:handoff.body.data.handoffToken};
    const granted=await f.signed(path,{body,sessionToken:null});assert.equal(granted.status,201,granted.text);
    assert.equal(orderingTerminalStatus(f.db,f.config,f.restaurant.id).isReady,false,"Replacing the delegated sign-in requires a fresh screen proof");
    assert.equal((await f.signed(path,{body,sessionToken:null})).status,401);
    await f.enroll(true);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ordering_terminals WHERE restaurant_id=? AND revoked_at IS NULL").get(f.restaurant.id).n,1);
    assert.ok(f.db.prepare("SELECT revoked_at FROM ordering_terminals WHERE id=?").get(oldId).revoked_at);
    assert.equal((await f.signed(`/api/terminal-devices/${oldId}/heartbeat`,{sessionToken:null})).status,403);
  }finally{await f.close();}
});

test("populated schema 63 upgrades without changing identities or printer credentials and reruns safely",async()=>{
  const db=openDatabase(":memory:"),now="2026-01-01T00:00:00.000Z";
  try{
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)");
    for(const migration of migrations.filter(row=>row.version<=63)){
      if(migration.foreignKeysOff)db.exec("PRAGMA foreign_keys=OFF");db.exec("BEGIN IMMEDIATE");db.exec(migration.sql);db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(migration.version,migration.name,now);db.exec("COMMIT");if(migration.foreignKeysOff)db.exec("PRAGMA foreign_keys=ON");
    }
    await seedDemoData(db,new Date(now));const membership=db.prepare("SELECT * FROM restaurant_memberships LIMIT 1").get(),users=db.prepare("SELECT id,password_hash FROM users ORDER BY id").all(),pid=randomBytes(12).toString("hex"),did=randomBytes(12).toString("hex"),tokenHash=sha("existing-fixture-printer-credential");
    db.prepare("INSERT INTO restaurant_printers(id,restaurant_id,name,enabled,created_at,updated_at) VALUES(?,?,?,1,?,?)").run(pid,membership.restaurant_id,"Existing printer",now,now);
    db.prepare("INSERT INTO printer_devices(id,printer_id,restaurant_id,name,token_hash,created_at) VALUES(?,?,?,?,?,?)").run(did,pid,membership.restaurant_id,"Existing machine",tokenHash,now);
    migrateDatabase(db);migrateDatabase(db);
    assert.deepEqual(db.prepare("SELECT id,password_hash FROM users ORDER BY id").all(),users);
    const device=db.prepare("SELECT token_hash,ordering_terminal_id FROM printer_devices WHERE id=?").get(did);assert.equal(device.token_hash,tokenHash);assert.equal(device.ordering_terminal_id,null);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM ordering_terminals").get().n,0,"Upgrade does not authorize any existing device or ordinary login");
    assert.equal(db.prepare("SELECT can_view_finance FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?").get(membership.restaurant_id,membership.user_id).can_view_finance,0);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);assert.equal(db.prepare("PRAGMA quick_check").get().quick_check,"ok");
  }finally{db.close();}
});

test("remote unpause cannot bypass terminal availability and a live terminal does not erase a manual pause",async()=>{
  const f=await fixture();try{
    const customer=await f.login("customer@calai.local","LocalCustomer!4310"),item=f.db.prepare("SELECT id FROM menu_items WHERE restaurant_id=? AND available=1 LIMIT 1").get(f.restaurant.id),body={restaurantId:f.restaurant.id,items:[{menuItemId:item.id,quantity:1}],fulfillment:"collection",paymentMethod:"mock_card"};
    const profile=`/api/restaurant/restaurants/${f.restaurant.id}/profile`;
    assert.equal((await f.json(profile,{method:"PATCH",cookie:f.owner,body:{paused:false,alwaysOpen:true}})).status,200);
    const blocked=await f.json("/api/orders/quote",{method:"POST",cookie:customer,body});assert.equal(blocked.status,409,blocked.text);assert.equal(blocked.body.error.code,"ORDERING_TABLET_UNAVAILABLE");
    await f.enroll();await f.link();assert.equal((await f.json("/api/orders/quote",{method:"POST",cookie:customer,body})).status,200);
    assert.equal((await f.json(profile,{method:"PATCH",cookie:f.owner,body:{paused:true}})).status,200);await f.pulse();
    assert.equal(f.db.prepare("SELECT paused FROM restaurants WHERE id=?").get(f.restaurant.id).paused,1);
    assert.equal((await f.json("/api/orders/quote",{method:"POST",cookie:customer,body})).status,409);
  }finally{await f.close();}
});

test("terminal revocation during delayed capture prevents acceptance and printing while retaining authoritative recovery",async()=>{
  const f=await fixture();let release=()=>{};
  try{
    await f.enroll();await f.link();const templateOrder=await f.place(),original=f.db.prepare("SELECT * FROM orders WHERE id=?").get(templateOrder.id),id=randomBytes(16).toString("hex"),order={...original,id,payment_method:"card",payment_status:"stripe_authorized",idempotency_key:`delayed-card-${id}`,request_hash:`delayed-card-${id}`};
    const columns=Object.keys(order);f.db.prepare(`INSERT INTO orders(${columns.join(",")}) VALUES(${columns.map(()=>"?").join(",")})`).run(...columns.map(key=>order[key]));
    for(const old of f.db.prepare("SELECT * FROM order_items WHERE order_id=?").all(original.id)){const item={...old,id:randomBytes(16).toString("hex"),order_id:id},names=Object.keys(item);f.db.prepare(`INSERT INTO order_items(${names.join(",")}) VALUES(${names.map(()=>"?").join(",")})`).run(...names.map(key=>item[key]));}
    const printer=await f.json(`/api/restaurant/restaurants/${f.restaurant.id}/printers`,{method:"POST",cookie:f.owner,body:{name:"Delayed capture printer",enabled:true}});assert.equal(printer.status,201,printer.text);
    let entered,captured=false,captures=0,retrieves=0;const gate=new Promise(resolve=>{release=resolve;}),captureEntered=new Promise(resolve=>{entered=resolve;});
    const facts=paymentState=>({status:"confirmed",paymentState,providerReference:"pi_terminalrevocation",paymentIntentId:"pi_terminalrevocation",amountMinor:order.total_minor,currency:order.currency,captureMethod:"manual",orderId:id,restaurantId:f.restaurant.id,latestChargeId:paymentState==="captured"?"ch_terminalrevocation":null});
    Object.assign(f.config,{paymentProviderMode:"stripe_test",stripePlatformAccountId:"acct_terminalfixture",paymentProviderWebhookSecret:"whsec_terminalfixture",paymentProviderConnectWebhookSecret:"whsec_terminalconnect",stripeProvider:{retrievePlatformAccount:async()=>({status:"confirmed",providerReference:"acct_terminalfixture"}),retrieveCheckoutSession:async()=>{retrieves++;return facts(captured?"captured":"authorized");},capturePayment:async()=>{captures++;entered();await gate;captured=true;return {status:"confirmed"};},retrievePayment:async()=>facts(captured?"captured":"authorized")}});
    recordOrderFinancialEnvironment(f.db,order,f.config);const now=f.config.now().toISOString();f.db.prepare("INSERT INTO stripe_order_payments(order_id,provider_mode,checkout_session_id,payment_intent_id,status,created_at,updated_at) VALUES(?,'stripe_test','cs_terminalrevocation','pi_terminalrevocation','authorized',?,?)").run(id,now,now);
    const path=`/api/restaurant/orders/${id}/status`,accepting=f.signed(path,{method:"PATCH",body:{status:"accepted"}});
    await Promise.race([captureEntered,accepting.then(result=>{throw Error(`Capture was not reached: ${result.text}`);})]);
    assert.equal((await f.json(`${f.base}/revoke`,{method:"POST",cookie:f.owner,body:{}})).status,200);release();
    const denied=await accepting;assert.equal(denied.status,403,denied.text);assert.equal(denied.body.error.code,"TERMINAL_REVOKED");assert.equal(captures,1);
    assert.equal(f.db.prepare("SELECT status FROM orders WHERE id=?").get(id).status,"placed");assert.equal(f.db.prepare("SELECT COUNT(*) n FROM order_events WHERE order_id=? AND to_status='accepted'").get(id).n,0);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM device_print_jobs WHERE order_id=?").get(id).n,0);
    const decision=f.db.prepare("SELECT * FROM stripe_order_decisions WHERE order_id=?").get(id);assert.equal(decision.state,"confirmed");assert.equal(JSON.parse(decision.provider_result).paymentState,"captured","Confirmed provider evidence survives the rejected merchant commit");
    await f.enroll();await f.link();const retried=await f.signed(path,{method:"PATCH",body:{status:"accepted"}});assert.equal(retried.status,200,retried.text);assert.equal(captures,1);assert.equal(retrieves,1,"Recovery reuses the confirmed decision without charging again");
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM order_events WHERE order_id=? AND to_status='accepted'").get(id).n,1);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM device_print_jobs WHERE order_id=?").get(id).n,1);
  }finally{release();await f.close();}
});

test("a newer USER grant invalidates older pending handoffs only for that terminal",async()=>{
  const f=await fixture();try{
    await f.enroll();await f.link();const screenA=randomBytes(18).toString("base64url"),screenB=randomBytes(18).toString("base64url"),secondBrowser=await f.login("restaurant@calai.local","LocalRestaurant!4310");
    const foreignCookie=await f.login("restaurant2@calai.local","LocalRestaurant2!4310"),foreign=f.db.prepare("SELECT r.id FROM restaurants r JOIN restaurant_memberships m ON m.restaurant_id=r.id JOIN users u ON u.id=m.user_id WHERE u.email='restaurant2@calai.local'").get(),other=await enrollRestaurantDevice(f,{restaurantId:foreign.id,cookie:foreignCookie});
    const issue=async(cookie,screenId,base=f.base)=>{const result=await f.json(`${base}/session-handoff`,{method:"POST",cookie,body:{screenId}});assert.equal(result.status,201,result.text);return result.body.data.handoffToken;};
    const oldA=await issue(f.owner,screenA),pendingOther=await issue(foreignCookie,randomBytes(18).toString("base64url"),`/api/restaurant/restaurants/${foreign.id}/terminal`),newB=await issue(secondBrowser,screenB);
    const path=`/api/terminal-devices/${f.terminalId()}/session`,activeB=await f.signed(path,{body:{handoffToken:newB},sessionToken:null});assert.equal(activeB.status,201,activeB.text);
    const stale=await f.signed(path,{body:{handoffToken:oldA},sessionToken:null});assert.equal(stale.status,401,stale.text);assert.equal(stale.body.error.code,"TERMINAL_HANDOFF_INVALID");
    const current=f.db.prepare("SELECT revoked_at FROM ordering_terminal_sessions WHERE token_hash=?").get(sha(activeB.body.data.sessionToken));assert.equal(current.revoked_at,null,"An old browser handoff must not revoke the newer USER grant");
    const challenge=await f.json(`${f.base}/screen-challenge`,{method:"POST",cookie:secondBrowser,body:{screenId:screenB}});assert.equal(challenge.status,201,challenge.text);
    const pulse=await f.signed(`/api/terminal-devices/${f.terminalId()}/screen-heartbeat`,{body:{screenId:screenB,challenge:challenge.body.data.challenge},sessionToken:activeB.body.data.sessionToken});assert.equal(pulse.status,200,pulse.text);
    const otherGrant=await other.headless(`/api/terminal-devices/${other.terminalId}/session`,{handoffToken:pendingOther});assert.equal(otherGrant.status,201,otherGrant.text);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ordering_terminal_sessions WHERE terminal_id=? AND revoked_at IS NULL").get(f.terminalId()).n,1);assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(),[]);
  }finally{await f.close();}
});
