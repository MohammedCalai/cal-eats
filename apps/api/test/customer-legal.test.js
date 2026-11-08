import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { createApp } from "../src/app.js";
import { customerLegalStatus, initializeCustomerLegal, loadCustomerLegalConfig } from "../src/customer-legal.js";
import { legalContentSha256 } from "../src/customer-legal-archive.js";
import { journeyFixture } from "./helpers.js";

// These complete texts are fictional local fixtures, not published policies.
const documents = (terms = "fixture-terms-1", privacy = "fixture-privacy-1") => ({ enabled: true, documents: Object.fromEntries([["terms", terms], ["privacy", privacy]].map(([kind, version]) => { const text = `Fictional ${kind} ${version}\n\nExact local fixture text only.\n`; return [kind, { version, text, sha256: legalContentSha256(text), url: `/legal/${kind}/${version}`, approvedAt: "2025-12-01T00:00:00.000Z", effectiveAt: "2026-01-01T00:00:00.000Z", approvalReference: "Fictional local fixture only" }]; })) });
const submission = policy => ({ termsVersion: policy.documents.terms.version, termsSha256: policy.documents.terms.sha256, termsAccepted: true, privacyVersion: policy.documents.privacy.version, privacySha256: policy.documents.privacy.sha256, privacyNoticeAcknowledged: true });

test("unconfigured legal review is disabled and records no acceptance for legacy registration", async () => {
  const f = await journeyFixture();
  try {
    assert.deepEqual((await f.json("/api/customer/legal")).body.data, { enabled: false, terms: null, privacy: null, termsAcceptanceRequired: false, privacyAcknowledgementRequired: false });
    const signup = await f.json("/api/native/auth/register", { method: "POST", body: { name: "Local Legal Fixture", email: "disabled-legal@fixture.invalid", password: "Fictional signup password 4310!" } });
    assert.equal(signup.status, 201, signup.text);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM customer_legal_documents").get().n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM customer_legal_acceptances").get().n, 0);
    assert.equal((await f.json("/api/customer/legal/acceptances", { method: "POST", headers: { authorization: `Bearer ${signup.body.data.token}` }, body: {} })).status, 409);
  } finally { await f.close(); }
});

test("activation needs typed, approved owned-document identities and rejects mutable versions", async () => {
  for (const [field, value] of [["version", true], ["version", 123], ["sha256", null], ["url", null], ["approvedAt", 1], ["effectiveAt", 1], ["url", "https://unrelated.invalid/legal/terms/v1"], ["url", "/legal/terms/v1?token=private"], ["url", "https://user:password@localhost/legal/v1"], ["approvalReference", ""], ["approvedAt", "2026-03-01T00:00:00.000Z"]]) {
    const input = documents(); input.documents.terms[field] = value;
    assert.throws(() => loadCustomerLegalConfig(input, "http://127.0.0.1:4310"), `${field}:${String(value)}`);
  }
  const f = await journeyFixture({ customerLegal: documents() });
  try {
    const changed = documents(); changed.documents.terms.text += "Changed fixture"; changed.documents.terms.sha256 = legalContentSha256(changed.documents.terms.text);
    assert.throws(() => initializeCustomerLegal(f.db, { ...f.config, customerLegal: loadCustomerLegalConfig(changed, f.config.origin) }), /cannot be replaced/);
    assert.equal(f.db.prepare("SELECT content_sha256 FROM customer_legal_documents WHERE kind='terms'").get().content_sha256, documents().documents.terms.sha256);
  } finally { await f.close(); }
});

