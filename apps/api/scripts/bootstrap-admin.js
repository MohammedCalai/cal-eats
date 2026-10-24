import { parseArgs } from "node:util";
import { stdin, stdout } from "node:process";
import { createInitialAdmin } from "../src/admin-bootstrap.js";
import { loadConfig } from "../src/config.js";
import { closeDatabase, migrateDatabase, openDatabase } from "../src/db/index.js";

const { values } = parseArgs({ options: { db: { type: "string" }, name: { type: "string" }, email: { type: "string" } } });
if (!values.name || !values.email) throw new Error("Usage: node apps/api/scripts/bootstrap-admin.js --name <name> --email <email> [--db <sqlite-file>]");
async function secretInput() {
  if (!stdin.isTTY) { const chunks = []; let size = 0; for await (const chunk of stdin) { size += chunk.length; if (size > 1024) throw new Error("Password input is too large"); chunks.push(chunk); } return Buffer.concat(chunks).toString("utf8").replace(/[\r\n]+$/, ""); }
  stdout.write("Password: "); stdin.setRawMode(true); stdin.resume(); let value = "";
  try { for await (const chunk of stdin) { for (const char of chunk.toString("utf8")) { if (char === "\r" || char === "\n") { stdout.write("\n"); return value; } if (char === "\u0003") throw new Error("Cancelled"); if (char === "\u007f" || char === "\b") value = value.slice(0, -1); else { if (Buffer.byteLength(value + char) > 1024) throw new Error("Password input is too large"); value += char; } } } }
  finally { stdin.setRawMode(false); stdin.pause(); }
  return value;
}
const config = loadConfig({ ...(values.db ? { dbPath: values.db } : {}) }); const password = await secretInput(); const db = openDatabase(config.dbPath);
try { migrateDatabase(db); const admin = await createInitialAdmin(db, { name: values.name, email: values.email, password, runMode: config.runMode }); stdout.write(`Initial administrator created for ${admin.email}.\n`); }
finally { closeDatabase(db); }
