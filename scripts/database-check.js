import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { assertDatabaseCompatible } from "../apps/api/src/db/index.js";

export function checkDatabase(filename) {
  // Opening read-only also refuses to create a missing database.
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const schema = assertDatabaseCompatible(db, { requireCurrent: true });
    const integrity = db.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") throw new Error("Database integrity check failed");
    const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
    if (foreignKeyViolations) throw new Error(`Database contains ${foreignKeyViolations} foreign-key violation(s)`);
    return { ...schema, integrity: "ok", foreignKeyViolations: 0 };
  } finally { db.close(); }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--database")) throw new Error("Usage: npm run db:check -- --database <existing.sqlite>");
  const filename = args[1] || process.env.CALAI_DB_PATH || path.join(import.meta.dirname, "../data/calai-eats.sqlite");
  console.log(JSON.stringify(checkDatabase(path.resolve(filename))));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { console.error(`Database check failed: ${error.code === "DATABASE_SCHEMA_INCOMPATIBLE" || error.code === "DATABASE_MIGRATION_REQUIRED" ? error.message : "Cannot verify this database. Check the path, access, schema and integrity."}`); process.exitCode = 1; }
}
