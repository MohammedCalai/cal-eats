import test from "node:test";
import assert from "node:assert/strict";
import { printerConnectionSummary } from "../src/dashboard-attention-model.js";

test("printer health uses live API connection status and excludes revoked printers", () => {
  const online = { id: "online", enabled: true, revoked: false, status: "online" };
  assert.deepEqual(printerConnectionSummary([online]).disconnected, []);
  assert.deepEqual(printerConnectionSummary([{ ...online, enabled: undefined }]).disconnected, []);
  const offline = { ...online, id: "offline", status: "offline" }, unpaired = { ...online, id: "unpaired", status: "awaiting_device" };
  assert.deepEqual(printerConnectionSummary([online, offline, unpaired, { ...online, revoked: true }]).disconnected.map(printer => printer.id), ["offline", "unpaired"]);
  assert.deepEqual(printerConnectionSummary([{ ...online, revoked: true }]).configured, []);
});
