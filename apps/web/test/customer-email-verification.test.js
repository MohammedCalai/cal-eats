import assert from "node:assert/strict";
import test from "node:test";
import { emailVerificationHtml, emailVerificationStatus, mountEmailVerification, mountEmailConfirmation } from "../customer-email-verification.js";
import { customerAccountHtml } from "../customer-account.js";

const pending = (extra = {}) => ({ email: "customer@fixture.invalid", emailVerified: false, verificationRequired: true, canOrder: false, resendAvailableAt: null, delivery: "email", ...extra });
function surface() {
  const listeners = new Map();
  return { isConnected: true, innerHTML: "", listeners, addEventListener(type, listener) { listeners.set(type, listener); }, removeEventListener(type) { listeners.delete(type); } };
}

test("verification status distinguishes new pending customers, grandfathered accounts and confirmed email, and escapes account text", () => {
  assert.equal(emailVerificationStatus(pending()).canOrder, false);
  const legacy = pending({ verificationRequired: false, canOrder: true });
  assert.match(emailVerificationHtml(legacy), /keep using your existing account/);
  assert.doesNotMatch(emailVerificationHtml(legacy), /before ordering/);
  assert.throws(() => emailVerificationStatus(pending({ canOrder: true })));
  const html = emailVerificationHtml(pending({ email: '<img src=x onerror="bad">@fixture.invalid' }), { welcome: true });
  assert.match(html, /Welcome to Cal-Eats/); assert.match(html, /before ordering/); assert.match(html, /browse, contact support/); assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img/);
  assert.match(emailVerificationHtml(pending({ delivery: "local_simulation" })), /no email was sent/);
  assert.match(emailVerificationHtml(pending({ delivery: "unavailable" })), /temporarily unavailable/);
  const verified = emailVerificationHtml(pending({ emailVerified: true, canOrder: true })); assert.match(verified, /Email confirmed/); assert.doesNotMatch(verified, /data-email-resend/);
});

test("account confirmation remains separate from support, export and deletion controls", () => {
  const html = customerAccountHtml({ profile: { name: "Fixture Customer", email: "customer@fixture.invalid", phone: "", emailVerified: false }, privacyPolicy: { enabled: true }, erasure: [] });
  assert.match(html, /data-account-email-verification/); assert.match(html, /id="account-help"/); assert.match(html, /\/api\/account\/export/); assert.match(html, /id="deletion-form"/);
  assert.doesNotMatch(html, /Confirmation link prepared in local mail|data-action="send-verification"/);
});

test("resending respects server cooldown, displays errors, refreshes confirmation and never claims local delivery was emailed", async t => {
  let clock = Date.parse("2026-11-08T12:00:00Z"), confirmed = false, fail = false;
  const container = surface(), calls = [], changes = [];
  const controller = mountEmailVerification(container, { now: () => clock, initial: pending({ resendAvailableAt: new Date(clock + 60000).toISOString() }), api: async (path, options = {}) => {
    calls.push({ path, options }); if (fail) throw Error("Connection interrupted <retry>");
    return confirmed ? pending({ emailVerified: true, canOrder: true }) : pending({ delivery: "local_simulation", resendAvailableAt: new Date(clock + 60000).toISOString(), resent: true });
  }, onChange: value => changes.push(value) }); t.after(() => controller.close());
  assert.match(container.innerHTML, /Resend in 60s/); await controller.resend(); assert.equal(calls.length, 0);
  clock += 60001; await controller.resend(); assert.equal(calls.length, 1); assert.equal(calls[0].options.method, "POST"); assert.equal(calls[0].path, "/api/auth/email-verification/send"); assert.match(container.innerHTML, /No email was sent/);
  fail = true; await controller.refresh(); assert.match(container.innerHTML, /Connection interrupted &lt;retry&gt;/);
  fail = false; confirmed = true; await controller.refresh(); assert.equal(controller.status.canOrder, true); assert.equal(changes.at(-1).emailVerified, true); assert.match(container.innerHTML, /Email confirmed/);
  controller.close(); assert.equal(container.listeners.size, 0);
});

test("initial status lookup performs GET only and closing ignores a delayed response", async () => {
  const container = surface(), calls = []; let release;
  const controller = mountEmailVerification(container, { api: (path, options = {}) => { calls.push({ path, options }); return new Promise(resolve => { release = resolve; }); } });
  assert.equal(calls.length, 1); assert.equal(calls[0].path, "/api/auth/email-verification/status"); assert.equal(calls[0].options.method, undefined);
  controller.close(); const before = container.innerHTML; release(pending()); await Promise.resolve(); await Promise.resolve();
  assert.equal(container.innerHTML, before); assert.equal(controller.status, null);
});

test("opening a confirmation page never consumes a token; one deliberate POST confirms it and returns to the app without forwarding secrets", async () => {
  const container = surface(), calls = [], token = "a".repeat(43); let release, confirmations = 0;
  const controller = mountEmailConfirmation(container, { token, api: (path, options) => { calls.push({ path, options }); return new Promise(resolve => { release = resolve; }); }, onConfirmed: () => confirmations++ });
  assert.equal(calls.length, 0); assert.match(container.innerHTML, /Opening this page alone does not confirm/); assert.doesNotMatch(container.innerHTML, new RegExp(token));
  const first = controller.confirm(), second = controller.confirm(); assert.equal(calls.length, 1); assert.equal(calls[0].options.method, "POST"); assert.deepEqual(JSON.parse(calls[0].options.body), { token });
  release({ emailVerified: true }); await Promise.all([first, second]); assert.equal(confirmations, 1); assert.match(container.innerHTML, /Your email is confirmed/); assert.match(container.innerHTML, /href="caleats:\/\/"/); assert.match(container.innerHTML, /browser tab where you signed up/); assert.doesNotMatch(container.innerHTML, new RegExp(token));
  await controller.confirm(); assert.equal(calls.length, 1); controller.close(); assert.equal(container.listeners.size, 0);
});

test("expired, incomplete and interrupted confirmation links provide recovery without automatic consumption", async () => {
  let calls = 0; const container = surface();
  const invalid = mountEmailConfirmation(container, { token: "incomplete", api: async () => { calls++; } }); await invalid.confirm(); assert.equal(calls, 0); assert.match(container.innerHTML, /incomplete or invalid/); invalid.close();
  const expired = mountEmailConfirmation(container, { token: "b".repeat(43), api: async () => { calls++; throw Object.assign(Error("Token is invalid or expired"), { code: "TOKEN_INVALID" }); } });
  assert.equal(calls, 0); await expired.confirm(); assert.equal(calls, 1); assert.match(container.innerHTML, /expired or has already been used/); assert.match(container.innerHTML, /support@calai.info/); expired.close();
});
