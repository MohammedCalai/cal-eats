import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { businessFixture } from "./unified-business-test-fixture.js";
import { enrolRegisteredTablet } from "./registered-tablet-fixture.js";

async function fixture(t) {
  const f = await businessFixture();
  t.after(() => f.close());
  const ownerCookie = await f.login("restaurant@calai.local", "LocalRestaurant!4310");
  const adminCookie = await f.login("admin@calai.local", "LocalAdmin!4310");
  const path = `/api/business/accounts/${f.business.id}/terminals/calai-authorization`;
  const get = (cookie = ownerCookie) => f.json(path, { cookie });
  const approve = (terminalId, cookie = ownerCookie, extra = {}) => f.json(path, {
    method: "POST", cookie, body: { expectedTerminalId: terminalId, ...extra },
  });
  const enrol = options => enrolRegisteredTablet(f, {
    ownerCookie: adminCookie, businessId: f.business.id, ...options,
  });
  const attachCalai = async () => {
    assert.equal((await f.allow("calai")).status, 200);
    assert.equal((await f.link()).status, 200);
  };
  return { ...f, ownerCookie, adminCookie, path, get, approve, enrol, attachCalai };
}

test("a verified owner delegates Calai reads to the existing admin-issued tablet without changing pairing or product mode", async t => {
  const f = await fixture(t);
  const tablet = await f.enrol({ deviceName: "Synthetic kitchen Surface" });
  const orders = "/api/business/calai/orders";
  assert.deepEqual((await f.get()).body.data, {
    eligible: false, authorized: false, terminalId: null, tabletName: null,
  });
  await f.attachCalai();
  const password = await f.json("/api/auth/password", { method: "POST", cookie: f.adminCookie,
    body: { currentPassword: "LocalAdmin!4310", newPassword: "SecureTabletAdmin!4310" } });
  assert.equal(password.status, 200, password.text);
  const tabletId = f.db.prepare("SELECT id FROM admin_tablets WHERE terminal_id=?").get(tablet.terminalId).id;
  async function adminAccess(mode) {
    f.db.prepare("UPDATE admin_tablets SET application_products=? WHERE id=?").run(mode, tabletId);
    const result = await f.json(`/api/admin/tablets/${tabletId}`, { cookie: f.adminCookie });
    assert.equal(result.status, 200, result.text);
    assert.equal(result.body.data.applicationAccess.selection, mode);
    return result.body.data.applicationAccess;
  }
  assert.equal((await adminAccess("calai")).calaiApprovalRequired, true);
  assert.equal((await adminAccess("both")).calaiApprovalRequired, true);
  assert.equal((await adminAccess("cal-eats")).calaiApprovalRequired, false);
  const eligible = await f.get();
  assert.deepEqual(eligible.body.data, {
    eligible: true, authorized: false, terminalId: tablet.terminalId, tabletName: "Synthetic kitchen Surface",
  });
  assert.equal(eligible.headers.get("cache-control"), "private, no-store");
  assert.equal((await tablet.json(orders)).status, 403, "An admin-issued pairing cannot inherit the owner's proof");
  assert.equal((await f.approve(tablet.terminalId, f.adminCookie)).status, 403);
  assert.equal((await tablet.json(f.path, { method: "POST", body: { expectedTerminalId: tablet.terminalId } })).status, 403);
  assert.equal((await f.approve(randomUUID())).status, 409);
  assert.equal((await f.approve(tablet.terminalId, f.ownerCookie, { approvedBy: f.admin.id })).status, 400);

  f.db.prepare("UPDATE admin_tablets SET application_products='cal-eats' WHERE terminal_id=?").run(tablet.terminalId);
  const terminalBefore = f.db.prepare("SELECT registered_by,public_key_sha256 FROM business_terminals WHERE id=?").get(tablet.terminalId);
  const approval = await f.approve(tablet.terminalId);
  assert.equal(approval.status, 200, approval.text);
  assert.equal(approval.body.data.authorized, true);
  assert.equal((await f.approve(tablet.terminalId)).body.data.authorized, true);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='terminal_calai_owner_approved'").get().n, 1);
  assert.deepEqual(f.db.prepare("SELECT registered_by,public_key_sha256 FROM business_terminals WHERE id=?").get(tablet.terminalId), terminalBefore);
  assert.equal((await tablet.json(orders)).status, 403, "Current Cal-Eats-only mode still hides Calai");
  assert.equal(f.db.prepare("SELECT application_products FROM admin_tablets WHERE terminal_id=?").get(tablet.terminalId).application_products, "cal-eats");

  assert.equal((await adminAccess("both")).calaiApprovalRequired, false);
  assert.equal((await tablet.json("/api/business/context")).body.data.canViewCalai, true);
  assert.equal((await tablet.json(orders)).status, 200, "The same signed terminal and grant can now read Calai");
  assert.equal((await tablet.json("/api/business/calai/settings", { method: "POST", body: {} })).status, 403);
  assert.equal((await tablet.json(`/api/business/accounts/${f.business.id}/terminals/setup`, { method: "POST", body: {} })).status, 403);

  f.db.prepare("UPDATE admin_tablets SET application_products='calai' WHERE terminal_id=?").run(tablet.terminalId);
  const calaiOnly = (await tablet.json("/api/business/context")).body.data;
  assert.equal(calaiOnly.canViewCalai, true);
  assert.equal(calaiOnly.canViewEats, false);
  assert.equal((await tablet.json(orders)).status, 200);
  assert.equal((await tablet.json("/api/restaurant/restaurants")).status, 403);
});

