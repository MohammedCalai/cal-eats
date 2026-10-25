import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { createTransport } from "../src/transports.js";
import { removeWorkspace, temporaryWorkspace } from "./helpers.js";

function input(apiBaseUrl, transport) {
  return {
    schemaVersion: 1,
    product: "cal-eats",
    deviceName: "Test bridge",
    apiBaseUrl,
    credentialPath: "credential.json",
    journalPath: "journal.json",
    logPath: "bridge.log",
    transport,
    requestTimeoutMs: 1000,
    heartbeatIntervalMs: 5000,
    idlePollMs: 500,
    retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 20, jitterRatio: 0 },
  };
}

test("rejects original hosts and keeps physical transport behind a second gate", async (t) => {
  const directory = await temporaryWorkspace("config");
  t.after(() => removeWorkspace(directory));
  const forbidden = path.join(directory, "forbidden.json");
  await fs.writeFile(forbidden, JSON.stringify(input("https://api.calai.info/api", { kind: "file-sink", outputDirectory: "printed" })));
  await assert.rejects(loadConfig(forbidden), /forbidden/);

  const physical = path.join(directory, "physical.json");
  await fs.writeFile(physical, JSON.stringify(input("http://127.0.0.1:3000", { kind: "tcp-escpos", enabled: true, host: "192.0.2.1", port: 9100, connectTimeoutMs: 1000 })));
  const config = await loadConfig(physical);
  assert.throws(() => createTransport(config.transport), /disabled/);
});

test("remote APIs require encrypted transport and IPv6 loopback works in simulation", async (t) => {
  const directory = await temporaryWorkspace("transport-security");
  t.after(() => removeWorkspace(directory));
  const configuration = path.join(directory, "config.json");
  const hardware = { kind: "tcp-escpos", enabled: true, host: "192.0.2.1", port: 9100, connectTimeoutMs: 1000 };
  await fs.writeFile(configuration, JSON.stringify(input("http://example.invalid", hardware)));
  await assert.rejects(loadConfig(configuration), /HTTPS/);
  await fs.writeFile(configuration, JSON.stringify(input("http://[::1]:4310", { kind: "file-sink", outputDirectory: "printed" })));
  assert.equal((await loadConfig(configuration)).apiBaseUrl, "http://[::1]:4310");
});