test("web/native signup requires exact affirmative versions and atomically preserves immutable evidence", async () => {
  const policy = documents(), f = await journeyFixture({ customerLegal: policy, rateLimit: { attempts: 100, windowMs: 60000 } });
  try {
    const identity = { name: "Legal Fixture Customer", email: "legal-native@fixture.invalid", password: "Fictional signup password 4310!" }, accepted = submission(policy);
    for (const legalAcceptance of [undefined, { ...accepted, termsAccepted: false }, { ...accepted, termsAccepted: "true" }, { ...accepted, privacyNoticeAcknowledged: false }, { ...accepted, termsVersion: "old-fixture" }]) {
      const denied = await f.json("/api/native/auth/register", { method: "POST", body: { ...identity, legalAcceptance } });
      assert.ok([400, 409, 428].includes(denied.status), denied.text);
      assert.equal(f.db.prepare("SELECT 1 FROM users WHERE email=?").get(identity.email), undefined);
    }
    const native = await f.json("/api/native/auth/register", { method: "POST", body: { ...identity, legalAcceptance: accepted } }); assert.equal(native.status, 201, native.text);
    const userId = native.body.data.user.id, headers = { authorization: `Bearer ${native.body.data.token}` };
    const rows = () => f.db.prepare("SELECT * FROM customer_legal_acceptances WHERE user_id=? ORDER BY document_kind").all(userId);
    const before = rows(); assert.equal(before.length, 2); assert.ok(before.every(row => row.channel === "native" && row.context === "signup" && row.acknowledged_at));
    assert.equal(f.db.prepare("SELECT merchant_offers FROM users WHERE id=?").get(userId).merchant_offers, 0);
    assert.equal(f.db.prepare("SELECT * FROM marketing_preferences WHERE user_id=?").get(userId), undefined);
    assert.equal((await f.json("/api/customer/legal/acceptances", { method: "POST", headers, body: accepted })).status, 200); assert.deepEqual(rows(), before);
    assert.throws(() => f.db.prepare("UPDATE customer_legal_acceptances SET document_sha256=? WHERE user_id=?").run("d".repeat(64), userId), /immutable/);
    const web = await f.json("/api/auth/register", { method: "POST", body: { ...identity, email: "legal-web@fixture.invalid", legalAcceptance: accepted } }); assert.equal(web.status, 201, web.text);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM customer_legal_acceptances WHERE user_id=? AND channel='web'").get(web.body.data.user.id).n, 2);
    const sessionCount = f.db.prepare("SELECT COUNT(*) n FROM native_sessions").get().n;
    f.db.exec("CREATE TRIGGER fixture_reject_legal_evidence BEFORE INSERT ON customer_legal_acceptances WHEN (SELECT email FROM users WHERE id=NEW.user_id)='legal-rollback@fixture.invalid' BEGIN SELECT RAISE(ABORT,'Fixture evidence failure'); END;");
    const rollback = await f.json("/api/native/auth/register", { method: "POST", body: { ...identity, email: "legal-rollback@fixture.invalid", legalAcceptance: accepted } }); assert.equal(rollback.status, 500, rollback.text);
    assert.equal(f.db.prepare("SELECT 1 FROM users WHERE email='legal-rollback@fixture.invalid'").get(), undefined); assert.equal(f.db.prepare("SELECT COUNT(*) n FROM native_sessions").get().n, sessionCount);
  } finally { await f.close(); }
});

