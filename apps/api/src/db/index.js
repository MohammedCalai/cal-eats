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
  assertDatabaseCompatible(db);
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const migration of migrations) {
    if (migration.foreignKeysOff) db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(migration.version)) { db.exec("COMMIT"); continue; }
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

export function assertDatabaseCompatible(db, { requireCurrent = false } = {}) {
  const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='schema_migrations'").get();
  const rows = exists ? db.prepare("SELECT version,name FROM schema_migrations ORDER BY version").all() : [];
  for (let index = 0; index < rows.length; index++) {
    const expected = migrations[index], applied = rows[index];
    if (!expected || applied.version !== expected.version || applied.name !== expected.name) {
      const error = new Error("Database migration history is not compatible with this release. Use a compatible release; no migration was attempted.");
      error.code = "DATABASE_SCHEMA_INCOMPATIBLE";
      throw error;
    }
  }
  const state = { appliedVersion: rows.at(-1)?.version ?? 0, supportedVersion: migrations.at(-1)?.version ?? 0, pendingMigrations: migrations.length - rows.length };
  if (requireCurrent && state.pendingMigrations) {
    const error = new Error("Database migrations are pending. Apply the approved migration step before starting this release.");
    error.code = "DATABASE_MIGRATION_REQUIRED";
    throw error;
  }
  return state;
}

export function prepareDatabase(db, { migrateOnStart = true } = {}) {
  if (migrateOnStart) migrateDatabase(db);
  return assertDatabaseCompatible(db, { requireCurrent: true });
}

export function isDatabaseReady(db) {
  try { assertDatabaseCompatible(db, { requireCurrent: true }); return true; }
  catch { return false; }
}

export function closeDatabase(db) { db.close(); }

export function withTransaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
