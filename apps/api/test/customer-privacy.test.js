import assert from "node:assert/strict";
import test from "node:test";
import { journeyFixture } from "./helpers.js";
import { loadCustomerPrivacyConfig, orderHealthConsentNotice, requireOrderHealthConsent, runCustomerPrivacyRetention } from "../src/customer-privacy.js";

const approved = { enabled: true, version: "fixture-v1", approvedAt: "2025-12-01T00:00:00.000Z", approvalReference: "Fictional fixture approval only" };
const healthApproved = { ...approved, healthDataEnabled: true, healthDataApprovalReference: "Fictional provider coverage approval" };
const consent = { accepted: true, version: orderHealthConsentNotice.version, sha256: orderHealthConsentNotice.sha256 };
function orderBody(db) {
  const restaurant = db.prepare("SELECT id FROM restaurants WHERE name='Calai Kitchen'").get();
  const item = db.prepare("SELECT id FROM menu_items WHERE restaurant_id=? LIMIT 1").get(restaurant.id);
  return { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], paymentMethod: "cash", fulfillment: "collection" };
}
const customerLogin = f => f.login("customer@calai.local", "LocalCustomer!4310");

test("privacy controls default off and only reviewed dates, retention and separately approved health coverage enable them", () => {
  assert.equal(loadCustomerPrivacyConfig().enabled, false);
  assert.equal(loadCustomerPrivacyConfig(approved).healthDataEnabled, false);
  assert.throws(() => loadCustomerPrivacyConfig({ ...approved, approvalReference: "" }), /approval/);
  assert.throws(() => loadCustomerPrivacyConfig({ ...approved, approvedAt: "2025-12-01" }), /canonical/);
  assert.throws(() => loadCustomerPrivacyConfig({ ...approved, retention: { accountingYears: 5 } }), /reviewed policy/);
  assert.throws(() => loadCustomerPrivacyConfig({ ...approved, healthDataEnabled: true }), /provider-coverage/);
  assert.equal(loadCustomerPrivacyConfig(healthApproved).healthDataEnabled, true);
  assert.throws(()=>requireOrderHealthConsent({runMode:"hosted-preview",customerPrivacy:loadCustomerPrivacyConfig()},"Fictional note",consent),error=>error.code==="ALLERGY_COLLECTION_UNAVAILABLE");
  assert.doesNotThrow(()=>requireOrderHealthConsent({runMode:"hosted-preview",customerPrivacy:loadCustomerPrivacyConfig()},"",null));
  assert.equal(loadCustomerPrivacyConfig(approved).retention.resolvedSupportDays,30);
  assert.equal(loadCustomerPrivacyConfig(approved).deletionTargetDays,30);
  assert.throws(()=>loadCustomerPrivacyConfig({...approved,retention:{resolvedSupportMonths:12}}),/fields are invalid/);
  assert.throws(()=>loadCustomerPrivacyConfig({...approved,deletionTargetDays:31}),/30 days/);
});

test("new optional allergy notes require matching separate explicit consent and no notes are required to order", async () => {
  const f = await journeyFixture({ customerPrivacy: healthApproved });
  try {
    const cookie = await customerLogin(f), body = orderBody(f.db);
    const submit = (key, extra) => f.json("/api/orders", { method: "POST", cookie, headers: { "Idempotency-Key": key }, body: { ...body, ...extra } });
    const noConsent = await submit("health-missing", { allergyNotes: "Fictional allergy note" });
    assert.equal(noConsent.status, 428, noConsent.text);
    assert.equal(f.db.prepare("SELECT count(*) n FROM orders").get().n, 0);
    assert.equal((await submit("health-stale", { allergyNotes: "Fictional allergy note", allergyConsent: { ...consent, sha256: "0".repeat(64) } })).status, 409);
    assert.equal((await submit("health-false", { allergyNotes: "Fictional allergy note", allergyConsent: { ...consent, accepted: false } })).status, 400);
    const placed = await submit("health-accepted", { allergyNotes: "Fictional allergy note", allergyConsent: consent });
    assert.equal(placed.status, 201, placed.text);
    const evidence = f.db.prepare("SELECT * FROM order_health_consents WHERE order_id=?").get(placed.body.data.id);
    assert.equal(evidence.user_id, placed.body.data.customerId);
    assert.equal(evidence.notice_sha256, consent.sha256);
    assert.equal(evidence.policy_version, "fixture-v1");
    assert.equal(evidence.source, "web");
    assert.equal(JSON.stringify(evidence).includes("Fictional allergy note"), false);
    assert.equal(f.db.prepare("SELECT delivery_instructions FROM orders WHERE id=?").get(placed.body.data.id).delivery_instructions, "");
    const plain = await submit("health-not-needed", {});
    assert.equal(plain.status, 201, plain.text);
    assert.equal(f.db.prepare("SELECT count(*) n FROM order_health_consents").get().n, 1);
    const replay = await submit("health-accepted", { allergyNotes: "Fictional allergy note", allergyConsent: consent });
    assert.equal(replay.status, 200, replay.text);
  } finally { await f.close(); }
});

