import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { ApiError } from "../src/api-client.js";
import { PrintBridge } from "../src/bridge.js";
import { FileSinkTransport, TcpEscPosTransport } from "../src/transports.js";
import { FakeApi, claimedJob, journalAt, logger, removeWorkspace, temporaryWorkspace } from "./helpers.js";

test("reachability opens and closes loopback TCP without sending receipt bytes", async (t) => {
  let bytes = 0;
  let finishConnection;
  const connectionFinished = new Promise((resolve) => { finishConnection = resolve; });
  const server = net.createServer((socket) => {
    socket.on("data", (value) => { bytes += value.length; });
    socket.on("end", () => socket.end());
    socket.on("close", finishConnection);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const transport = new TcpEscPosTransport({ host: "127.0.0.1", port, connectTimeoutMs: 1000 });
  assert.equal(await transport.probe(), true);
  await connectionFinished;
  assert.equal(bytes, 0);
});

test("an unavailable TCP listener reports false without claiming paper was printed", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const transport = new TcpEscPosTransport({ host: "127.0.0.1", port, connectTimeoutMs: 500 });
  assert.equal(await transport.probe(), false);
});

test("file-sink reachability uses its protected simulation folder", async (t) => {
  const directory = await temporaryWorkspace("probe-file");
  t.after(() => removeWorkspace(directory));
  assert.equal(await new FileSinkTransport(path.join(directory, "printed")).probe(), true);
});

test("startup reports offline status, defers claims, then resumes after the printer responds", async (t) => {
  const directory = await temporaryWorkspace("probe-start");
  t.after(() => removeWorkspace(directory));
  const controller = new AbortController();
  const statuses = [];
  let probes = 0;
  let claims = 0;
  let sleeps = 0;
  const api = {
    heartbeat: async (body) => statuses.push(body),
    claim: async () => { claims += 1; assert.equal(probes, 2); controller.abort(); return null; },
  };
  const transport = { kind: "tcp-escpos", recovery: "ambiguous", probe: async () => ++probes >= 2, send: async () => assert.fail("There is no claimed receipt") };
  const bridge = new PrintBridge({ api, journal: await journalAt(directory), transport, logger, random: () => 0.5, sleep: async () => { if (++sleeps > 3) throw new Error("Unexpected retry loop"); } });
  await bridge.start({ signal: controller.signal, heartbeatIntervalMs: 0, idlePollMs: 1 });
  assert.equal(claims, 1);
  assert.deepEqual(statuses, [{ printerReachable: false, transport: "tcp-escpos" }, { printerReachable: true, transport: "tcp-escpos" }]);
});

test("offline printer still replays pending acknowledgements without dispatch or a new claim", async (t) => {
  const directory = await temporaryWorkspace("probe-ack");
  t.after(() => removeWorkspace(directory));
  const journal = await journalAt(directory);
  const job = claimedJob();
  await journal.recordClaim(job, { text: "safe simulator receipt", sha256: "synthetic" });
  await journal.update(job.id, { state: "ack_pending", acknowledgement: { claimToken: job.claimToken, outcome: "uncertain" } });
  const controller = new AbortController();
  const api = new FakeApi();
  api.ackHook = () => { controller.abort(); return {}; };
  const transport = { kind: "tcp-escpos", recovery: "ambiguous", probe: async () => false, send: async () => assert.fail("No physical redispatch") };
  await new PrintBridge({ api, journal, transport, logger, sleep: async () => {} }).start({ signal: controller.signal, heartbeatIntervalMs: 5000, idlePollMs: 1 });
  assert.equal(api.acks.length, 1);
  assert.equal(api.claimCalls, 0);
});

test("revoked running connections stop with a clear setup instruction instead of silently retrying forever", async (t) => {
  const directory = await temporaryWorkspace("probe-auth");
  t.after(() => removeWorkspace(directory));
  const api = { heartbeat: async () => { throw new ApiError("Revoked", { status: 401 }); } };
  const transport = { kind: "tcp-escpos", probe: async () => true };
  const bridge = new PrintBridge({ api, journal: await journalAt(directory), transport, logger });
  await assert.rejects(bridge.start({ signal: new AbortController().signal, heartbeatIntervalMs: 5000, idlePollMs: 1 }), /no longer authorised.*fresh setup/);
});

test("a claimed physical job that expires during restart is acknowledged uncertain without any dispatch", async (t) => {
  const directory = await temporaryWorkspace("expired-restart");
  t.after(() => removeWorkspace(directory));
  const journal = await journalAt(directory);
  const job = claimedJob({ leaseExpiresAt: "2026-11-14T10:01:00Z" });
  await journal.recordClaim(job, { text: "receipt", sha256: "synthetic" });
  const api = new FakeApi();
  let sends = 0;
  const transport = { kind: "tcp-escpos", recovery: "ambiguous", send: async () => { sends += 1; return { outcome: "uncertain" }; } };
  await new PrintBridge({ api, journal: await journalAt(directory), transport, logger, clock: () => new Date("2026-11-14T10:02:00Z") }).runOnce();
  assert.equal(sends, 0);
  assert.equal(api.claimCalls, 0);
  assert.equal(api.acks[0].body.outcome, "uncertain");
  assert.match(api.acks[0].body.detail, /expired before dispatch/);
});

test("lease expiry after the durable dispatch marker also prevents sending physical bytes", async (t) => {
  const directory = await temporaryWorkspace("expired-dispatch");
  t.after(() => removeWorkspace(directory));
  let now = new Date("2026-11-14T10:00:00Z");
  const api = new FakeApi([claimedJob({ leaseExpiresAt: "2026-11-14T10:01:00Z" })]);
  const transport = { kind: "tcp-escpos", recovery: "ambiguous", send: async () => assert.fail("Expired claim must never send bytes") };
  await new PrintBridge({ api, journal: await journalAt(directory), transport, logger, clock: () => now, hooks: { afterDispatchMarked: () => { now = new Date("2026-11-14T10:02:00Z"); } } }).runOnce();
  assert.equal(api.acks[0].body.outcome, "uncertain");
});
