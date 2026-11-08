import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { customerLegalStatus, initializeCustomerLegal, loadCustomerLegalConfig } from "../src/customer-legal.js";
import { legalContentSha256, orderCustomerLegalSnapshot, orderCustomerTermsCopy } from "../src/customer-legal-archive.js";
import { buildCustomerEmail, runCustomerTransactionalEmails } from "../src/customer-emails.js";
import { journeyFixture } from "./helpers.js";

const documents = (version = "fixture-v1") => ({ enabled: true, documents: Object.fromEntries(["terms", "privacy"].map(kind => {
  const text = `Fictional ${kind} ${version}\n\nLocal fixture — no published policy. £11 after offers.\n<script>must render as text</script>\n\n`;
  return [kind, { version, text, sha256: legalContentSha256(text), url: `/legal/${kind}/${version}`, approvedAt: "2025-12-01T00:00:00.000Z", effectiveAt: "2026-01-01T00:00:00.000Z", approvalReference: "Fictional local fixture approval only" }];
})) });
const acceptance = policy => ({ termsVersion: policy.documents.terms.version, termsSha256: policy.documents.terms.sha256, termsAccepted: true, privacyVersion: policy.documents.privacy.version, privacySha256: policy.documents.privacy.sha256, privacyNoticeAcknowledged: true });
async function orderSetup(f) {
  const cookie = await f.login("customer@calai.local", "LocalCustomer!4310"), owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310");
  const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0], item = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
  const body = { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 2 }], paymentMethod: "cash", fulfillment: "collection" };
  return { cookie, owner, body, place: key => f.json("/api/orders", { method: "POST", cookie, headers: { "Idempotency-Key": key }, body }), agree: policy => f.json("/api/customer/legal/acceptances", { method: "POST", cookie, body: acceptance(policy) }) };
}

test("legal publication requires exact immutable UTF8 text and public version copies survive revisions and disabling", async () => {
  const initial = documents();
  for (const change of [document => { delete document.text; }, document => { document.text += "\n"; }, document => { document.archiveFile = "../private.txt"; delete document.text; }, document => { document.archiveFile = "terms.txt"; }]) {
    const invalid = documents(); change(invalid.documents.terms); assert.throws(() => loadCustomerLegalConfig(invalid, "http://127.0.0.1:4310"));
  }
  const f = await journeyFixture({ customerLegal: initial });
  try {
    const base = "/legal/terms/fixture-v1", text = await f.request(`${base}.txt`);
    assert.equal(text.status, 200); assert.equal(text.text, initial.documents.terms.text);
    assert.match(text.headers.get("content-type"), /^text\/plain/); assert.match(text.headers.get("content-disposition"), /attachment/);
    const html = await f.request(base); assert.equal(html.status, 200); assert.ok(html.text.includes("&lt;script&gt;must render as text&lt;/script&gt;")); assert.ok(!html.text.includes("<script>"));
    assert.match(html.text, /Document SHA-256/); assert.equal((await f.request(base, { method: "HEAD" })).text, "");
    const canonical = await f.request("/legal/terms"); assert.equal(canonical.status, 302); assert.equal(canonical.headers.get("location"), base);
    assert.equal((await f.request("/legal/terms/nonexistent")).status, 404);
    assert.equal((await f.request(`${base}?redirect=https://other.invalid`)).status, 404);
    assert.throws(() => f.db.prepare("UPDATE customer_legal_document_archive SET text_content='replacement' WHERE document_kind='terms'").run(), /immutable/);
    assert.throws(() => f.db.prepare("DELETE FROM customer_legal_document_archive WHERE document_kind='terms'").run(), /remain available/);
    const changed = documents(); changed.documents.terms.text += "Replacement"; changed.documents.terms.sha256 = legalContentSha256(changed.documents.terms.text);
    assert.throws(() => initializeCustomerLegal(f.db, { ...f.config, customerLegal: loadCustomerLegalConfig(changed, f.config.origin) }), /cannot be replaced/);
    f.config.customerLegal = loadCustomerLegalConfig(documents("fixture-v2"), f.config.origin); initializeCustomerLegal(f.db, f.config);
    assert.equal((await f.request(`${base}.txt`)).text, initial.documents.terms.text);
    f.config.customerLegal = loadCustomerLegalConfig(null, f.config.origin);
    assert.equal((await f.request("/legal/terms")).status, 404);
    assert.equal((await f.request(`${base}.txt`)).text, initial.documents.terms.text);
  } finally { await f.close(); }
});