test("provider coverage gate blocks new health data while ordinary checkout and successful old replay remain available", async () => {
  const f = await journeyFixture();
  try {
    const cookie = await customerLogin(f), body = orderBody(f.db);
    const old = { ...body, allergyNotes: "Legacy fictional note" };
    const submit = (key, value) => f.json("/api/orders", { method: "POST", cookie, headers: { "Idempotency-Key": key }, body: value });
    assert.equal((await submit("legacy-health", old)).status, 201);
    f.config.customerPrivacy = loadCustomerPrivacyConfig(approved);
    const publicPolicy = await f.json("/api/customer/privacy");
    assert.equal(publicPolicy.body.data.healthDataEnabled, false);
    assert.equal(publicPolicy.body.data.healthConsent, null);
    assert.equal(JSON.stringify(publicPolicy.body).includes(approved.approvalReference), false);
    const blocked = await submit("new-health-blocked", { ...old, allergyConsent: consent });
    assert.equal(blocked.body.error.code, "ALLERGY_COLLECTION_UNAVAILABLE", blocked.text);
    assert.equal((await submit("ordinary-checkout", body)).status, 201);
    assert.equal((await submit("legacy-health", old)).status, 200);
    assert.equal(f.db.prepare("SELECT count(*) n FROM order_health_consents").get().n, 0);
  } finally { await f.close(); }
});

function insertOrder(db, id, customerId, status, terminalAt) {
  const restaurant = db.prepare("SELECT id,name FROM restaurants WHERE status='approved' LIMIT 1").get();
  db.prepare(`INSERT INTO orders(id,restaurant_id,restaurant_name,customer_id,status,subtotal_minor,delivery_fee_minor,total_minor,commission_minor,payment_method,payment_status,fulfillment,idempotency_key,request_hash,customer_name,customer_email,customer_phone,delivery_address,delivery_instructions,allergy_notes,created_at,updated_at) VALUES(?,?,?,?,?,1000,200,1200,84,'cash','cash_collected','delivery',?,?,'Private fixture customer','fixture@example.invalid','07100000000','{"line1":"Private fixture address"}','Private delivery note','Private allergy note',?,?)`).run(id, restaurant.id, restaurant.name, customerId, status, id, id, terminalAt, terminalAt);
  if (["completed", "rejected"].includes(status)) db.prepare("INSERT INTO order_events VALUES(?,?,NULL,'status',NULL,?,?)").run(`event-${id}`, id, status, terminalAt);
}

