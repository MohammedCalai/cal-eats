import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ApiError } from "../src/api-client.js";
import { PrintBridge } from "../src/bridge.js";
import { FileSinkTransport } from "../src/transports.js";
import { FakeApi, claimedJob, journalAt, logger, removeWorkspace, temporaryWorkspace } from "./helpers.js";

test("offline claim leaves the durable journal empty", async (t) => {
  const directory = await temporaryWorkspace("offline");
  t.after(() => removeWorkspace(directory));
  const api = new FakeApi();
  api.failClaim = new ApiError("offline", { retryable: true });
  const journal = await journalAt(directory);
  const bridge = new PrintBridge({ api, journal, transport: new FileSinkTransport(path.join(directory, "printed")), logger });
  await assert.rejects(bridge.runOnce(), /offline/);
  assert.equal(journal.entries().length, 0);
});

test("restart resumes a claimed job without claiming or printing twice", async (t) => {
  const directory = await temporaryWorkspace("restart");
  t.after(() => removeWorkspace(directory));
  const api = new FakeApi([claimedJob()]);
  const journal = await journalAt(directory);
  const crash = new Error("simulated crash after journal commit");
  const first = new PrintBridge({ api, journal, transport: new FileSinkTransport(path.join(directory, "printed")), logger, hooks: { afterClaimPersisted: () => { throw crash; } } });
  await assert.rejects(first.runOnce(), /simulated crash/);
  assert.equal(journal.entries()[0].state, "claimed");

  const reloaded = await journalAt(directory);
  const second = new PrintBridge({ api, journal: reloaded, transport: new FileSinkTransport(path.join(directory, "printed")), logger });
  const result = await second.runOnce();
  assert.equal(result.recovered, true);
  assert.equal(api.claimCalls, 1);
  assert.equal(api.acks.length, 1);
  assert.equal(api.acks[0].body.outcome, "printed");
  const artifacts = await fs.readdir(path.join(directory, "printed"));
  assert.equal(artifacts.filter((name) => name.endsWith(".txt")).length, 1);
});

test("lost acknowledgement response is replayed with the identical claim token and outcome", async (t) => {
  const directory = await temporaryWorkspace("ack-replay");
  t.after(() => removeWorkspace(directory));
  const api = new FakeApi([claimedJob()]);
  api.ackHook = (_id, _body, count) => {
    if (count === 1) throw new ApiError("response lost", { retryable: true });
    return { status: "printed" };
  };
  const journal = await journalAt(directory);
  const first = new PrintBridge({ api, journal, transport: new FileSinkTransport(path.join(directory, "printed")), logger });
  await assert.rejects(first.runOnce(), /response lost/);
  assert.equal(journal.entries()[0].state, "ack_pending");

  const second = new PrintBridge({ api, journal: await journalAt(directory), transport: new FileSinkTransport(path.join(directory, "printed")), logger });
  await second.runOnce();
  assert.equal(api.acks.length, 2);
  assert.deepEqual(api.acks[1], api.acks[0]);
});

test("restart after possible physical dispatch acknowledges uncertain and never redispatches", async (t) => {
  const directory = await temporaryWorkspace("uncertain");
  t.after(() => removeWorkspace(directory));
  const api = new FakeApi([claimedJob()]);
  let sends = 0;
  const physical = {
    kind: "test-physical",
    recovery: "ambiguous",
    inspect: async () => null,
    send: async () => {
      sends += 1;
      const crash = new Error("simulated power loss after bytes may have been sent");
      crash.simulateProcessCrash = true;
      throw crash;
    },
  };
  const first = new PrintBridge({ api, journal: await journalAt(directory), transport: physical, logger });
  await assert.rejects(first.runOnce(), /simulated power loss/);
  assert.equal(sends, 1);

  const second = new PrintBridge({ api, journal: await journalAt(directory), transport: physical, logger });
  await second.runOnce();
  assert.equal(sends, 1);
  assert.equal(api.acks[0].body.outcome, "uncertain");
  assert.match(api.acks[0].body.detail, /may have occurred/);
});
