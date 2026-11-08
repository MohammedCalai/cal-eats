import assert from "node:assert/strict";
import test from "node:test";
import { journeyFixture } from "./helpers.js";
import { notificationRecipientAllowed } from "../src/notification-stream.js";
import { runCustomerTransactionalEmails } from "../src/customer-emails.js";
import { applyCustomerErasure, planCustomerErasure } from "../src/customer-erasure.js";
import { runCustomerPrivacyRetention } from "../src/customer-privacy.js";
import { createBackup, BACKUP_ROOT } from "../../../scripts/backup.js";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

async function setup(f) {
  const owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310"), admin = await f.login("admin@calai.local", "LocalAdmin!4310"), customer = await f.login("customer@calai.local", "LocalCustomer!4310");
  const shop = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0];
  const menu = (await f.json(`/api/restaurants/${shop.id}/menu`)).body.data.items;
  const placed = await f.json("/api/orders", { cookie: customer, method: "POST", headers: { "Idempotency-Key": "safety-test-order" }, body: { restaurantId: shop.id, items: [{ menuItemId: menu[0].id, quantity: 1 }], fulfillment: "collection", paymentMethod: "mock_card" } });
  assert.equal(placed.status, 201, placed.text);
  const order = placed.body.data, conversation = `/api/restaurant/restaurants/${shop.id}/customers/${order.customerId}/conversation`;
  const sent = await f.json(conversation, { cookie: owner, method: "POST", headers: { "Idempotency-Key": "safety-merchant-message" }, body: { message: "A restaurant message" } });
  assert.equal(sent.status, 201, sent.text);
  const thread = f.db.prepare("SELECT id FROM restaurant_customer_threads WHERE restaurant_id=? AND customer_id=?").get(shop.id, order.customerId);
  return { owner, admin, customer, shop, order, conversation, message: sent.body.data, thread };
}

test("verified erasure removes populated block and safety-report links without leaving foreign references", async () => {
  const policy = { enabled:true, version:"privacy-safety-fixture", approvedAt:"2026-01-01T00:00:00.000Z", approvalReference:"isolated-safety-review-only", deletionTargetDays:30, deletionTargetCalendarMonths:1, retention:{chatDays:30,allergyDays:30,orderContactDays:90,resolvedSupportDays:30,accountingYears:6} };
  const f = await journeyFixture({ customerPrivacy:policy });
  try {
    const customer=await f.login("customer@calai.local","LocalCustomer!4310"), admin=await f.login("admin@calai.local","LocalAdmin!4310");
    const restaurant=f.db.prepare("SELECT id FROM restaurants LIMIT 1").get(), user=f.db.prepare("SELECT id FROM users WHERE email='customer@calai.local'").get(), adminId=f.db.prepare("SELECT id FROM users WHERE email='admin@calai.local'").get().id;
    const report=await f.json("/api/customer-safety/reports",{cookie:customer,method:"POST",headers:{"Idempotency-Key":"safety-erasure-report"},body:{restaurantId:restaurant.id,reason:"misleading_menu",details:"Review this menu"}});
    assert.equal(report.status,201,report.text);
    assert.equal((await f.json(`/api/customer-safety/restaurants/${restaurant.id}`,{cookie:customer,method:"PUT",body:{blocked:true}})).status,200);
    assert.equal((await f.json(`/api/support/${report.body.data.supportCaseId}`,{cookie:admin,method:"PATCH",body:{status:"resolved"}})).status,200);
    await runCustomerTransactionalEmails(f.db,f.config);
    const request=await f.json("/api/account/deletion-requests/verified",{cookie:customer,method:"POST",body:{password:"LocalCustomer!4310",confirm:"DELETE MY ACCOUNT"}});
    assert.equal(request.status,201,request.text);
    const requestId=request.body.data.id, plan=planCustomerErasure(f.db,user.id,{config:f.config,requestId});
    assert.equal(plan.eligible,true,JSON.stringify(plan.blockers));
    applyCustomerErasure(f.db,user.id,{requestId,adminId,config:f.config,note:"Identity and intent verified. All support and dispatch work is resolved.",previewHash:plan.previewHash});
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM customer_restaurant_safety WHERE customer_id=?").get(user.id).n,0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM customer_safety_reports WHERE customer_id=?").get(user.id).n,0);
    assert.equal(f.db.prepare("SELECT message FROM support_cases WHERE id=?").get(report.body.data.supportCaseId).message,"");
    assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(),[]);
  } finally { await f.close(); }
});