test("new orders atomically snapshot accepted documents, while replays and legacy orders preserve contract and money", async () => {
  const f = await journeyFixture({ rateLimit: { attempts: 100, windowMs: 60000 } });
  try {
    const setup = await orderSetup(f), legacy = await setup.place("legacy-contract-order"); assert.equal(legacy.status, 201, legacy.text);
    assert.equal(legacy.body.data.legal, null); assert.equal(orderCustomerTermsCopy(f.db, legacy.body.data.id), null);
    const policy = documents(); f.config.customerLegal = loadCustomerLegalConfig(policy, f.config.origin); initializeCustomerLegal(f.db, f.config);
    assert.equal((await setup.agree(policy)).status, 200);
    const first = await setup.place("accepted-contract-order"); assert.equal(first.status, 201, first.text);
    const order = first.body.data, snapshot = orderCustomerLegalSnapshot(f.db, order.id);
    assert.equal(snapshot.terms.version, "fixture-v1"); assert.equal(snapshot.privacy.sha256, policy.documents.privacy.sha256);
    for (const field of ["grossFoodMinor", "restaurantDiscountMinor", "subtotalMinor", "deliveryFeeMinor", "totalMinor", "commissionMinor", "customerPayableMinor"]) assert.equal(order[field], legacy.body.data[field], field);
    assert.equal(orderCustomerTermsCopy(f.db, order.id).text, policy.documents.terms.text);
    assert.throws(() => f.db.prepare("UPDATE order_customer_legal_snapshots SET document_version='changed' WHERE order_id=?").run(order.id), /immutable/);
    const next = documents("fixture-v2"); f.config.customerLegal = loadCustomerLegalConfig(next, f.config.origin); initializeCustomerLegal(f.db, f.config);
    assert.equal(customerLegalStatus(f.db, f.config, order.customerId).termsAcceptanceRequired, true);
    const replay = await setup.place("accepted-contract-order"); assert.equal(replay.status, 200, replay.text); assert.deepEqual(replay.body.data.legal, order.legal);
    assert.equal((await setup.place("future-contract-order")).status, 428);
    assert.equal((await setup.agree(next)).status, 200); const second = await setup.place("future-contract-order"); assert.equal(second.status, 201, second.text); assert.equal(second.body.data.legal.terms.version, "fixture-v2");
    const receipt = await f.request(`/api/orders/${order.id}/receipt`, { cookie: setup.cookie }); assert.equal(receipt.status, 200); assert.match(receipt.text, /Customer Terms/); assert.ok(receipt.text.includes("/legal/terms/fixture-v1"));
    assert.equal((await f.request(`/api/orders/${legacy.body.data.id}/receipt`, { cookie: setup.cookie })).status, 200);
    assert.equal(orderCustomerLegalSnapshot(f.db, legacy.body.data.id), null);
    // Failure to preserve evidence rolls back the entire order, not just the snapshot.
    const count = f.db.prepare("SELECT COUNT(*) n FROM orders").get().n;
    f.db.exec("CREATE TRIGGER fixture_archive_failure BEFORE INSERT ON order_customer_legal_snapshots BEGIN SELECT RAISE(ABORT,'Fixture archive failure'); END;");
    assert.equal((await setup.place("atomic-contract-order")).status, 500); assert.equal(f.db.prepare("SELECT COUNT(*) n FROM orders").get().n, count);
  } finally { await f.close(); }
});

test("actual confirmation delivery contains the full exact accepted Terms after a later revision, without sending a provider request", async () => {
  const policy = documents(), f = await journeyFixture({ customerLegal: policy, orderAlertEmail: { mode: "local", from: "caleats-support@calai.info" } });
  try {
    const setup = await orderSetup(f); assert.equal((await setup.agree(policy)).status, 200);
    const placed = await setup.place("durable-contract-email"); assert.equal(placed.status, 201, placed.text); const order = placed.body.data;
    const confirm = await f.json(`/api/restaurant/orders/${order.id}/status`, { method: "PATCH", cookie: setup.owner, body: { status: "accepted", estimatedReadyAt: "2026-01-01T01:45:00.000Z" } }); assert.equal(confirm.status, 200, confirm.text);
    const queued = f.db.prepare("SELECT * FROM customer_transactional_email_outbox WHERE order_id=? AND event_kind='order_update'").get(order.id); assert.ok(queued);
    const payload = JSON.parse(queued.payload); assert.equal(payload.termsCopy.text, policy.documents.terms.text); assert.equal(payload.termsCopy.sha256, policy.documents.terms.sha256);
    f.config.customerLegal = loadCustomerLegalConfig(documents("fixture-v2"), f.config.origin); initializeCustomerLegal(f.db, f.config);
    const mail = buildCustomerEmail(queued, f.config); assert.ok(mail.text.endsWith(policy.documents.terms.text)); assert.ok(mail.text.includes("YOUR ACCEPTED CAL-EATS CUSTOMER TERMS")); assert.ok(!mail.text.includes("Fictional terms fixture-v2")); assert.ok(mail.html.includes("&lt;script&gt;must render as text&lt;/script&gt;"));
    assert.equal((await runCustomerTransactionalEmails(f.db, f.config)).localSaved, 1);
    const delivered = readFileSync(`${f.config.orderAlertEmail.localDirectory}/${queued.id}.eml`, "utf8");
    const body64 = /Content-Type: text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([^\r]+)/.exec(delivered)?.[1]; assert.ok(body64);
    assert.equal(Buffer.from(body64, "base64").toString("utf8"), mail.text);
    assert.equal((await runCustomerTransactionalEmails(f.db, f.config)).localSaved, 0);
    assert.equal(f.db.prepare("SELECT status FROM customer_transactional_email_outbox WHERE id=?").get(queued.id).status, "local_saved");
  } finally { await f.close(); }
});
