import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { journeyFixture } from "./helpers.js";

const exportPath = "/api/admin/customers/app-activity.csv";
const firstSignIn = "2026-10-21T08:00:00.000Z";
const lastSignIn = "2026-10-29T12:00:00.000Z";
const now = "2026-11-10T12:00:00.000Z";
const headers = '\uFEFF"Email","Orders placed (all channels)","Orders completed (all channels)","First app sign-in (UTC)","Last app sign-in (UTC)"\r\n';

test("admin customer app CSV exports retained app sign-ins and account order counts with an aggregate audit", async () => {
  const f = await journeyFixture({ now: () => new Date(now) });
  try {
    const adminCookie = await f.login("admin@calai.local", "LocalAdmin!4310");
    const ownerCookie = await f.login("restaurant@calai.local", "LocalRestaurant!4310");
    const customerCookie = await f.login("customer@calai.local", "LocalCustomer!4310");
    assert.equal((await f.request(exportPath)).status, 401);
    assert.equal((await f.request(exportPath, { cookie: ownerCookie })).status, 403);
    assert.equal((await f.request(exportPath, { cookie: customerCookie })).status, 403);

    const native = await f.json("/api/native/auth/login", {
      method: "POST",
      body: { email: "customer@calai.local", password: "LocalCustomer!4310" }
    });
    assert.equal(native.status, 200, native.text);
    const customerBearer = { authorization: "Bearer " + native.body.data.token };
    assert.equal((await f.request(exportPath, { headers: customerBearer })).status, 403);

    const addCustomer = (email, name, phone = "", enabled = 1) => {
      const id = randomUUID();
      f.db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at,phone,account_enabled) VALUES(?,?,?,'fixture','customer',?,?,?)")
        .run(id, name, email, firstSignIn, phone, enabled);
      return id;
    };
    const signIn = (userId, created, expiry, revoked = null) => {
      f.db.prepare("INSERT INTO native_sessions(id,user_id,token_hash,created_at,expires_at,revoked_at) VALUES(?,?,?,?,?,?)")
        .run(randomUUID(), userId, randomUUID(), created, expiry, revoked);
    };
    const primaryEmail = "reader@example.invalid";
    const phone = "07700 900123";
    const primary = addCustomer(primaryEmail, "Reader_One", phone);
    const former = addCustomer("+inactive@example.invalid", "Inactive customer", "", 0);
    const webOnly = addCustomer("web@example.invalid", "Web-only customer");
    const erased = addCustomer("erased@example.invalid", "Erased customer");
    const adminId = f.db.prepare("SELECT id FROM users WHERE email='admin@calai.local'").get().id;
    signIn(primary, lastSignIn, "2026-11-29T12:00:00.000Z");
    signIn(primary, firstSignIn, "2026-11-01T12:00:00.000Z", "2026-10-31T12:00:00.000Z");
    signIn(former, firstSignIn, "2026-11-01T12:00:00.000Z");
    signIn(erased, firstSignIn, now);
    signIn(adminId, firstSignIn, now);

    const erasureRequest = randomUUID();
    f.db.prepare("INSERT INTO deletion_requests(id,user_id,reason,status,created_at,updated_at) VALUES(?,?,'','resolved',?,?)")
      .run(erasureRequest, erased, now, now);
    f.db.prepare("INSERT INTO customer_erasure_requests(request_id,user_id,verified_at,due_at,policy_version,status,completed_at) VALUES(?,?,?,?,?,'completed',?)")
      .run(erasureRequest, erased, now, now, "test", now);
    f.db.prepare("INSERT INTO customer_erasure_tombstones VALUES(?,?,?,?,'[]','{}',?,'fixture')")
      .run(erased, erasureRequest, now, "test", adminId);

    const restaurants = f.db.prepare("SELECT id,name FROM restaurants ORDER BY id").all();
    function place(restaurant, customer, status) {
      const id = randomUUID();
      f.db.prepare("INSERT INTO orders(id,restaurant_id,restaurant_name,customer_id,status,subtotal_minor,total_minor,commission_minor,payment_method,payment_status,fulfillment,idempotency_key,request_hash,created_at,updated_at) VALUES(?,?,?,?,?,1000,1000,0,'cash','cash_due','collection',?,'fixture',?,?)")
        .run(id, restaurant.id, restaurant.name, customer, status, id, firstSignIn, now);
    }
    place(restaurants[0], primary, "completed");
    place(restaurants[1], primary, "completed");
    place(restaurants[1], primary, "rejected");
    place(restaurants[0], webOnly, "completed");

    const report = await f.request(exportPath, { cookie: adminCookie });
    assert.equal(report.status, 200, report.text);
    assert.equal(report.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.equal(report.headers.get("content-disposition"), 'attachment; filename="Cal-Eats-customer-app-activity.csv"');
    assert.equal(report.headers.get("cache-control"), "no-store");
    assert.equal(report.headers.get("x-content-type-options"), "nosniff");
    assert.equal(report.headers.get("content-length"), report.bodyBuffer.length);
    const formerRow = `"'+inactive@example.invalid","0","0","${firstSignIn}","${firstSignIn}"\r\n`;
    const primaryRow = `"${primaryEmail}","3","2","${firstSignIn}","${lastSignIn}"\r\n`;
    assert.equal(report.text, headers + formerRow + primaryRow);

    for (const query of ["  READER_  ", primaryEmail, phone]) {
      const filtered = await f.request(exportPath + "?q=" + encodeURIComponent(query), { cookie: adminCookie });
      assert.equal(filtered.status, 200, filtered.text);
      assert.equal(filtered.text, headers + primaryRow);
    }
    const none = await f.request(exportPath + "?q=%25", { cookie: adminCookie });
    assert.equal(none.status, 200, none.text);
    assert.equal(none.text, headers);
    const invalid = await f.json(exportPath + "?q=" + "a".repeat(161), { cookie: adminCookie });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, "VALIDATION_ERROR");

    const audit = f.db.prepare("SELECT actor_user_id,entity_type,entity_id,details FROM audit_events WHERE action='customer_app_activity_csv_exported' ORDER BY rowid").all();
    assert.deepEqual(audit.map(row => ({ ...row, details: JSON.parse(row.details) })), [
      { rowCount: 2, filtered: false },
      { rowCount: 1, filtered: true },
      { rowCount: 1, filtered: true },
      { rowCount: 1, filtered: true },
      { rowCount: 0, filtered: true }
    ].map(details => ({ actor_user_id: adminId, entity_type: "customer_app_activity", entity_id: "platform", details })));
  } finally {
    await f.close();
  }
});