test("native safety reports validate ownership, retry once and stay privately in platform support with admin email", async () => {
  const f = await journeyFixture();
  try {
    const s = await setup(f), headers = { "Idempotency-Key": "safety-report-one" }, body = { restaurantId: s.shop.id, conversationId: s.thread.id, messageId: s.message.id, reason: "harassment", details: "Please review this message" };
    await f.json(s.conversation,{cookie:s.owner,method:"POST",headers:{"Idempotency-Key":"unreported-other-message"},body:{message:"Unreported private conversation text"}});
    const report = await f.json("/api/customer-safety/reports", { cookie: s.customer, method: "POST", headers, body });
    assert.equal(report.status, 201, report.text);
    const id = report.body.data.supportCaseId, ticket = f.db.prepare("SELECT * FROM support_cases WHERE id=?").get(id);
    assert.equal(ticket.restaurant_id, null); assert.equal(ticket.requester_restaurant_id, null);
    assert.equal((await f.json(`/api/support/${id}`, { cookie: s.owner })).status, 404);
    assert.equal((await f.json(`/api/support/${id}`, { cookie: s.admin })).status, 200);
    const review=(await f.json(`/api/support/${id}`,{cookie:s.admin})).body.data;
    assert.equal(review.messages.length,1); assert.ok(review.messages[0].message.includes("A restaurant message"));
    assert.equal(JSON.stringify(review).includes("Unreported private conversation text"),false);
    assert.equal(ticket.message.includes("A restaurant message"),false);
    const evidence=f.db.prepare("SELECT * FROM support_case_messages WHERE case_id=?").get(id);
    assert.equal(evidence.ciphertext.includes("A restaurant message"),false);
    assert.equal((await f.json("/api/admin/support?assignedTo=platform", { cookie: s.admin })).body.data.some(item => item.id === id), true);
    assert.equal((await f.json("/api/customer-safety/reports", { cookie: s.customer, method: "POST", headers, body })).status, 200);
    assert.equal((await f.json("/api/customer-safety/reports", { cookie: s.customer, method: "POST", headers, body: { ...body, details: "Different report" } })).status, 409);
    assert.equal((await f.json("/api/customer-safety/reports", { cookie: s.owner, method: "POST", headers, body })).status, 403);
    assert.equal((await f.json("/api/customer-safety/reports", { cookie: s.customer, method: "POST", headers: { "Idempotency-Key": "safety-foreign-order" }, body: { ...body, orderId: "someone-elses-order" } })).status, 404);
    assert.equal((await f.json("/api/customer-safety/reports", { cookie: s.customer, method: "POST", headers: { "Idempotency-Key": "safety-wrong-message" }, body: { ...body, messageId: "someone-elses-message" } })).status, 404);
    const recipients = f.db.prepare("SELECT recipient FROM customer_transactional_email_outbox WHERE support_case_id=? ORDER BY rowid").all(id).map(row => row.recipient);
    assert.deepEqual(recipients, ["admin@calai.local", "customer@calai.local"]);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM customer_safety_reports").get().n, 1);
    const destination=path.join(BACKUP_ROOT,`safety-${randomUUID()}.sqlite`);
    try {
      await createBackup({source:f.config.dbPath,destination});const copy=new DatabaseSync(destination,{readOnly:true});
      try {assert.equal(copy.prepare("SELECT COUNT(*) n FROM customer_safety_reports").get().n,0);assert.equal(copy.prepare("SELECT COUNT(*) n FROM support_case_messages WHERE id=?").get(evidence.id).n,0);assert.deepEqual(copy.prepare("PRAGMA foreign_key_check").all(),[]);}finally{copy.close();}
      assert.equal(fs.readFileSync(destination).includes(Buffer.from(evidence.ciphertext)),false);
      assert.equal(f.db.prepare("SELECT COUNT(*) n FROM support_case_messages WHERE id=?").get(evidence.id).n,1);
    } finally {fs.rmSync(destination,{force:true});}
    f.db.prepare("UPDATE support_cases SET status='resolved',updated_at='2025-11-01T00:00:00.000Z' WHERE id=?").run(id);
    f.config.customerPrivacy={enabled:true,version:"safety-retention-fixture",approvedAt:"2025-01-01",retention:{chatDays:30,allergyDays:30,orderContactDays:90,resolvedSupportDays:30,accountingYears:6}};
    runCustomerPrivacyRetention(f.db,f.config);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM customer_safety_reports WHERE case_id=?").get(id).n,0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM support_case_messages WHERE case_id=?").get(id).n,0);
    assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { await f.close(); }
});

