import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKUP_ROOT, createBackup } from "./backup.js";
import { checkBackup } from "./restore-check.js";

function fixture(name) {
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  const source = path.join(BACKUP_ROOT, `${name}-source.sqlite`);
  const destination = path.join(BACKUP_ROOT, `${name}-backup.sqlite`);
  for (const file of [source, destination, `${source}-wal`, `${source}-shm`]) fs.rmSync(file, { force: true });
  const db = new DatabaseSync(source);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE restaurants(id TEXT PRIMARY KEY); CREATE TABLE orders(id TEXT PRIMARY KEY); INSERT INTO schema_migrations VALUES(1); PRAGMA wal_checkpoint(TRUNCATE);");
  return { source, destination, db, cleanup() { db.close(); for (const file of [source, destination, `${source}-wal`, `${source}-shm`]) fs.rmSync(file, { force: true }); } };
}

test("online backup includes committed data still present in WAL", async () => {
  const item = fixture(`wal-${process.pid}`);
  try {
    item.db.exec("INSERT INTO users VALUES('wal-user')");
    assert.ok(fs.existsSync(`${item.source}-wal`));
    await createBackup({ source: item.source, destination: item.destination });
    const backup = new DatabaseSync(item.destination, { readOnly: true });
    try { assert.equal(backup.prepare("SELECT id FROM users").get().id, "wal-user"); } finally { backup.close(); }
    assert.equal(checkBackup(item.destination).integrity, "ok");
  } finally { item.cleanup(); }
});

test("backup refuses to overwrite an existing destination", async () => {
  const item = fixture(`overwrite-${process.pid}`);
  try {
    fs.writeFileSync(item.destination, "keep me");
    await assert.rejects(createBackup({ source: item.source, destination: item.destination }), /Refusing to overwrite/);
    assert.equal(fs.readFileSync(item.destination, "utf8"), "keep me");
  } finally { item.cleanup(); }
});

test("concurrent backups to one destination allow one owner and preserve its backup", async () => {
  const item = fixture(`concurrent-${process.pid}`);
  try {
    item.db.exec("INSERT INTO users VALUES('concurrent-user')");
    const attempts = await Promise.allSettled([
      createBackup({ source: item.source, destination: item.destination }),
      createBackup({ source: item.source, destination: item.destination })
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    assert.match(rejected.reason.message, /Refusing to overwrite/);
    const backup = new DatabaseSync(item.destination, { readOnly: true });
    try {
      assert.equal(backup.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(backup.prepare("SELECT id FROM users").get().id, "concurrent-user");
    } finally { backup.close(); }
  } finally { item.cleanup(); }
});

test("restore check rejects a corrupt backup", () => {
  const corrupt = path.join(BACKUP_ROOT, `corrupt-${process.pid}.sqlite`);
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  fs.writeFileSync(corrupt, Buffer.from("not a sqlite database"));
  try { assert.throws(() => checkBackup(corrupt), /database|file is not a database/i); }
  finally { fs.rmSync(corrupt, { force: true }); }
});

test("managed backup outputs cannot escape the project backup directory", async () => {
  const item = fixture(`scope-${process.pid}`);
  try { await assert.rejects(createBackup({ source: item.source, destination: path.join(BACKUP_ROOT, "..", "escape.sqlite") }), /inside/); }
  finally { item.cleanup(); }
});
