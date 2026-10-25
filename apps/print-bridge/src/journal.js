import fs from "node:fs/promises";
import path from "node:path";

const VALID_STATES = new Set(["claimed", "dispatching", "ack_pending", "acked", "ack_rejected"]);

function initialState(now) {
  return { schemaVersion: 1, product: "cal-eats", updatedAt: now.toISOString(), jobs: {} };
}

function validateState(state) {
  if (!state || state.schemaVersion !== 1 || state.product !== "cal-eats" || !state.jobs || typeof state.jobs !== "object") {
    throw new Error("Print journal belongs to another product or is malformed");
  }
  for (const [id, entry] of Object.entries(state.jobs)) {
    if (entry.id !== id || !VALID_STATES.has(entry.state)) throw new Error(`Print journal entry ${id} is malformed`);
  }
  return state;
}

export class Journal {
  constructor(filePath, { clock = () => new Date() } = {}) {
    this.filePath = filePath;
    this.clock = clock;
    this.state = null;
  }

  async load() {
    try {
      this.state = validateState(JSON.parse(await fs.readFile(this.filePath, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`Cannot load print journal: ${error.message}`);
      this.state = initialState(this.clock());
      await this.save();
    }
    return this;
  }

  async save() {
    if (!this.state) throw new Error("Print journal is not loaded");
    this.state.updatedAt = this.clock().toISOString();
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, this.filePath);
    try { await fs.chmod(this.filePath, 0o600); } catch { /* Windows ACLs are applied by the installer. */ }
  }

  entries() {
    if (!this.state) throw new Error("Print journal is not loaded");
    return Object.values(this.state.jobs).sort((a, b) => a.claimedAt.localeCompare(b.claimedAt));
  }

  get(id) { return this.state?.jobs[id] ?? null; }

  async recordClaim(job, formatted, now = this.clock()) {
    if (this.state.jobs[job.id]) return this.state.jobs[job.id];
    this.state.jobs[job.id] = {
      id: job.id,
      state: "claimed",
      claimToken: job.claimToken,
      leaseExpiresAt: job.leaseExpiresAt,
      attempt: job.attempt,
      manualReprint: job.manualReprint,
      receiptText: formatted.text,
      receiptSha256: formatted.sha256,
      claimedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      acknowledgement: null,
      ackAttempts: 0,
    };
    await this.save();
    return this.state.jobs[job.id];
  }

  async update(id, changes, now = this.clock()) {
    const entry = this.state.jobs[id];
    if (!entry) throw new Error(`Unknown journal job ${id}`);
    Object.assign(entry, changes, { updatedAt: now.toISOString() });
    if (!VALID_STATES.has(entry.state)) throw new Error(`Invalid journal state ${entry.state}`);
    await this.save();
    return entry;
  }

  async prune(limit = 250) {
    const completed = this.entries().filter((entry) => entry.state === "acked");
    for (const entry of completed.slice(0, Math.max(0, completed.length - limit))) delete this.state.jobs[entry.id];
    await this.save();
  }
}
