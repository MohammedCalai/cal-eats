import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const { values } = parseArgs({ options: { db: { type: "string" } } });
if (!values.db) throw new Error("Usage: node apps/api/scripts/mailbox.js --db <sqlite-file>");
const filename = resolve(values.db);
if (!existsSync(filename)) throw new Error("Mailbox database does not exist");
const db = new DatabaseSync(filename, { readOnly: true });
try {
  db.exec("PRAGMA query_only = ON");
  const rows = db.prepare("SELECT recipient,kind,subject,body,created_at FROM local_mail_sink ORDER BY created_at DESC").all();
  if (!rows.length) process.stdout.write("Local mailbox is empty.\n");
  for (const row of rows) process.stdout.write(`\n[${row.created_at}] ${row.kind} -> ${row.recipient}\n${row.subject}\n${row.body}\n`);
} finally { db.close(); }
