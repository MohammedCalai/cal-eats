import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { closeDatabase, migrateDatabase, openDatabase } from "../src/db/index.js";
import { seedDemoData } from "../src/seed.js";

export async function journeyFixture(configOverrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "calai-journey-"));
  const db = openDatabase(path.join(directory, "test.sqlite"));
  migrateDatabase(db);
  await seedDemoData(db, new Date("2026-01-01T00:00:00.000Z"));
  let tick = 0;
  const config = loadConfig({ dbPath: path.join(directory, "test.sqlite"), now: () => new Date(Date.parse("2026-01-01T01:00:00.000Z") + tick++ * 1000), ...configOverrides });
  const app = createApp({ db, config });
  async function request(route, { method = "GET", body, cookie, headers = {} } = {}) {
    const allHeaders = Object.fromEntries(Object.entries({ host: config.expectedHost, ...(cookie ? { cookie } : {}), ...headers }).map(([key, value]) => [key.toLowerCase(), value]));
    let input = "";
    if (body !== undefined) { allHeaders["content-type"] ??= "application/json"; input = JSON.stringify(body); }
    const req = Readable.from(input ? [Buffer.from(input)] : []);
    Object.assign(req, { method, url: route, headers: allHeaders, socket: { remoteAddress: "127.0.0.1" } });
    return new Promise((resolve) => {
      const responseHeaders = new Map(); const chunks = [];
      const res = { headersSent: false, statusCode: 200,
        setHeader(key, value) { responseHeaders.set(key.toLowerCase(), value); },
        writeHead(status, values = {}) { this.statusCode = status; this.headersSent = true; for (const [key, value] of Object.entries(values)) responseHeaders.set(key.toLowerCase(), value); },
        end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.statusCode, headers: responseHeaders, text: Buffer.concat(chunks).toString("utf8") }); },
        destroy() { resolve({ status: this.statusCode, headers: responseHeaders, text: "" }); }
      };
      app(req, res);
    });
  }
  async function json(route, options) { const response = await request(route, options); return { ...response, body: JSON.parse(response.text) }; }
  async function login(email, password) {
    const response = await json("/api/auth/login", { method: "POST", body: { email, password } });
    if (response.status !== 200) throw new Error(`Login failed: ${response.text}`);
    return response.headers.get("set-cookie").split(";", 1)[0];
  }
  return { db, config, directory, request, json, login, async close() { closeDatabase(db); await rm(directory, { recursive: true, force: true }); } };
}
