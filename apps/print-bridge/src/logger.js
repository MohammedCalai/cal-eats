import fs from "node:fs/promises";
import path from "node:path";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export class Logger {
  constructor(filePath, { consoleOutput = true } = {}) {
    this.filePath = filePath;
    this.consoleOutput = consoleOutput;
  }

  async _rotate() {
    try {
      const info = await fs.stat(this.filePath);
      if (info.size < MAX_LOG_BYTES) return;
      await fs.rm(`${this.filePath}.1`, { force: true });
      await fs.rename(this.filePath, `${this.filePath}.1`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async write(level, event, details = {}) {
    const safeDetails = Object.fromEntries(Object.entries(details).filter(([key]) => !/token|receipt|credential|address|phone|name/i.test(key)));
    const record = { at: new Date().toISOString(), level, event, ...safeDetails };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await this._rotate();
    await fs.appendFile(this.filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    if (this.consoleOutput) process.stdout.write(`${record.at} ${level.toUpperCase()} ${event}\n`);
  }

  info(event, details) { return this.write("info", event, details); }
  warn(event, details) { return this.write("warn", event, details); }
  error(event, details) { return this.write("error", event, details); }
}

export class NullLogger {
  info() { return Promise.resolve(); }
  warn() { return Promise.resolve(); }
  error() { return Promise.resolve(); }
}
