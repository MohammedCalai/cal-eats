import assert from "node:assert/strict";
import test from "node:test";
import { AndroidImportance } from "expo-notifications/build/NotificationChannelManager.types.js";
import { createCustomerPushTapQueue, customerPushProject, parseCustomerPushTarget } from "../src/push-model.ts";
import { createPushDeviceBinding, type PushDeviceRegistration, type PushDeviceResult } from "../src/push-binding.ts";
import { CUSTOMER_QUIET_PUSH_CHANNEL, LEGACY_CUSTOMER_QUIET_PUSH_CHANNEL, customerQuietPushChannelSettings, customerPushChannelAttention, customerPushChannelPlan, customerPushChannelId, customerForegroundPushBehavior, type CustomerPushChannel } from "../src/push-presentation.ts";

const target = { notificationId: "notification-one", recipientUserId: "customer-one", kind: "order", orderId: "order-one" };
const device: PushDeviceRegistration = { installationId: "9b48e5c6-5e6a-47d2-bff2-1016ea9d6b41", expoPushToken: "ExponentPushToken[test-device]", platform: "android", projectId: "5bf59184-c670-44f4-be78-5229cbd02300", soundEnabled: true };
const registered = (registration = device): PushDeviceResult => ({ registered: true, installationId: registration.installationId, expiresAt: "2026-12-01T00:00:00.000Z", pushEnabled: true });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test("Android heads-up requires a freshly verified silent channel; iOS and older Android remain silent", () => {
  // Import the installed SDK enum, not a duplicate test constant: native
  // Android HIGH=4 is Expo LOW, which previously caused shade-only updates.
  assert.equal(AndroidImportance.HIGH, 6); assert.equal(AndroidImportance.NONE, 2); assert.equal(AndroidImportance.MAX, 7);
  const channel: CustomerPushChannel = { id: CUSTOMER_QUIET_PUSH_CHANNEL, ...customerQuietPushChannelSettings(AndroidImportance) };
  assert.equal(channel.importance, AndroidImportance.HIGH);
  assert.equal(channel.sound, null); assert.equal(channel.enableVibrate, false);
  const behavior = (platform = "android", version: number | string = 36, proof: CustomerPushChannel | null = channel, id: string | null = channel.id) => customerForegroundPushBehavior(target, "customer-one", platform, version, id, proof, AndroidImportance);
  assert.deepEqual(behavior(), { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false });
  // In Expo Android8+, that flag permits heads-up; the verified OS channel
  // supplies neither sound nor vibration. It must never apply to iOS/Android7.
  assert.equal(behavior("ios", "26.0").shouldPlaySound, false);
  assert.equal(behavior("android", 25).shouldPlaySound, false);
  assert.equal(behavior("android", 36, null).shouldPlaySound, false);
  assert.equal(behavior("android", 36, channel, null).shouldPlaySound, false);
  assert.equal(behavior("android", 36, channel, "cal-eats-updates").shouldPlaySound, false);
  for (const proof of [{ ...channel, sound: "default" }, { ...channel, sound: "custom" }, { ...channel, enableVibrate: true }, ...[AndroidImportance.UNKNOWN, AndroidImportance.UNSPECIFIED, AndroidImportance.NONE, AndroidImportance.MIN, AndroidImportance.LOW, AndroidImportance.DEFAULT, NaN].map(importance => ({ ...channel, importance })), { ...channel, id: "legacy" }]) assert.equal(behavior("android", 36, proof).shouldPlaySound, false);
  assert.equal(behavior("android", 36, { ...channel, importance: AndroidImportance.MAX }).shouldPlaySound, true);
  assert.equal(behavior("android", 36, { ...channel, id: LEGACY_CUSTOMER_QUIET_PUSH_CHANNEL }, LEGACY_CUSTOMER_QUIET_PUSH_CHANNEL).shouldPlaySound, true);
  assert.deepEqual(customerForegroundPushBehavior(target, "another-customer", "android", 36, channel.id, channel, AndroidImportance), { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false });
  assert.equal(customerForegroundPushBehavior({}, "customer-one", "android", 36, channel.id, channel, AndroidImportance).shouldShowBanner, false);
});

