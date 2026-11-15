import { escPosBytes } from "./receipt.js";
import { runWindowsHelper } from "./windows-helper.js";

const STATUS_BITS = [[0x1,"paused_queue"],[0x2,"printer_error"],[0x4,"printer_error"],[0x8,"printer_error"],[0x10,"out_of_paper"],[0x40,"printer_error"],[0x80,"offline"],[0x800,"printer_error"],[0x1000,"driver_unavailable"],[0x40000,"printer_error"],[0x100000,"printer_error"],[0x200000,"printer_error"],[0x400000,"cover_open"]];
export function spoolerDiagnostic(result, observedAt = new Date().toISOString()) {
  if (!result?.installed || !Number.isSafeInteger(result.statusBits) || result.statusBits < 0) return { state: "unknown", source: "windows_spooler", faults: ["spooler_unavailable"], observedAt, physicalReadinessKnown: false };
  const faults = [...new Set(STATUS_BITS.filter(([bit]) => (result.statusBits & bit) !== 0).map(([,name]) => name))];
  return { state: faults.length ? "needs_attention" : "ready", source: "windows_spooler", faults, observedAt, physicalReadinessKnown: false, spoolerStatusBits: result.statusBits, queuedJobs: Number.isSafeInteger(result.queuedJobs) ? result.queuedJobs : null };
}

export class WindowsSpoolerTransport {
  constructor({ printerName, timeoutMs = 10_000 }, { helper = runWindowsHelper } = {}) {
    this.kind = "windows-spooler"; this.recovery = "ambiguous"; this.printerName = printerName; this.timeoutMs = timeoutMs; this.helper = helper;
  }
  async diagnostics() {
    try { return spoolerDiagnostic(await this.helper("printer-adapter.ps1", { action: "inspect", printerName: this.printerName }, { timeoutMs: this.timeoutMs })); }
    catch { return spoolerDiagnostic(null); }
  }
  async probe() { const value = await this.diagnostics(); return value.state === "ready"; }
  async inspect() { return null; } // A completed/removed spooler job does not prove paper.
  async send(entry) {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(entry.id) || !Number.isSafeInteger(entry.attempt) || entry.attempt < 1 || entry.attempt > 1000) throw new Error("Invalid Windows receipt identity");
    const value = await this.helper("printer-adapter.ps1", { action: "submit", printerName: this.printerName, documentName: `Cal-Eats-${entry.id}-${entry.attempt}`, payloadBase64: escPosBytes(entry.receiptText).toString("base64") }, { timeoutMs: this.timeoutMs });
    if (!/^[1-9][0-9]{0,9}$/.test(value?.spoolerJobId || "") || !["submitted", "uncertain"].includes(value.outcome) || value.physicalPrinted !== false) throw new Error("Windows spooler submission could not be confirmed");
    return { outcome: value.outcome, spoolerJobId: value.spoolerJobId, detail: value.outcome === "submitted" ? "Windows spooler accepted the receipt; physical paper output is unverified" : "Windows spooler assigned a job; output is uncertain and was not retried" };
  }
}

export async function deviceHealth({ transport, journal, printerId = null }) {
  let printer;
  if (typeof transport.diagnostics === "function") printer = await transport.diagnostics();
  else {
    const reachable = await transport.probe();
    printer = { state: transport.kind === "file-sink" ? "unknown" : reachable ? "ready" : "unreachable", source: transport.kind === "file-sink" ? "none" : "tcp_connect", faults: reachable ? [] : ["connection_failed"], observedAt: new Date().toISOString(), physicalReadinessKnown: false };
  }
  const entries = journal.entries();
  const { state, source, faults, observedAt, physicalReadinessKnown } = printer;
  return { bridgeVersion: "1.0.0", printer: { ...(printerId ? { id: printerId } : {}), state, source, faults, observedAt, physicalReadinessKnown, spoolerJobIds: entries.filter(entry => entry.spoolerJobId).slice(-30).map(entry => entry.spoolerJobId) }, jobs: { queued: entries.filter(entry => ["claimed", "dispatching", "ack_pending"].includes(entry.state)).length, failed: entries.filter(entry => entry.outcome === "failed" || entry.acknowledgement?.outcome === "failed" || entry.state === "ack_rejected").length, uncertain: entries.filter(entry => entry.outcome === "uncertain" || entry.acknowledgement?.outcome === "uncertain").length } };
}
