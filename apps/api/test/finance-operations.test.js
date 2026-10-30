import assert from "node:assert/strict";
import test from "node:test";
import { processLocalOutbox, runExpiryWorker, runOperationsCycle } from "../src/operations.js";
import { applePayAdapter, authorizeMockPayment, captureMockPayment, stripeAdapter } from "../src/payments/mock.js";
import { loadConfig } from "../src/config.js";
import { journeyFixture } from "./helpers.js";

const credentials = {
  admin: ["admin@calai.local", "LocalAdmin!4310"], owner: ["restaurant@calai.local", "LocalRestaurant!4310"], customer: ["customer@calai.local", "LocalCustomer!4310"]
};
async function setup(f) {
  const admin = await f.login(...credentials.admin); const owner = await f.login(...credentials.owner); const customer = await f.login(...credentials.customer);
  const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0];
  const item = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items.find((entry) => entry.priceMinor === 1200);
  return { admin, owner, customer, restaurant, item };
}
async function order(f, auth, key, paymentMethod = "mock_card") {
  return (await f.json("/api/orders", { method: "POST", cookie: auth.customer, headers: { "Idempotency-Key": key }, body: { restaurantId: auth.restaurant.id, items: [{ menuItemId: auth.item.id, quantity: 1 }], paymentMethod, fulfillment: "collection" } })).body.data;
}
async function status(f, auth, id, value) { return f.json(`/api/restaurant/orders/${id}/status`, { method: "PATCH", cookie: auth.owner, body: { status: value } }); }

test("simulated card partial/full refunds are idempotent and reverse rounded commission exactly", async () => {
  const f = await journeyFixture();
  try {
    const auth = await setup(f); const created = await order(f, auth, "refund-order");
    await status(f, auth, created.id, "accepted");
    f.db.prepare("UPDATE contracts SET rate_bps=999 WHERE restaurant_id=?").run(auth.restaurant.id);
    const refund = (key, body) => f.json(`/api/admin/orders/${created.id}/refunds`, { method: "POST", cookie: auth.admin, headers: { "Idempotency-Key": key }, body });
    const first = await refund("refund-penny", { foodAmountMinor: 1, deliveryAmountMinor: 0, reason: "Small correction" });
    assert.equal(first.status, 201); assert.equal(first.body.data.order.paymentStatus, "mock_partially_refunded");
    assert.equal(first.body.data.refund.mode, "simulated_card");
    assert.equal((await refund("refund-penny", { foodAmountMinor: 1, deliveryAmountMinor: 0, reason: "Small correction" })).status, 200);
    assert.equal((await refund("refund-penny", { foodAmountMinor: 2, deliveryAmountMinor: 0, reason: "Changed" })).status, 409);
    const full = await refund("refund-rest", { foodAmountMinor: 1199, deliveryAmountMinor: 0, reason: "Complete simulated refund" });
    assert.equal(full.body.data.order.paymentStatus, "mock_refunded");
    assert.equal(full.body.data.order.refundedTotalMinor, 1200);
    assert.equal(full.body.data.order.refunds.length, 2);
    assert.equal(full.body.data.order.ledger.filter((entry) => entry.kind === "commission_mock_refund").reduce((sum, entry) => sum + entry.amountMinor, 0), -84);
    assert.equal((await status(f, auth, created.id, "preparing")).body.error.code, "ORDER_FULLY_REFUNDED");
    assert.equal((await refund("too-much", { foodAmountMinor: 1, deliveryAmountMinor: 0, reason: "Excess" })).status, 409);
  } finally { await f.close(); }
});

