import test from "node:test";
import assert from "node:assert/strict";
import { notificationPermissionPrompt, showNotificationPermissionPrompt } from "../src/notification-permission-prompt.ts";

test("legacy Android shade-only updates request explicit setup even when notifications are granted", () => {
  assert.equal(notificationPermissionPrompt({ status: "enabled", needsBannerSetup: true })?.action, "allow");
  assert.equal(notificationPermissionPrompt({ status: "enabled" })?.action, "done");
  assert.equal(notificationPermissionPrompt({ status: "blocked" })?.action, "settings");
  assert.equal(notificationPermissionPrompt({ status: "blocked", needsBannerSetup: true })?.action, "settings");
  assert.equal(notificationPermissionPrompt({ status: "permission_needed" })?.action, "allow");
});

test("permission education waits for the correct signed-in account and does not stack over another task", () => {
  const state = { userId: "customer-a", loadedFor: "customer-a", acknowledged: false, blocked: false, requesting: false, state: { status: "permission_needed" } };
  assert.equal(showNotificationPermissionPrompt(state), true);
  for (const change of [{ userId: null }, { loadedFor: "customer-b" }, { blocked: true }, { acknowledged: true }]) assert.equal(showNotificationPermissionPrompt({ ...state, ...change }), false);
});

test("request progress keeps setup visible but background connection checks do not prompt", () => {
  const state = { userId: "customer-a", loadedFor: "customer-a", acknowledged: false, blocked: false, requesting: false, state: { status: "checking" } };
  assert.equal(showNotificationPermissionPrompt(state), false);
  assert.equal(showNotificationPermissionPrompt({ ...state, requesting: true }), true);
  assert.equal(notificationPermissionPrompt({ status: "unavailable" }), null);
});
