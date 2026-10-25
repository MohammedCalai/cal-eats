import { ApiError } from "./api-client.js";
import { formatReceipt } from "./receipt.js";
import { TransportError } from "./transports.js";

const sleepDefault = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function jobEnvelope(job) {
  if (!job || typeof job !== "object" || Array.isArray(job)) throw new Error("Claimed job is malformed");
  if (typeof job.id !== "string" || job.id.length < 8 || job.id.length > 100) throw new Error("Claimed job ID is malformed");
  if (typeof job.claimToken !== "string" || job.claimToken.length < 16 || job.claimToken.length > 500) throw new Error("Claim token is malformed");
  if (!Number.isSafeInteger(job.attempt) || job.attempt < 1 || job.attempt > 1000) throw new Error("Claim attempt is malformed");
  if (typeof job.manualReprint !== "boolean") throw new Error("manualReprint is malformed");
  const lease = new Date(job.leaseExpiresAt);
  if (!Number.isFinite(lease.valueOf())) throw new Error("Claim lease is malformed");
  return job;
}

function detail(error) {
  return String(error?.message || error || "Unknown error").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 300);
}

export class PrintBridge {
  constructor({ api, journal, transport, logger, clock = () => new Date(), sleep = sleepDefault, random = Math.random, hooks = {} }) {
    this.api = api;
    this.journal = journal;
    this.transport = transport;
    this.logger = logger;
    this.clock = clock;
    this.sleep = sleep;
    this.random = random;
    this.hooks = hooks;
  }

  async _queueAcknowledgement(entry, outcome, acknowledgementDetail) {
    return this.journal.update(entry.id, {
      state: "ack_pending",
      acknowledgement: { claimToken: entry.claimToken, outcome, ...(acknowledgementDetail ? { detail: acknowledgementDetail.slice(0, 300) } : {}) },
    });
  }

  async _ack(entry) {
    try {
      const outcome = entry.acknowledgement.outcome;
      await this.api.ack(entry.id, entry.acknowledgement);
      await this.journal.update(entry.id, { state: "acked", ackAttempts: entry.ackAttempts + 1, acknowledgedAt: this.clock().toISOString(), claimToken: null, receiptText: null, acknowledgement: null });
      await this.logger.info("job_acknowledged", { jobId: entry.id, outcome });
      return true;
    } catch (error) {
      await this.journal.update(entry.id, { ackAttempts: entry.ackAttempts + 1, lastAckError: detail(error) });
      if (error instanceof ApiError && !error.retryable) {
        await this.journal.update(entry.id, { state: "ack_rejected" });
        await this.logger.error("job_ack_rejected", { jobId: entry.id, status: error.status, code: error.code });
        return false;
      }
      throw error;
    }
  }

  async _dispatch(entry) {
    await this.journal.update(entry.id, { state: "dispatching", dispatchStartedAt: this.clock().toISOString() });
    await this.hooks.afterDispatchMarked?.(entry);
    let result;
    try {
      result = await this.transport.send(entry);
    } catch (error) {
      if (error?.simulateProcessCrash) throw error;
      if (this.transport.recovery === "deterministic") {
        const recovered = await this.transport.inspect(entry).catch(() => null);
        if (recovered) result = recovered;
      }
      if (!result) {
        const outcome = error instanceof TransportError && !error.ambiguous ? "failed" : "uncertain";
        result = { outcome, detail: detail(error) };
      }
    }
    entry = await this._queueAcknowledgement(entry, result.outcome, result.detail);
    await this.hooks.afterAcknowledgementQueued?.(entry);
    return this._ack(entry);
  }

  async _recoverEntry(entry) {
    if (entry.state === "claimed") return this._dispatch(entry);
    if (entry.state === "dispatching") {
      const observed = await this.transport.inspect(entry).catch(() => null);
      if (observed) {
        entry = await this._queueAcknowledgement(entry, observed.outcome, observed.detail);
        return this._ack(entry);
      }
      if (this.transport.recovery === "deterministic") {
        await this.journal.update(entry.id, { state: "claimed", recoveryDetail: "No committed simulator artifact; safe to retry" });
        return this._dispatch(this.journal.get(entry.id));
      }
      entry = await this._queueAcknowledgement(entry, "uncertain", "Bridge restarted after physical dispatch began; output may have occurred and was not retried");
      return this._ack(entry);
    }
    if (entry.state === "ack_pending") return this._ack(entry);
    return false;
  }

  async recoverOne() {
    const entry = this.journal.entries().find((candidate) => new Set(["claimed", "dispatching", "ack_pending"]).has(candidate.state));
    if (!entry) return false;
    await this._recoverEntry(entry);
    return true;
  }

  async runOnce() {
    if (await this.recoverOne()) return { recovered: true };
    const claimed = await this.api.claim();
    if (!claimed) return { idle: true };
    const job = jobEnvelope(claimed);
    let formatted;
    try {
      formatted = formatReceipt(job.receipt, { manualReprint: job.manualReprint });
    } catch (error) {
      const synthetic = { text: "", sha256: "invalid-receipt" };
      const entry = await this.journal.recordClaim(job, synthetic);
      const pending = await this._queueAcknowledgement(entry, "failed", `Receipt rejected: ${detail(error)}`);
      await this._ack(pending);
      return { failed: true };
    }
    const entry = await this.journal.recordClaim(job, formatted);
    await this.hooks.afterClaimPersisted?.(entry);
    await this._dispatch(entry);
    await this.journal.prune();
    return { processed: true };
  }

  async start({ signal, heartbeatIntervalMs, idlePollMs }) {
    let nextHeartbeat = 0;
    let errorDelay = 500;
    while (!signal.aborted) {
      try {
        if (Date.now() >= nextHeartbeat) {
          await this.api.heartbeat();
          nextHeartbeat = Date.now() + Math.round(heartbeatIntervalMs * (0.9 + this.random() * 0.2));
          await this.logger.info("heartbeat_ok", { transport: this.transport.kind });
        }
        const result = await this.runOnce();
        errorDelay = 500;
        if (result.idle) await this.sleep(Math.round(idlePollMs * (0.9 + this.random() * 0.2)));
      } catch (error) {
        if (signal.aborted) break;
        await this.logger.warn("bridge_cycle_failed", { code: error.code || error.name });
        await this.sleep(Math.round(errorDelay * (0.8 + this.random() * 0.4)));
        errorDelay = Math.min(30_000, errorDelay * 2);
      }
    }
  }
}
