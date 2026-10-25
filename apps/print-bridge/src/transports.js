import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { escPosBytes } from "./receipt.js";

export class TransportError extends Error {
  constructor(message, { ambiguous = false } = {}) {
    super(message);
    this.name = "TransportError";
    this.ambiguous = ambiguous;
  }
}

function artifactStem(entry) {
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(entry.id)) throw new TransportError("Print job ID is unsafe for an artifact name");
  return `${entry.id}-attempt-${entry.attempt}`;
}

async function writeAtomic(filePath, data) {
  try {
    const existing = await fs.readFile(filePath);
    const expected = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (existing.equals(expected)) return;
    throw new TransportError("Existing simulator artifact content does not match this attempt");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, data, { flag: "wx", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

export class FileSinkTransport {
  constructor(outputDirectory) {
    this.kind = "file-sink";
    this.outputDirectory = outputDirectory;
    this.recovery = "deterministic";
  }

  paths(entry) {
    const stem = artifactStem(entry);
    return {
      text: path.join(this.outputDirectory, `${stem}.txt`),
      bytes: path.join(this.outputDirectory, `${stem}.escpos`),
      metadata: path.join(this.outputDirectory, `${stem}.json`),
    };
  }

  async inspect(entry) {
    const files = this.paths(entry);
    try {
      const metadata = JSON.parse(await fs.readFile(files.metadata, "utf8"));
      const text = await fs.readFile(files.text, "utf8");
      if (metadata.receiptSha256 !== entry.receiptSha256 || text !== entry.receiptText) throw new TransportError("Existing simulator artifact does not match the claimed receipt");
      await fs.access(files.bytes);
      return { outcome: "printed", detail: "File-sink simulation artifact committed" };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async send(entry) {
    await fs.mkdir(this.outputDirectory, { recursive: true, mode: 0o700 });
    const existing = await this.inspect(entry);
    if (existing) return existing;
    const files = this.paths(entry);
    try {
      await writeAtomic(files.text, entry.receiptText);
      await writeAtomic(files.bytes, escPosBytes(entry.receiptText));
      await writeAtomic(files.metadata, `${JSON.stringify({ schemaVersion: 1, product: "cal-eats", simulated: true, jobId: entry.id, attempt: entry.attempt, manualReprint: entry.manualReprint, receiptSha256: entry.receiptSha256 }, null, 2)}\n`);
      return { outcome: "printed", detail: "File-sink simulation artifact committed" };
    } catch (error) {
      const recovered = await this.inspect(entry).catch(() => null);
      if (recovered) return recovered;
      throw new TransportError(`File-sink simulation failed: ${error.message}`);
    }
  }
}

export class TcpEscPosTransport {
  constructor({ host, port, connectTimeoutMs }) {
    this.kind = "tcp-escpos";
    this.host = host;
    this.port = port;
    this.connectTimeoutMs = connectTimeoutMs;
    this.recovery = "ambiguous";
  }

  inspect() { return Promise.resolve(null); }

  async send(entry) {
    const payload = escPosBytes(entry.receiptText);
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let connected = false;
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        callback(value);
      };
      socket.setTimeout(this.connectTimeoutMs);
      socket.once("error", (error) => finish(reject, new TransportError(`TCP ESC/POS transport failed: ${error.message}`, { ambiguous: connected })));
      socket.once("timeout", () => finish(reject, new TransportError("TCP ESC/POS transport timed out", { ambiguous: connected })));
      socket.connect(this.port, this.host, () => {
        connected = true;
        socket.end(payload, () => finish(resolve, { outcome: "uncertain", detail: "ESC/POS bytes were accepted by the network stack; physical paper output is unverified" }));
      });
    });
  }
}

export function createTransport(config, { allowPhysicalTransport = false } = {}) {
  if (config.kind === "file-sink") return new FileSinkTransport(config.outputDirectory);
  if (config.kind === "tcp-escpos") {
    if (!allowPhysicalTransport) throw new Error("TCP ESC/POS is disabled; pass --allow-physical-transport only for separately authorised hardware testing");
    return new TcpEscPosTransport(config);
  }
  throw new Error("Unsupported transport");
}
