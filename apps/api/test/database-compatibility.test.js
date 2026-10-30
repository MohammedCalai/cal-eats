import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrateDatabase, prepareDatabase, assertDatabaseCompatible, isDatabaseReady } from "../src/db/index.js";
import { migrations } from "../src/db/migrations.js";
import { loadConfig } from "../src/config.js";

test("migration-free startup refuses an empty database without creating schema", () => {
  const db = openDatabase(":memory:");
  try {
    assert.throws(() => prepareDatabase(db, { migrateOnStart: false }), { code: "DATABASE_MIGRATION_REQUIRED" });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE type='table'").get().n, 0);
    assert.equal(isDatabaseReady(db), false);
  } finally { db.close(); }
});

test("a current database can start without migration writes", () => {
  const db = openDatabase(":memory:");
  try {
    migrateDatabase(db);
    const before = db.prepare("SELECT total_changes() n").get().n;
    const schema = db.prepare("PRAGMA schema_version").get().schema_version;
    assert.equal(prepareDatabase(db, { migrateOnStart: false }).pendingMigrations, 0);
    assert.equal(isDatabaseReady(db), true);
    assert.equal(db.prepare("SELECT total_changes() n").get().n, before);
    assert.equal(db.prepare("PRAGMA schema_version").get().schema_version, schema);
  } finally { db.close(); }
});

for (const variant of ["newer", "gap", "renamed"]) {
  test(`incompatible ${variant} migration history is refused before any migration executes`, () => {
    const db = openDatabase(":memory:");
    try {
      migrateDatabase(db);
      if (variant === "newer") db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(migrations.at(-1).version + 1, "future-release", new Date().toISOString());
      if (variant === "gap") db.prepare("DELETE FROM schema_migrations WHERE version=?").run(migrations[1].version);
      if (variant === "renamed") db.prepare("UPDATE schema_migrations SET name='unexpected' WHERE version=?").run(migrations[0].version);
      const before = db.prepare("SELECT total_changes() n").get().n;
      const schema = db.prepare("PRAGMA schema_version").get().schema_version;
      assert.throws(() => migrateDatabase(db), { code: "DATABASE_SCHEMA_INCOMPATIBLE" });
      assert.equal(isDatabaseReady(db), false);
      assert.equal(db.prepare("SELECT total_changes() n").get().n, before);
      assert.equal(db.prepare("PRAGMA schema_version").get().schema_version, schema);
    } finally { db.close(); }
  });
}

test("an intact older migration prefix remains eligible for the explicit upgrade path", () => {
  const db = openDatabase(":memory:");
  try {
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)");
    db.exec(migrations[0].sql);
    db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(migrations[0].version,migrations[0].name,new Date().toISOString());
    assert.equal(assertDatabaseCompatible(db).pendingMigrations,migrations.length-1);
    assert.throws(() => prepareDatabase(db,{migrateOnStart:false}),{code:"DATABASE_MIGRATION_REQUIRED"});
    prepareDatabase(db,{migrateOnStart:true});
    assert.equal(isDatabaseReady(db),true);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check,"ok");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
  } finally { db.close(); }
});

test("startup migration opt-out validates explicit boolean settings", () => {
  assert.equal(loadConfig({migrateOnStart:false}).migrateOnStart,false);
  assert.equal(loadConfig({migrateOnStart:"true"}).migrateOnStart,true);
  assert.throws(()=>loadConfig({migrateOnStart:"no"}),/must be true or false/);
});
