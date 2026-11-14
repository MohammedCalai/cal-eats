import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { claimedJob, removeWorkspace, temporaryWorkspace } from "./helpers.js";

function runClient(configPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("apps/print-bridge/src/index.js"), "once", "--config", configPath], { windowsHide: true });
    let output = "";
    child.stdout.on("data", (value) => { output += value; });
    child.stderr.on("data", (value) => { output += value; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output }));
  });
}

test("downloaded one-use setup runs end to end against a loopback API and preserves its journal on restart", async (t) => {
  const directory = await temporaryWorkspace("startup");
  t.after(() => removeWorkspace(directory));
  const configPath = path.join(directory, "config.json");
  const printerId = "b2222222-2222-4222-8222-222222222222";
  const restaurantId = "a1111111-1111-4111-8111-111111111111";
  const setupCode = "local-loopback-one-use-code";
  let pairedToken;
  let pairCalls = 0;
  let claimCalls = 0;
  const acks = [];
  const failures = [];
  const server = http.createServer(async (request, response) => {
    let data;
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      if (request.url === "/api/devices/pair") {
        pairCalls += 1;
        assert.equal(body.code, setupCode);
        assert.equal(request.headers.authorization, undefined);
        pairedToken = body.clientToken;
        data = { deviceId: "device_loopback_00001", printerId, restaurantId, token: pairedToken };
      } else {
        assert.equal(request.headers.authorization, `Bearer ${pairedToken}`);
        if (request.url === "/api/devices/heartbeat") {
          assert.deepEqual(body, { printerReachable: true, transport: "file-sink" });
          data = {};
        } else if (request.url === "/api/devices/jobs/claim") {
          claimCalls += 1;
          data = { job: claimCalls === 1 ? claimedJob() : null };
        } else if (request.url.endsWith("/ack")) {
          acks.push(body);
          data = { status: body.outcome };
        } else throw new Error("Unexpected API route");
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data }));
    } catch (error) {
      failures.push(error);
      response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ message: "Loopback fixture failed" }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = {
    schemaVersion: 1, product: "cal-eats", deviceName: "Loopback kitchen", apiBaseUrl: `http://127.0.0.1:${server.address().port}`,
    credentialPath: "var/device-credential.json", journalPath: "var/print-journal.json", logPath: "var/print-bridge.log",
    transport: { kind: "file-sink", outputDirectory: "var/printed" }, requestTimeoutMs: 1000, heartbeatIntervalMs: 5000, idlePollMs: 500,
    retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 },
  };
  await fs.writeFile(configPath, JSON.stringify(config));
  await fs.writeFile(path.join(directory, "setup.json"), JSON.stringify({ schemaVersion: 1, product: "cal-eats", printerId, restaurantId, code: setupCode, expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  const first = await runClient(configPath);
  assert.equal(first.code, 0, first.output);
  assert.equal(failures.length, 0);
  assert.equal(pairCalls, 1);
  assert.equal(acks.length, 1);
  assert.equal(acks[0].outcome, "printed");
  assert.equal(first.output.includes(setupCode), false);
  assert.equal(first.output.includes(pairedToken), false);
  await assert.rejects(fs.access(path.join(directory, "setup.json")), { code: "ENOENT" });
  const second = await runClient(configPath);
  assert.equal(second.code, 0, second.output);
  assert.equal(pairCalls, 1);
  assert.equal(acks.length, 1);
  const artifacts = await fs.readdir(path.join(directory, "var", "printed"));
  assert.equal(artifacts.filter((name) => name.endsWith(".txt")).length, 1);
  const journal = JSON.parse(await fs.readFile(path.join(directory, "var", "print-journal.json"), "utf8"));
  assert.equal(Object.values(journal.jobs)[0].state, "acked");
});