test("retention minimizes only expired eligible operational copies, respects holds and leaves monetary facts unchanged", async () => {
  const f = await journeyFixture();
  try {
    const customer = f.db.prepare("SELECT id FROM users WHERE role='customer' LIMIT 1").get().id;
    const admin = f.db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get().id;
    f.db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES('held-user','Held fixture','held@example.invalid','hash','customer','2025-01-01T00:00:00.000Z')").run();
    for (const [id,user,status,at] of [["expired",customer,"completed","2025-08-01T00:00:00.000Z"],["health-only",customer,"completed","2025-12-01T00:00:00.000Z"],["recent",customer,"completed","2025-12-20T00:00:00.000Z"],["active",customer,"preparing","2025-08-01T00:00:00.000Z"],["held","held-user","completed","2025-08-01T00:00:00.000Z"],["open-case",customer,"completed","2025-08-01T00:00:00.000Z"]]) insertOrder(f.db,id,user,status,at);
    f.db.prepare("INSERT INTO customer_erasure_holds VALUES('hold','held-user','legal_claim',?,'2025-12-01T00:00:00.000Z',NULL,NULL)").run(admin);
    f.db.prepare("INSERT INTO support_cases(id,user_id,order_id,subject,message,status,created_at,updated_at) VALUES('open-case-help',?,'open-case','Open support','Keep necessary details','open','2025-08-01T00:00:00.000Z','2025-08-01T00:00:00.000Z')").run(customer);
    const restaurant=f.db.prepare("SELECT restaurant_id FROM orders WHERE id='expired'").get().restaurant_id;
    f.db.prepare("INSERT INTO ledger_entries(id,order_id,restaurant_id,kind,amount_minor,created_at) VALUES('retained-ledger','expired',?,'commission_cash',84,'2025-08-01T00:00:00.000Z')").run(restaurant);
    f.db.prepare("INSERT INTO marketplace_operations(id,operation_key,restaurant_id,order_id,kind,status,amount_minor,provider_mode,created_at,updated_at) VALUES('retained-operation','fixture:commission',?,'expired','commission','confirmed',84,'local_simulator','2025-08-01T00:00:00.000Z','2025-08-01T00:00:00.000Z')").run(restaurant);
    for(const [id,account,direction]of [["debit","merchant_earnings","debit"],["credit","platform_commission","credit"]])f.db.prepare("INSERT INTO journal_postings(id,group_id,operation_key,restaurant_id,order_id,account,direction,amount_minor,source_type,source_id,provider_mode,created_at) VALUES(?,'fixture-group','fixture:commission',?,'expired',?,?,84,'order','expired','local_simulator','2025-08-01T00:00:00.000Z')").run(id,restaurant,account,direction);
    const monetary = () => f.db.prepare("SELECT id,restaurant_id,customer_id,status,subtotal_minor,delivery_fee_minor,total_minor,commission_minor,payment_method,payment_status,offer_snapshot,promotion_snapshot,commission_control_snapshot,updated_at FROM orders ORDER BY id").all();
    const accounting=()=>Object.fromEntries(["ledger_entries","marketplace_operations","journal_postings"].map(table=>[table,f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
    const before = monetary(), accountingBefore=accounting();
    const inactive = runCustomerPrivacyRetention(f.db, f.config);
    assert.equal(inactive.enabled, false);
    assert.equal(f.db.prepare("SELECT allergy_notes FROM orders WHERE id='expired'").get().allergy_notes, "Private allergy note");
    f.config.customerPrivacy = loadCustomerPrivacyConfig(approved);
    f.config.now = () => new Date("2026-01-01T12:00:00.000Z");
    const result = runCustomerPrivacyRetention(f.db, f.config);
    assert.equal(result.allergyNotes, 2);
    assert.equal(result.orderContacts, 1);
    const expired = f.db.prepare("SELECT * FROM orders WHERE id='expired'").get();
    assert.equal(expired.allergy_notes, ""); assert.equal(expired.customer_name, ""); assert.equal(expired.delivery_address, null);
    const healthOnly = f.db.prepare("SELECT * FROM orders WHERE id='health-only'").get();
    assert.equal(healthOnly.allergy_notes, ""); assert.equal(healthOnly.customer_phone, "07100000000");
    for (const id of ["recent","active","held","open-case"]) assert.equal(f.db.prepare("SELECT allergy_notes FROM orders WHERE id=?").get(id).allergy_notes, "Private allergy note",id);
    assert.deepEqual(monetary(), before);
    assert.deepEqual(accounting(),accountingBefore,"Accounting and monetary evidence must remain unchanged");
    const again = runCustomerPrivacyRetention(f.db,f.config);
    assert.equal(again.allergyNotes,0); assert.equal(again.orderContacts,0);
    assert.equal(f.db.prepare("SELECT count(*) n FROM privacy_retention_runs").get().n,1);
    assert.equal(JSON.stringify(f.db.prepare("SELECT counts_json FROM privacy_retention_runs").all()).includes("Private"),false);
  } finally { await f.close(); }
});

test("settled print copies lose only expired health/contact fields and unresolved printer work stays untouched",async()=>{
  const f=await journeyFixture({customerPrivacy:approved});
  try {
    const customer=f.db.prepare("SELECT id FROM users WHERE role='customer' LIMIT 1").get().id;
    for(const id of ["settled-print","pending-print"])insertOrder(f.db,id,customer,"completed","2025-08-01T00:00:00.000Z");
    const restaurant=f.db.prepare("SELECT restaurant_id FROM orders LIMIT 1").get().restaurant_id;
    f.db.prepare("INSERT INTO restaurant_printers(id,restaurant_id,name,created_at,updated_at) VALUES('printer',?,'Fixture printer','2025-08-01T00:00:00.000Z','2025-08-01T00:00:00.000Z')").run(restaurant);
    const receipt={format:"cal-eats-receipt-v1",customerName:"Private fixture name",customerPhone:"07100000000",deliveryAddress:{line1:"Private address"},orderNotes:"Private delivery note",allergyNotes:"Private allergy note",items:[{name:"Fixture meal",quantity:1,unitPriceMinor:1000,totalMinor:1000}],subtotalMinor:1000,deliveryFeeMinor:200,totalMinor:1200,currency:"GBP"};
    for(const [id,status]of [["settled-print","printed"],["pending-print","queued"]])f.db.prepare("INSERT INTO device_print_jobs(id,printer_id,order_id,operation_key,receipt,status,created_at,updated_at) VALUES(?,'printer',?,?,?,?, '2025-08-01T00:00:00.000Z','2025-08-01T00:00:00.000Z')").run(id,id,`print:${id}`,JSON.stringify(receipt),status);
    f.config.now=()=>new Date("2026-01-01T12:00:00.000Z");
    const result=runCustomerPrivacyRetention(f.db,f.config);
    assert.equal(result.printCopies,1);
    const scrubbed=JSON.parse(f.db.prepare("SELECT receipt FROM device_print_jobs WHERE id='settled-print'").get().receipt);
    assert.equal(scrubbed.customerName,"");assert.equal(scrubbed.customerPhone,undefined);assert.equal(scrubbed.deliveryAddress,undefined);assert.equal(scrubbed.orderNotes,undefined);assert.equal(scrubbed.allergyNotes,undefined);
    assert.equal(scrubbed.totalMinor,receipt.totalMinor);assert.deepEqual(scrubbed.items,receipt.items);
    assert.equal(f.db.prepare("SELECT receipt FROM device_print_jobs WHERE id='pending-print'").get().receipt,JSON.stringify(receipt));
    assert.equal(f.db.prepare("SELECT allergy_notes FROM orders WHERE id='pending-print'").get().allergy_notes,"Private allergy note");
    assert.equal(runCustomerPrivacyRetention(f.db,f.config).printCopies,0);
  }finally{await f.close();}
});

test("resolved support expires exactly after 30 elapsed days while recent, open and held cases remain", async () => {
  const f = await journeyFixture({ customerPrivacy: approved });
  try {
    const user=f.db.prepare("SELECT id FROM users WHERE role='customer' LIMIT 1").get().id;
    const admin=f.db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get().id;
    f.db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES('held-support-user','Fixture','held-support@example.invalid','not-a-login','customer','2025-01-01T00:00:00.000Z')").run();
    f.db.prepare("INSERT INTO customer_erasure_holds VALUES('support-hold','held-support-user','legal_claim',?,'2026-02-01T00:00:00.000Z',NULL,NULL)").run(admin);
    for(const [id,status,at,who] of [["old","resolved","2026-03-01T12:00:00.000Z",user],["open","open","2026-01-01T12:00:00.000Z",user],["recent","resolved","2026-03-01T12:00:00.001Z",user],["held","resolved","2026-01-01T12:00:00.000Z","held-support-user"]]) f.db.prepare("INSERT INTO support_cases(id,user_id,subject,message,status,created_at,updated_at) VALUES(?,?,'Private subject','Private body',?,?,?)").run(id,who,status,at,at);
    f.db.prepare("INSERT INTO support_case_messages VALUES('reply','old',?,'customer','fixture','hash','Private encrypted body','nonce','tag','key','2026-03-01T12:00:00.000Z')").run(user);
    f.config.now=()=>new Date("2026-03-31T12:00:00.000Z");
    const result=runCustomerPrivacyRetention(f.db,f.config);
    assert.equal(result.supportCases,1);assert.equal(result.supportMessages,1);
    assert.equal(f.db.prepare("SELECT message FROM support_cases WHERE id='old'").get().message,"");
    for(const id of ["open","recent","held"])assert.equal(f.db.prepare("SELECT message FROM support_cases WHERE id=?").get(id).message,"Private body");
    assert.equal(runCustomerPrivacyRetention(f.db,f.config).supportCases,0);
  } finally { await f.close(); }
});