test("Android channel lookup follows the native FCM trigger and detects blocked or changed channels", () => {
  const channel: CustomerPushChannel = { id: CUSTOMER_QUIET_PUSH_CHANNEL, ...customerQuietPushChannelSettings(AndroidImportance) };
  assert.equal(customerPushChannelId({ type: "push", remoteMessage: { notification: { channelId: channel.id }, data: { channelId: "legacy" } } }), channel.id);
  assert.equal(customerPushChannelId({ type: "push", remoteMessage: { notification: null, data: { channelId: channel.id } } }), channel.id);
  assert.equal(customerPushChannelId({ type: "push", remoteMessage: { notification: { channelId: "legacy" }, data: { channelId: channel.id } } }), "legacy");
  for (const trigger of [null, {}, { type: "push" }, { type: "date", channelId: channel.id }, { type: "push", remoteMessage: { data: { channelId: false } } }]) assert.equal(customerPushChannelId(trigger), null);
  assert.equal(customerPushChannelAttention(channel, AndroidImportance), null);
  assert.equal(customerPushChannelAttention(null, AndroidImportance), "missing");
  assert.equal(customerPushChannelAttention({ ...channel, importance: AndroidImportance.NONE }, AndroidImportance), "disabled");
  assert.equal(customerPushChannelAttention({ ...channel, importance: AndroidImportance.HIGH }, AndroidImportance), null);
  assert.equal(customerPushChannelAttention({ ...channel, importance: AndroidImportance.MAX }, AndroidImportance), null);
  assert.equal(customerPushChannelAttention({ ...channel, sound: "default" }, AndroidImportance), "audible");
  assert.equal(customerPushChannelAttention({ ...channel, enableVibrate: true }, AndroidImportance), "audible");
});

test("versioned quiet channels need affirmative repair and preserve existing phone notification choices", () => {
  const legacy: CustomerPushChannel = { id: LEGACY_CUSTOMER_QUIET_PUSH_CHANNEL, ...customerQuietPushChannelSettings(AndroidImportance), importance: AndroidImportance.LOW };
  const plan = (current: CustomerPushChannel | null, old: CustomerPushChannel | null, ask = false) => customerPushChannelPlan(current, old, ask, AndroidImportance);
  assert.equal(plan(null, null).channelId, CUSTOMER_QUIET_PUSH_CHANNEL); assert.equal(plan(null, null).create, true);
  assert.equal(plan(null, legacy).channelId, LEGACY_CUSTOMER_QUIET_PUSH_CHANNEL); assert.equal(plan(null, legacy).create, false); assert.equal(plan(null, legacy).canMigrate, true);
  assert.equal(plan(null, legacy, true).channelId, CUSTOMER_QUIET_PUSH_CHANNEL); assert.equal(plan(null, legacy, true).create, true);
  for (const old of [{ ...legacy, importance: AndroidImportance.NONE }, { ...legacy, importance: AndroidImportance.MIN }, { ...legacy, importance: AndroidImportance.DEFAULT }, { ...legacy, importance: AndroidImportance.HIGH }, { ...legacy, importance: AndroidImportance.MAX }, { ...legacy, sound: "default" }, { ...legacy, enableVibrate: true }, { ...legacy, importance: AndroidImportance.UNKNOWN }]) {
    assert.equal(plan(null, old, true).create, false); assert.equal(plan(null, old, true).channelId, LEGACY_CUSTOMER_QUIET_PUSH_CHANNEL); assert.equal(plan(null, old, true).canMigrate, false);
  }
  for (const importance of [AndroidImportance.NONE, AndroidImportance.LOW, AndroidImportance.HIGH]) {
    const modern = { ...legacy, id: CUSTOMER_QUIET_PUSH_CHANNEL, importance };
    assert.equal(plan(modern, legacy, true).create, false); assert.equal(plan(modern, legacy, true).channel, modern); assert.equal(plan(modern, legacy, true).canMigrate, false);
  }
});

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