test("cash settlement and later manual refund surface restaurant credit", async () => {
  const f = await journeyFixture();
  try {
    const auth = await setup(f); const created = await order(f, auth, "cash-finance", "cash");
    for (const next of ["accepted", "preparing", "ready", "completed"]) await status(f, auth, created.id, next);
    const before = (await f.json(`/api/restaurant/restaurants/${auth.restaurant.id}/statement`, { cookie: auth.owner })).body.data;
    assert.equal(before.cashReceivableMinor, 84); assert.equal(before.cashOutstandingMinor, 84);
    const settlementBody = { amountMinor: 84, reference: "Manual demo receipt 1" };
    const settled = await f.json(`/api/admin/restaurants/${auth.restaurant.id}/cash-settlements`, { method: "POST", cookie: auth.admin, headers: { "Idempotency-Key": "settle-1" }, body: settlementBody });
    assert.equal(settled.status, 201); assert.equal(settled.body.data.statement.cashOutstandingMinor, 0);
    assert.equal((await f.json(`/api/admin/restaurants/${auth.restaurant.id}/cash-settlements`, { method: "POST", cookie: auth.admin, headers: { "Idempotency-Key": "settle-1" }, body: settlementBody })).status, 200);
    const refunded = await f.json(`/api/admin/orders/${created.id}/refunds`, { method: "POST", cookie: auth.admin, headers: { "Idempotency-Key": "cash-refund" }, body: { foodAmountMinor: 1200, deliveryAmountMinor: 0, reason: "Cash manually returned" } });
    assert.equal(refunded.body.data.refund.mode, "manual_cash_return"); assert.equal(refunded.body.data.order.paymentStatus, "cash_refunded");
    const after = (await f.json("/api/admin/statements", { cookie: auth.admin })).body.data.find((entry) => entry.restaurantId === auth.restaurant.id);
    assert.equal(after.cashReceivableMinor, 0); assert.equal(after.cashSettledMinor, 84); assert.equal(after.cashOutstandingMinor, -84);
    assert.equal((await f.json(`/api/admin/restaurants/${auth.restaurant.id}/cash-settlements`, { method: "POST", cookie: auth.admin, headers: { "Idempotency-Key": "settle-extra" }, body: { amountMinor: 1, reference: "Invalid" } })).status, 409);
  } finally { await f.close(); }
});

