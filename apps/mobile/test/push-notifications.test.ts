import assert from "node:assert/strict";
import test from "node:test";
import { createCustomerPushTapQueue, customerPushProject, parseCustomerPushTarget } from "../src/push-model.ts";
import { createPushDeviceBinding, type PushDeviceRegistration, type PushDeviceResult } from "../src/push-binding.ts";

const target = { notificationId: "notification-one", recipientUserId: "customer-one", kind: "order", orderId: "order-one" };
const device: PushDeviceRegistration = { installationId: "9b48e5c6-5e6a-47d2-bff2-1016ea9d6b41", expoPushToken: "ExponentPushToken[test-device]", platform: "android", projectId: "5bf59184-c670-44f4-be78-5229cbd02300", soundEnabled: true };
const registered = (registration = device): PushDeviceResult => ({ registered: true, installationId: registration.installationId, expiresAt: "2026-12-01T00:00:00.000Z", pushEnabled: true });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test("push payloads select known screens and never expose a supplied URL for navigation", () => {
  assert.deepEqual(parseCustomerPushTarget({ ...target, url: "https://unexpected.invalid/steal" }), target);
  assert.equal(parseCustomerPushTarget({ ...target, kind: "conversation", conversationId: "chat-one" })?.conversationId, "chat-one");
  assert.equal(parseCustomerPushTarget({ ...target, kind: "support", supportCaseId: "support-one" })?.supportCaseId, "support-one");
  assert.equal(parseCustomerPushTarget({ ...target, kind: "offers" })?.kind, "offers");
  assert.equal(parseCustomerPushTarget({ ...target, kind: "account" })?.kind, "account");
  for (const value of [null, [], {}, { ...target, orderId: undefined }, { ...target, kind: ["order"] }, { ...target, recipientUserId: "../another-user" }, { ...target, kind: "external" }, { ...target, orderId: "https://unexpected.invalid" }]) assert.equal(parseCustomerPushTarget(value), null);
});

test("cold-start push taps wait for authentication and a locked checkout", () => {
  const queue = createCustomerPushTapQueue();
  assert.equal(queue.receive("native-response-one", target), true);
  assert.equal(queue.take(null, false), null);
  assert.equal(queue.take("customer-one", true), null);
  assert.equal(queue.waitingKey(), "native-response-one");
  assert.deepEqual(queue.take("customer-one", false)?.target, target);
  assert.equal(queue.receive("native-response-one", target), false);
  assert.equal(queue.take("customer-one", false), null);
});

test("a notification for a previous customer never opens under a newer sign-in", () => {
  const queue = createCustomerPushTapQueue(); queue.receive("previous-customer", target);
  assert.equal(queue.take("customer-two", false), null);
  assert.equal(queue.waitingKey(), null);
  queue.receive("before-logout", target); queue.clear();
  assert.equal(queue.take("customer-one", false), null);
  assert.equal(queue.receive("before-logout", target), false);
});

test("push registration accepts only the approved customer app project and platform", () => {
  assert.equal(customerPushProject(device.projectId, "ios"), device.projectId);
  assert.equal(customerPushProject(device.projectId, "android"), device.projectId);
  assert.equal(customerPushProject("f76a2adf-34ca-438a-9208-bdb5d4e65ded", "android"), "f76a2adf-34ca-438a-9208-bdb5d4e65ded");
  assert.equal(customerPushProject("f76a2adf-34ca-438a-9208-bdb5d4e65ded", "ios"), null);
  assert.equal(customerPushProject("unapproved-project", "android"), null);
  assert.equal(customerPushProject(device.projectId, "web"), null);
});

test("registration cannot finish after sign-out without revoking the old binding", async () => {
  const response = deferred<PushDeviceResult>(), events: string[] = [];
  const binding = createPushDeviceBinding(async session => { events.push(`register:${session}`); return response.promise; }, async session => { events.push(`revoke:${session}`); });
  binding.activate("session-one"); const pending = binding.bind("session-one", device);
  await Promise.resolve(); await Promise.resolve();
  const logout = binding.unbind("session-one", device.installationId);
  response.resolve(registered());
  assert.equal(await pending, null); await logout;
  assert.equal(events[0], "register:session-one");
  assert.equal(events.at(-1), "revoke:session-one");
  assert.equal(await binding.bind("session-one", device), null);
  assert.equal(events.filter(value => value.startsWith("register")).length, 1);
});

test("a late old registration and logout cannot replace a newer customer's device binding", async () => {
  const response = deferred<PushDeviceResult>(); let owner: string | null = null;
  const binding = createPushDeviceBinding(async (session, value) => { if (session === "old") await response.promise; owner = session; return registered(value); }, async session => { if (owner === session) owner = null; });
  binding.activate("old"); const old = binding.bind("old", device);
  await Promise.resolve(); await Promise.resolve();
  binding.activate("new"); const next = binding.bind("new", device), oldLogout = binding.unbind("old", device.installationId);
  response.resolve(registered());
  assert.equal(await old, null); assert.equal((await next)?.registered, true); await oldLogout;
  assert.equal(owner, "new");
});

test("customer push stays silent even with an old sound-on preference and after token rotation", async () => {
  const registrations: PushDeviceRegistration[] = [];
  const binding = createPushDeviceBinding(async (_session, value) => { registrations.push(value); return registered(value); }, async () => {});
  assert.equal(await binding.bind("guest", device), null);
  binding.activate("customer-session"); await binding.bind("customer-session", device);
  await binding.bind("customer-session", { ...device, expoPushToken: "ExponentPushToken[rolled-device]", soundEnabled: false });
  assert.equal(registrations.length, 2);
  assert.equal(registrations[0]?.soundEnabled, false);
  assert.equal(registrations.at(-1)?.expoPushToken, "ExponentPushToken[rolled-device]");
  assert.equal(registrations.at(-1)?.soundEnabled, false);
});

test("a failed registration does not poison a later retry or sign-out", async () => {
  let attempts = 0, revoked = false;
  const binding = createPushDeviceBinding(async () => { if (++attempts === 1) throw new Error("Offline"); return registered(); }, async () => { revoked = true; });
  binding.activate("customer-session"); await assert.rejects(binding.bind("customer-session", device), /Offline/);
  assert.equal((await binding.bind("customer-session", device))?.registered, true);
  await binding.unbind("customer-session", device.installationId);
  assert.equal(revoked, true);
});
