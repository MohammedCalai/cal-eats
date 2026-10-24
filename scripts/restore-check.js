import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { BACKUP_ROOT } from "./backup.js";

const REQUIRED_TABLES = ["schema_migrations", "users", "restaurants", "orders"];

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveBackupInput(input) {
  if (!input) throw new Error("Provide a backup path to check");
  const resolved = path.resolve(input);
  if (!inside(BACKUP_ROOT, resolved) || path.extname(resolved) !== ".sqlite") throw new Error(`Backup input must be a .sqlite file inside ${BACKUP_ROOT}`);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`Backup does not exist: ${resolved}`);
  return resolved;
}

export function inspectDatabase(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]);
    if (integrity.length !== 1 || integrity[0] !== "ok") throw new Error(`Integrity check failed: ${integrity.join("; ")}`);
    const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length) throw new Error(`Foreign key check failed with ${foreignKeys.length} violation(s)`);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name));
    const missing = REQUIRED_TABLES.filter((table) => !tables.has(table));
    if (missing.length) throw new Error(`Required schema is missing: ${missing.join(", ")}`);
    const migrationCount = db.prepare("SELECT count(*) AS count FROM schema_migrations").get().count;
    if (migrationCount < 1) throw new Error("No applied schema migration records found");
    const counts = Object.fromEntries(["users", "restaurants", "orders"].map((table) => [table, db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count]));
    return { integrity: "ok", foreignKeyViolations: 0, migrationCount, counts };
  } finally {
    db.close();
  }
}

export function checkBackup(input) {
  const backupPath = resolveBackupInput(input);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "calai-eats-restore-check-"));
  const checkedCopy = path.join(tempRoot, "restore-check.sqlite");
  try {
    fs.copyFileSync(backupPath, checkedCopy, fs.constants.COPYFILE_EXCL);
    return { backupPath, ...inspectDatabase(checkedCopy) };
  } finally {
    const resolvedTemp = path.resolve(tempRoot);
    const expectedParent = path.resolve(os.tmpdir());
    if (!inside(expectedParent, resolvedTemp) || !path.basename(resolvedTemp).startsWith("calai-eats-restore-check-")) throw new Error("Refusing unsafe temporary cleanup");
    fs.rmSync(resolvedTemp, { recursive: true, force: true });
  }
}

function main() {
  const [input, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error("Usage: node scripts/restore-check.js backups/<file>.sqlite");
  const result = checkBackup(input);
  console.log(`Backup verified: ${result.backupPath}`);
  console.log(`Integrity: ${result.integrity}; migrations: ${result.migrationCount}; users: ${result.counts.users}; restaurants: ${result.counts.restaurants}; orders: ${result.counts.orders}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { try { main(); } catch (error) { console.error(`Restore check failed: ${error.message}`); process.exitCode = 1; } }