test("existing users retain account rights; privacy-only updates and new terms are separate from original-order retries", async () => {
  const f = await journeyFixture({ customerLegal: documents(), rateLimit: { attempts: 100, windowMs: 60000 } });
  try {
    const cookie = await f.login("customer@calai.local", "LocalCustomer!4310"), owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310");
    const userId = f.db.prepare("SELECT id FROM users WHERE email='customer@calai.local'").get().id;
    for (const route of ["/api/auth/me", "/api/account", "/api/account/export", "/api/account/deletion-requests", "/api/support"]) assert.equal((await f.json(route, { cookie })).status, 200, route);
    const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0], item = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
    const body = { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], paymentMethod: "cash", fulfillment: "collection" };
    assert.equal((await f.json("/api/orders/quote", { method: "POST", cookie, body })).status, 200);
    const order = key => f.json("/api/orders", { method: "POST", cookie, headers: { "Idempotency-Key": key }, body });
    assert.equal((await order("legal-order-one")).status, 428);
    assert.equal((await f.json("/api/customer/legal/acceptances", { method: "POST", cookie, body: submission(documents()) })).status, 200);
    const placed = await order("legal-order-one"); assert.equal(placed.status, 201, placed.text);
    const originalTerms = f.db.prepare("SELECT * FROM customer_legal_acceptances WHERE user_id=? AND document_kind='terms'").get(userId);
    f.config.customerLegal = loadCustomerLegalConfig(documents("fixture-terms-1", "fixture-privacy-2"), f.config.origin); initializeCustomerLegal(f.db, f.config);
    let status = customerLegalStatus(f.db, f.config, userId); assert.equal(status.termsAcceptanceRequired, false); assert.equal(status.privacyAcknowledgementRequired, true);
    assert.equal((await order("legal-order-two")).status, 428);
    assert.equal((await order("legal-order-one")).body.data.id, placed.body.data.id);
    assert.equal((await f.json("/api/customer/legal/acceptances", { method: "POST", cookie, body: submission(documents()) })).status, 409);
    const privacy = f.config.customerLegal.documents.privacy;
    assert.equal((await f.json("/api/customer/legal/acceptances", { method: "POST", cookie, body: { privacyVersion: privacy.version, privacySha256: privacy.sha256, privacyNoticeAcknowledged: true } })).status, 200);
    assert.deepEqual(f.db.prepare("SELECT * FROM customer_legal_acceptances WHERE user_id=? AND document_kind='terms'").get(userId), originalTerms);
    f.config.customerLegal = loadCustomerLegalConfig(documents("fixture-terms-2", "fixture-privacy-2"), f.config.origin); initializeCustomerLegal(f.db, f.config);
    status = customerLegalStatus(f.db, f.config, userId); assert.equal(status.termsAcceptanceRequired, true); assert.equal(status.privacyAcknowledgementRequired, false);
    assert.equal((await f.json("/api/account/export", { cookie })).status, 200);
    assert.equal((await f.json("/api/account/deletion-requests", { method: "POST", cookie, body: { reason: "Fictional in-app privacy request" } })).status, 201);
    assert.equal((await f.json("/api/customer/legal/acceptances", { method: "POST", cookie: owner, body: {} })).status, 403);
    const terms = f.config.customerLegal.documents.terms;
    assert.equal((await f.json("/api/customer/legal/acceptances", { method: "POST", cookie, body: { termsVersion: terms.version, termsSha256: terms.sha256, termsAccepted: true } })).status, 200);
    assert.equal((await order("legal-order-two")).status, 201);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM customer_legal_acceptances WHERE user_id=? AND document_kind='terms'").get(userId).n, 2);
  } finally { await f.close(); }
});

test("a native acceptance delayed in transit cannot acknowledge a superseded privacy notice", async () => {
  const f = await journeyFixture({ customerLegal: documents() });
  try {
    const login = await f.json("/api/native/auth/login", { method: "POST", body: { email: "customer@calai.local", password: "LocalCustomer!4310" } });
    let enterBody, releaseBody; const started = new Promise(resolve => { enterBody = resolve; }), held = new Promise(resolve => { releaseBody = resolve; });
    const payload = submission(documents()), req = Readable.from((async function* () { enterBody(); await held; yield Buffer.from(JSON.stringify(payload)); })());
    Object.assign(req, { method: "POST", url: "/api/customer/legal/acceptances", headers: { host: f.config.expectedHost, authorization: `Bearer ${login.body.data.token}`, "content-type": "application/json" }, socket: { remoteAddress: "127.0.0.1" } });
    const response = new Promise(resolve => { const res = { headersSent: false, statusCode: 200, setHeader() {}, writeHead(status) { this.statusCode = status; this.headersSent = true; }, end(body) { resolve({ status: this.statusCode, body: JSON.parse(body) }); } }; void createApp({ db: f.db, config: f.config })(req, res); });
    await started;
    f.config.customerLegal = loadCustomerLegalConfig(documents("fixture-terms-1", "fixture-privacy-2"), f.config.origin); initializeCustomerLegal(f.db, f.config); releaseBody();
    const rejected = await response; assert.equal(rejected.status, 409); assert.equal(rejected.body.error.code, "LEGAL_DOCUMENT_CHANGED");
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM customer_legal_acceptances").get().n, 0);
  } finally { await f.close(); }
});
