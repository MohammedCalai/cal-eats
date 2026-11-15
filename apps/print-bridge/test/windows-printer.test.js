import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { WindowsSpoolerTransport, spoolerDiagnostic, deviceHealth } from "../src/windows-printer.js";
import { PrintBridge } from "../src/bridge.js";
import { ApiError } from "../src/api-client.js";
import { FakeApi, claimedJob, journalAt, logger, temporaryWorkspace, removeWorkspace } from "./helpers.js";

test("spooler paper/cover/offline/paused faults are distinct from unverified physical readiness", () => {
  const ready = spoolerDiagnostic({ installed: true, statusBits: 0, queuedJobs: 0 });
  assert.equal(ready.state, "ready"); assert.equal(ready.physicalReadinessKnown, false);
  const fault = spoolerDiagnostic({ installed: true, statusBits: 0x10 | 0x400000 | 0x80 | 0x1, queuedJobs: 2 });
  assert.equal(fault.state, "needs_attention"); assert.deepEqual(fault.faults.sort(), ["cover_open", "offline", "out_of_paper", "paused_queue"]);
  assert.equal(spoolerDiagnostic(null).state, "unknown");
});
test("Windows spooler job ID is persisted and a lost acknowledgement never resubmits paper", async t => {
  const directory = await temporaryWorkspace("windows-spooler"); t.after(() => removeWorkspace(directory));
  let sends = 0;
  const transport = new WindowsSpoolerTransport({ printerName: "Fixture printer" }, { helper: async (_name, input) => {
    if (input.action === "inspect") return { installed: true, statusBits: 0, queuedJobs: 0 };
    sends++; return { outcome: "submitted", spoolerJobId: "42", physicalPrinted: false };
  } });
  const api = new FakeApi([claimedJob()]);
  api.ackHook = (_id, _body, count) => { if (count === 1) throw new ApiError("lost reply", { retryable: true }); return {}; };
  let journal = await journalAt(directory);
  await assert.rejects(new PrintBridge({ api, journal, transport, logger }).runOnce(), /lost reply/);
  assert.equal(api.submissions.length, 1); assert.equal(sends, 1);
  assert.equal(journal.entries()[0].spoolerJobId, "42");
  journal = await journalAt(directory); await new PrintBridge({ api, journal, transport, logger }).runOnce();
  assert.equal(sends, 1); assert.deepEqual(api.acks[0], api.acks[1]); assert.equal(api.acks[1].body.outcome, "submitted"); assert.equal(api.acks[1].body.spoolerJobId, "42");
  assert.equal((await transport.inspect(journal.entries()[0])), null);
  const health = await deviceHealth({ transport, journal, printerId: "b2222222-2222-4222-8222-222222222222" });
  assert.deepEqual(health.printer.spoolerJobIds, ["42"]); assert.equal(health.printer.physicalReadinessKnown, false);
});
test("server submission authorization failure prevents the physical write", async t => {
  const directory = await temporaryWorkspace("submission-denied"); t.after(() => removeWorkspace(directory));
  const api = new FakeApi([claimedJob()]); api.submitting = async () => { throw new ApiError("denied", { status: 403 }); };
  let writes = 0;
  const transport = new WindowsSpoolerTransport({ printerName: "Fixture" }, { helper: async () => { writes++; return {}; } });
  await assert.rejects(new PrintBridge({ api, journal: await journalAt(directory), transport, logger }).runOnce(), /denied/);
  assert.equal(writes, 0); assert.equal(api.acks.length, 0);
});
test("TCP-only reachability cannot invent paper state", async t => {
  const directory = await temporaryWorkspace("tcp-health"); t.after(() => removeWorkspace(directory));
  const value = await deviceHealth({ transport: { kind: "tcp-escpos", probe: async () => true }, journal: await journalAt(directory) });
  assert.equal(value.printer.state, "ready"); assert.equal(value.printer.source, "tcp_connect"); assert.equal(value.printer.physicalReadinessKnown, false); assert.deepEqual(value.printer.faults, []);
});
test("a newer safely retried server attempt can replace a journal entry that never began dispatch", async t => {
  const directory = await temporaryWorkspace("safe-attempt-retry"); t.after(() => removeWorkspace(directory));
  const first=claimedJob(),second={...first,attempt:2,claimToken:'second_claim_token_abcdefghijklmnopqrstuvwxyz'};
  const api=new FakeApi([first,second]);let marks=0,writes=0;
  api.submitting=async()=>{if(++marks===1)throw new ApiError('old attempt expired',{status:401,code:'INVALID_CLAIM_TOKEN'});return{};};
  const transport=new WindowsSpoolerTransport({printerName:'Fixture'},{helper:async()=>{writes++;return{outcome:'submitted',spoolerJobId:'45',physicalPrinted:false};}});
  const journal=await journalAt(directory),bridge=new PrintBridge({api,journal,transport,logger});
  await bridge.runOnce();assert.equal(writes,0);assert.equal(journal.get(first.id).state,'ack_rejected');
  await bridge.runOnce();assert.equal(writes,1);assert.equal(journal.get(first.id).attempt,2);assert.equal(journal.get(first.id).priorAttempts.length,1);assert.equal(api.acks.length,1);
});
