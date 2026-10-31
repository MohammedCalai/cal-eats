import test from "node:test";
import assert from "node:assert/strict";
import { printerConnectionSummary, startDashboardReminder } from "../src/dashboard-attention-model.js";

test("printer health uses live API connection status and excludes revoked printers", () => {
  const online = { id: "online", enabled: true, revoked: false, status: "online" };
  assert.deepEqual(printerConnectionSummary([online]).disconnected, []);
  assert.deepEqual(printerConnectionSummary([{ ...online, enabled: undefined }]).disconnected, []);
  const offline = { ...online, id: "offline", status: "offline" }, unpaired = { ...online, id: "unpaired", status: "awaiting_device" };
  assert.deepEqual(printerConnectionSummary([online, offline, unpaired, { ...online, revoked: true }]).disconnected.map(printer => printer.id), ["offline", "unpaired"]);
  assert.deepEqual(printerConnectionSummary([{ ...online, revoked: true }]).configured, []);
});

test("customer reminders recur every 15 seconds and stop when the pending scope ends", async () => {
  let callback, plays = 0, pauses = 0, cancelled;
  const player = { currentTime: 0, play: async () => { plays++; }, pause: () => { pauses++; } };
  const reminder = startDashboardReminder(player, { schedule(fn, delay) { assert.equal(delay, 15000); callback = fn; return 7; }, cancel(id) { cancelled = id; } });
  await Promise.resolve();
  assert.equal(plays, 1);
  callback();
  await Promise.resolve();
  assert.equal(plays, 2);
  reminder.stop();
  assert.equal(cancelled, 7);
  assert.equal(pauses, 1);
  callback();
  assert.equal(plays, 2);
});

test("a trusted interaction retries blocked reminder audio", async () => {
  let blocked = true, calls = 0, reported;
  const player = { currentTime: 0, play: async () => { calls++; if (blocked) throw new Error("Not allowed"); }, pause() {} };
  const reminder = startDashboardReminder(player, { schedule: () => 1, cancel() {}, onBlocked(value) { reported = value; } });
  await Promise.resolve();
  assert.equal(reported, true);
  blocked = false;
  reminder.interact({ isTrusted: false });
  assert.equal(calls, 1);
  reminder.interact({ isTrusted: true });
  await Promise.resolve();
  assert.equal(calls, 2);
  assert.equal(reported, false);
  reminder.stop();
});
