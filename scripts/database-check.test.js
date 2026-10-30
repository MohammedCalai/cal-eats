import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { openDatabase, migrateDatabase } from "../apps/api/src/db/index.js";
import { migrations } from "../apps/api/src/db/migrations.js";
import { checkDatabase } from "./database-check.js";

test("database preflight is read-only, rejects missing/future databases and accepts current schema", () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(),"cal-eats-db-check-"));
  const filename = path.join(directory,"fixture.sqlite");
  const digest = () => createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
  try {
    assert.throws(()=>checkDatabase(filename));
    assert.equal(fs.existsSync(filename),false);
    let db = openDatabase(filename);
    try {migrateDatabase(db);} finally {db.close();}
    const before = digest();
    assert.deepEqual(checkDatabase(filename),{appliedVersion:migrations.at(-1).version,supportedVersion:migrations.at(-1).version,pendingMigrations:0,integrity:"ok",foreignKeyViolations:0});
    assert.equal(digest(),before);
    db = openDatabase(filename);
    try {db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(migrations.at(-1).version+1,"future",new Date().toISOString());} finally {db.close();}
    const future = digest();
    assert.throws(()=>checkDatabase(filename),{code:"DATABASE_SCHEMA_INCOMPATIBLE"});
    assert.equal(digest(),future);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(tmpdir()));
    assert.match(path.basename(directory),/^cal-eats-db-check-/);
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