test("expiry, outbox, print jobs, contracts and admin operations are persisted and isolated", async () => {
  const f = await journeyFixture();
  try {
    const auth = await setup(f); const created = await order(f, auth, "expiry-order");
    const expiredAt = new Date(f.config.now().getTime() - (f.config.orderExpiryMinutes + 1) * 60_000).toISOString();
    f.db.prepare("UPDATE orders SET created_at=? WHERE id=?").run(expiredAt, created.id);
    assert.equal(runExpiryWorker(f.db, f.config), 1); assert.equal(runExpiryWorker(f.db, f.config), 0);
    const expired = (await f.json(`/api/orders/${created.id}`, { cookie: auth.customer })).body.data;
    assert.equal(expired.status, "rejected"); assert.equal(expired.paymentStatus, "mock_cancelled"); assert.equal(expired.ledger, undefined);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM ledger_entries WHERE order_id=?").get(created.id).n, 0);
    assert.equal(processLocalOutbox(f.db, f.config, () => { throw new Error("secret must not persist"); }), 1);
    assert.equal(f.db.prepare("SELECT status FROM notification_outbox WHERE entity_id=?").get(created.id).status, "failed");
    assert.equal(processLocalOutbox(f.db, f.config), 1);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM local_notifications WHERE entity_id=?").get(created.id).n, 1);
    const jobs = (await f.json("/api/admin/jobs", { cookie: auth.admin })).body.data;
    assert.ok(jobs.some((job) => job.kind === "order_expiry" && job.status === "completed"));
    assert.ok(jobs.some((job) => job.kind === "notification_outbox" && job.status === "delivered"));
    const print = await f.json(`/api/orders/${created.id}/print-jobs`, { method: "POST", cookie: auth.customer, body: {} });
    assert.equal(print.status, 201); assert.equal(print.body.data.status, "requested");
    const opened = await f.json(`/api/print-jobs/${print.body.data.id}`, { method: "PATCH", cookie: auth.customer, body: { status: "browser_opened" } });
    assert.equal(opened.body.data.status, "browser_opened");
    const receipt = await f.request(print.body.data.receiptUrl, { cookie: auth.customer }); assert.match(receipt.text, new RegExp(print.body.data.id)); assert.match(receipt.text, /size:80mm/);
    const contract = await f.json(`/api/restaurant/restaurants/${auth.restaurant.id}/contract`, { cookie: auth.owner });
    assert.equal(contract.body.data.demoOnly, true); assert.equal(contract.body.data.rateBasisPoints, 700); assert.equal(contract.body.data.durationMonths, 24);
    assert.ok((await f.json("/api/admin/contracts", { cookie: auth.admin })).body.data.length >= 2);
    assert.ok((await f.json("/api/admin/audit", { cookie: auth.admin })).body.data.length >= 0);
    const integrations = (await f.json("/api/admin/integrations", { cookie: auth.admin })).body.data;
    assert.equal(integrations.find((entry) => entry.name === "stripe").enabled, false);
    assert.equal(integrations.find((entry) => entry.name === "mock_payments").mode, "mock");
    assert.ok((await f.json("/api/admin/jobs", { cookie: auth.admin })).body.data.some((job) => job.kind === "print_job" && job.status === "browser_opened"));
    assert.equal((await f.request("/api/admin/reports/orders.csv", { cookie: auth.admin })).status, 200);
    assert.equal((await f.request("/api/admin/reports/ledger.csv", { cookie: auth.owner })).status, 403);
    const page = await f.request("/"); assert.equal(page.status, 200); assert.match(page.headers.get("content-security-policy"), /script-src 'self'/); assert.doesNotMatch(page.headers.get("content-security-policy"), /unsafe-inline/);
    assert.equal((await f.request("/package.json")).status, 404);
    const cycle = runOperationsCycle(f.db, f.config, { expiry: () => { throw new Error("boom"); }, outbox: () => 0 });
    assert.deepEqual(cycle.errors, ["order_expiry"]);
    assert.equal(f.db.prepare("SELECT status FROM operational_jobs WHERE kind='order_expiry_worker' ORDER BY rowid DESC").get().status, "failed");
  } finally { await f.close(); }
});

test("payment adapters are deterministic and live providers stay disabled", async () => {
  assert.deepEqual(authorizeMockPayment({ amountMinor: 1200 }), { ok: true, status: "mock_authorized", reference: "mock-1200", provider: "local_mock", external: false });
  assert.equal(authorizeMockPayment({ amountMinor: 1200, scenario: "decline" }).code, "MOCK_DECLINED");
  assert.equal(captureMockPayment({ amountMinor: 1200, scenario: "fail" }).code, "MOCK_CAPTURE_FAILED");
  await assert.rejects(stripeAdapter.authorize(), /disabled/);
  await assert.rejects(applePayAdapter.authorize(), /disabled/);
  assert.throws(() => loadConfig({ orderExpiryMinutes: Number.NaN }), /ORDER_EXPIRY/);
  assert.throws(() => loadConfig({ orderExpiryMinutes: 0 }), /ORDER_EXPIRY/);
  assert.throws(() => loadConfig({ orderExpiryMinutes: 1441 }), /ORDER_EXPIRY/);
});

test("server-side mock capture failure leaves order placed with no commission", async () => {
  const f = await journeyFixture({ mockCapture: () => ({ ok: false, code: "TEST_CAPTURE_FAILURE" }) });
  try {
    const auth = await setup(f); const created = await order(f, auth, "capture-failure");
    const response = await status(f, auth, created.id, "accepted");
    assert.equal(response.status, 409); assert.equal(response.body.error.code, "PAYMENT_CAPTURE_FAILED");
    const stored = f.db.prepare("SELECT status,payment_status FROM orders WHERE id=?").get(created.id);
    assert.equal(stored.status, "placed"); assert.equal(stored.payment_status, "mock_authorized");
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM ledger_entries WHERE order_id=?").get(created.id).n, 0);
  } finally { await f.close(); }
});
