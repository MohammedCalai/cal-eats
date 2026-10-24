import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrations } from "./migrations.js";

export function openDatabase(filename) {
  if (filename !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  return db;
}

export function migrateDatabase(db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const applied = db.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version);
  for (const migration of migrations) {
    if (applied.includes(migration.version)) continue;
    if (migration.foreignKeysOff) db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(migration.sql);
        if (migration.foreignKeysOff && db.prepare("PRAGMA foreign_key_check").get()) throw new Error("Foreign key violation during migration");
        db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)").run(migration.version, migration.name, new Date().toISOString());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      if (migration.foreignKeysOff) db.exec("PRAGMA foreign_keys = ON");
    }
  }
  return migrations.length;
}

export function isDatabaseReady(db) {
  try {
    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    return migrations.every((migration) => rows.some((row) => row.version === migration.version));
  } catch { return false; }
}

export function closeDatabase(db) { db.close(); }

export function withTransaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