test("restaurant block cancels queued contact, blocks new contact and offer reads, but retains history and system/support updates", async () => {
  const f = await journeyFixture();
  try {
    const s = await setup(f), blockPath = `/api/customer-safety/restaurants/${s.shop.id}`;
    assert.equal((await f.json(blockPath, { cookie: s.customer })).body.data.blocked, false);
    const notification = f.db.prepare("SELECT * FROM user_notifications WHERE user_id=? AND type='customer_message'").get(s.order.customerId);
    assert.equal(notificationRecipientAllowed(f.db, notification), true);
    const blocked = await f.json(blockPath, { cookie: s.customer, method: "PUT", body: { blocked: true } });
    assert.equal(blocked.status, 200, blocked.text); assert.equal(blocked.body.data.blocked, true);
    assert.equal(notificationRecipientAllowed(f.db, notification), false);
    assert.equal(f.db.prepare("SELECT status FROM customer_transactional_email_outbox WHERE notification_id=?").get(notification.id).status, "cancelled");
    assert.equal((await f.json(s.conversation, { cookie: s.owner, method: "POST", headers: { "Idempotency-Key": "blocked-new-contact" }, body: { message: "This must not arrive" } })).status, 409);
    const history = await f.json(`/api/customer/conversations/${s.thread.id}/messages`, { cookie: s.customer });
    assert.equal(history.status, 200); assert.equal(history.body.data.items[0].message, "A restaurant message");
    const orderMessage = await f.json(`/api/orders/${s.order.id}/messages`, { cookie: s.owner, method: "POST", headers: { "Idempotency-Key": "blocked-order-contact" }, body: { message: "This must not arrive either" } });
    assert.equal(orderMessage.status, 409, orderMessage.text);
    const accepted = await f.json(`/api/restaurant/orders/${s.order.id}/status`, { cookie: s.owner, method: "PATCH", body: { status: "accepted" } });
    assert.equal(accepted.status, 200, accepted.text);
    const update = f.db.prepare("SELECT * FROM user_notifications WHERE user_id=? AND type='order_status'").get(s.order.customerId);
    assert.equal(notificationRecipientAllowed(f.db, update), true);
    assert.equal((await f.json(`/api/promotions?restaurantId=${s.shop.id}`, { cookie: s.customer })).body.data.length, 0);
    const inbox = await f.json("/api/notifications", { cookie: s.customer });
    assert.equal(inbox.body.data.items.some(item => item.id === notification.id), false);
    // Exercise final dispatch revalidation as well as the immediate cancellation.
    f.db.prepare("UPDATE customer_transactional_email_outbox SET status='pending',last_error=NULL WHERE notification_id=?").run(notification.id);
    await runCustomerTransactionalEmails(f.db, f.config);
    assert.equal(f.db.prepare("SELECT status,last_error FROM customer_transactional_email_outbox WHERE notification_id=?").get(notification.id).last_error, "RESTAURANT_CONTACT_BLOCKED");
    const help = await f.json("/api/support", { cookie: s.customer, method: "POST", headers: { "Idempotency-Key": "blocked-platform-help" }, body: { subject: "Platform help", message: "I need Cal-Eats support" } });
    assert.equal(help.status, 201, help.text);
    const reply = await f.json(`/api/support/${help.body.data.id}/messages`, { cookie: s.admin, method: "POST", headers: { "Idempotency-Key": "blocked-admin-answer" }, body: { message: "Cal-Eats can still help" } });
    assert.equal(reply.status, 201, reply.text);
    const support = f.db.prepare("SELECT * FROM user_notifications WHERE user_id=? AND type='support_reply' ORDER BY rowid DESC LIMIT 1").get(s.order.customerId);
    assert.equal(notificationRecipientAllowed(f.db, support), true);
    assert.equal((await f.json(blockPath, { cookie: s.customer, method: "PUT", body: { blocked: false } })).body.data.blocked, false);
    assert.equal((await f.json(s.conversation, { cookie: s.owner, method: "POST", headers: { "Idempotency-Key": "unblocked-new-contact" }, body: { message: "Contact restored" } })).status, 201);
    assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { await f.close(); }
});
