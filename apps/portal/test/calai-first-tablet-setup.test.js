import test from "node:test";
import assert from "node:assert/strict";
import { calaiFirstSetupPayload, calaiFirstSetupTablets, calaiTabletFirstSetupPath } from "../src/unified-business-model.js";
import { requestCalaiFirstTabletSetup } from "../src/calai-first-tablet-download.js";

const owner = {
  id: "branch / first", principalKind: "human", eatsRestaurantId: null,
  canConnectProducts: true, canViewCalai: true,
  products: { calai: { linked: true, nativeAccountId: "existing-calai", adminAllowed: true, readiness: { ready: true }, effectiveStatus: "ready" } },
};
const tablet = { tabletId: "c4dddf10-ce21-495c-9a13-de028d7484ba", tabletName: "Kitchen Surface", serialNumber: "1234567890", revision: 3 };

test("first setup appears only for a verified current Calai-only owner", () => {
  assert.equal(calaiTabletFirstSetupPath(owner), "/api/business/accounts/branch%20%2F%20first/terminals/calai-first-setup");
  for (const business of [
    { ...owner, eatsRestaurantId: "existing-eats" },
    { ...owner, principalKind: "terminal" },
    { ...owner, canManageProducts: true },
    { ...owner, canConnectProducts: false },
    { ...owner, canViewCalai: false },
    { ...owner, products: { calai: { ...owner.products.calai, linked: false } } },
  ]) assert.equal(calaiTabletFirstSetupPath(business), null);
});

test("setup confirmation posts only a real assigned tablet and its current revision", () => {
  const current = calaiFirstSetupTablets({ eligible: true, tablets: [{ ...tablet, nonce: "ignored" }] })[0];
  assert.deepEqual(current, tablet);
  assert.deepEqual(calaiFirstSetupPayload(tablet, current), { tabletId: tablet.tabletId, expectedRevision: 3 });
  for (const changed of [
    { ...tablet, revision: 4 },
    { ...tablet, tabletId: "d4dddf10-ce21-495c-9a13-de028d7484ba" },
    { ...tablet, tabletName: "Other Surface" },
    { ...tablet, serialNumber: "1111111111" },
    null,
  ]) assert.equal(calaiFirstSetupPayload(tablet, changed), null);
  for (const value of [
    { eligible: false, tablets: [tablet] },
    { eligible: true, tablets: [tablet, { ...tablet, serialNumber: "1111111111" }] },
    { eligible: true, tablets: [{ ...tablet, tabletId: "unknown" }] },
    { eligible: true, tablets: [{ ...tablet, serialNumber: "" }] },
    { eligible: true, tablets: [{ ...tablet, revision: 0 }] },
  ]) assert.deepEqual(calaiFirstSetupTablets(value), []);
});

test("private setup uses a same-origin human session and accepts only a nonempty attachment", async () => {
  const path = calaiTabletFirstSetupPath(owner);
  const payload = calaiFirstSetupPayload(tablet, tablet);
  const signal = new AbortController().signal;
  const headers = {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": 'attachment; filename="CalEats-Tablet-Setup.ps1"',
  };
  const result = await requestCalaiFirstTabletSetup(path, payload, { signal, request: async (target, options) => {
    assert.equal(target, path);
    assert.equal(options.method, "POST");
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.mode, "same-origin");
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    assert.equal(options.signal, signal);
    assert.deepEqual(JSON.parse(options.body), { tabletId: tablet.tabletId, expectedRevision: 3 });
    return new Response(new Uint8Array([2, 15, 254]), { headers });
  } });
  assert.deepEqual([...new Uint8Array(await result.arrayBuffer())], [2, 15, 254]);
  for (const response of [
    new Response("<form>Sign in</form>", { headers: { "Content-Type": "text/html" } }),
    new Response("not an attachment", { headers: { "Content-Type": "application/octet-stream" } }),
    new Response(null, { headers }),
  ]) await assert.rejects(requestCalaiFirstTabletSetup(path, payload, { request: async () => response }), /setup file/);
  await assert.rejects(requestCalaiFirstTabletSetup(path, payload, { request: async () => Response.json({
    error: { code: "TABLET_REVISION_CHANGED", message: "Review the current tablet." },
  }, { status: 409 }) }), error => error.code === "TABLET_REVISION_CHANGED" && error.status === 409);
});