test("a tablet approval stops when current owner proof is lost and is not inherited by a replacement", async t => {
  const f = await fixture(t);
  await f.attachCalai();
  const tablet = await f.enrol();
  const orders = "/api/business/calai/orders";
  assert.equal((await f.approve(tablet.terminalId)).status, 200);
  assert.equal((await tablet.json(orders)).status, 200);

  // Keep a legitimate current owner so the tablet can still sign in. Only the
  // originally approving human loses restaurant ownership.
  f.db.prepare("INSERT INTO restaurant_memberships(restaurant_id,user_id,permission,created_at) VALUES (?,?,'owner',?)")
    .run(f.restaurant.id, f.otherOwner.id, f.config.now().toISOString());
  const masterMembership = () => f.db.prepare("SELECT permission,membership_source FROM business_account_memberships WHERE business_id=? AND user_id=?")
    .get(f.business.id, f.owner.id);
  const setMasterRole = permission => f.db.prepare("UPDATE business_account_memberships SET permission=? WHERE business_id=? AND user_id=? AND membership_source='master'")
    .run(permission, f.business.id, f.owner.id);
  assert.equal(masterMembership().membership_source, "master");
  assert.equal(setMasterRole("staff").changes, 1);
  assert.equal((await f.get()).status, 403, "Authoritative business staff cannot approve a tablet");
  assert.equal((await tablet.json("/api/auth/me")).status, 200, "The existing signed tablet session stays active for Cal-Eats");
  assert.equal((await tablet.json(orders)).status, 403, "Native restaurant ownership cannot override the authoritative staff role");
  setMasterRole("owner");

  const setOwnerRole = permission => f.db.prepare("UPDATE restaurant_memberships SET permission=? WHERE restaurant_id=? AND user_id=?")
    .run(permission, f.restaurant.id, f.owner.id);
  setOwnerRole("staff");
  assert.equal((await f.approve(tablet.terminalId)).status, 403);
  assert.equal((await tablet.json("/api/auth/me")).status, 200);
  assert.equal((await tablet.json(orders)).status, 403);
  setOwnerRole("owner");

  f.db.prepare("UPDATE business_product_authorities SET source_user_id=? WHERE business_id=? AND user_id=? AND product='calai'")
    .run(randomUUID(), f.business.id, f.owner.id);
  assert.equal((await f.get()).body.data.eligible, false);
  assert.equal((await tablet.json(orders)).status, 403);
  assert.equal((await f.link()).status, 200);

  const replacement = await f.enrol({ replace: true });
  assert.notEqual(replacement.terminalId, tablet.terminalId);
  assert.equal((await f.approve(tablet.terminalId)).status, 409);
  assert.equal((await replacement.json(orders)).status, 403);
  assert.ok([401, 403].includes((await tablet.json(orders)).status));
  assert.equal((await f.approve(replacement.terminalId)).status, 200);
  assert.equal((await replacement.json(orders)).status, 200);
});
