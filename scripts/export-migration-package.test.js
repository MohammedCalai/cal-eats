import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import { migrateDatabase } from "../apps/api/src/db/index.js";
import { exportMigrationPackage, MIGRATION_ROOT, resolveMigrationSource } from "./export-migration-package.js";

const digest = value => createHash("sha256").update(value).digest("hex");
const artifacts = path.join(MIGRATION_ROOT, "artifacts");
const inside = (root, value) => { const relative = path.relative(root, value); return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative); };

test("migration sources cannot include original Calai, Git or outside-workspace files", () => {
  for (const file of [path.join(MIGRATION_ROOT, "reference", "original.sqlite"), path.join(MIGRATION_ROOT, ".git", "config"), path.resolve(MIGRATION_ROOT, "..", "other.sqlite")]) assert.throws(() => resolveMigrationSource(file), /Cal-Eats|forbidden/);
});

test("snapshot export preserves its source, excludes credentials and validates package links/checksums", async t => {
  fs.mkdirSync(artifacts, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(artifacts, "migration-export-test-")), source = path.join(temporary, "fixture.sqlite"), outputs = [];
  t.after(() => { for (const target of [...outputs, temporary]) { const absolute = path.resolve(target); assert.ok(inside(artifacts, absolute), "Cleanup must remain within Cal-Eats artifacts"); if (fs.existsSync(absolute)) { assert.ok(inside(fs.realpathSync(artifacts), fs.realpathSync(absolute)), "Cleanup must not follow an outside directory"); fs.rmSync(absolute, { recursive: true, force: true }); } } });
  const rich = path.join(artifacts, "business-phone-demo.sqlite");
  if (fs.existsSync(rich)) { const db = new DatabaseSync(rich, { readOnly: true }); try { await sqliteBackup(db, source); } finally { db.close(); } }
  else createSyntheticFixture(source);
  const db = new DatabaseSync(source);
  let selectedEmail, firstRestaurant, secondRestaurant, sourceMenuCount;
  const secrets = ["FIXTURE_PASSWORD_NEVER_EXPORT", "sk_test_FIXTURE_API_SECRET_NEVER_EXPORT", "FIXTURE_SESSION_TOKEN_NEVER_EXPORT"];
  try {
    selectedEmail = db.prepare("SELECT email FROM users ORDER BY id LIMIT 1").get().email;
    db.prepare("UPDATE users SET password_hash=?").run(secrets[0]);
    db.exec("CREATE TABLE export_test_credentials (id TEXT PRIMARY KEY,api_secret TEXT,session_token TEXT)");
    db.prepare("INSERT INTO export_test_credentials VALUES('private',?,?)").run(secrets[1], secrets[2]);
    const restaurants = db.prepare("SELECT id FROM restaurants ORDER BY id LIMIT 2").all(); [firstRestaurant, secondRestaurant] = restaurants.map(row => row.id);
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
    db.prepare("INSERT INTO media_assets(id,restaurant_id,mime_type,data,width,height,byte_length,created_at) VALUES('export-test-photo',?,'image/png',?,1,1,?,?)").run(firstRestaurant, bytes, bytes.length, "2026-10-28T10:00:00.000Z");
    db.prepare("UPDATE restaurants SET cover_media_id='export-test-photo' WHERE id=?").run(firstRestaurant);
    sourceMenuCount = db.prepare("SELECT COUNT(*) n FROM menu_items").get().n;
  } finally { db.close(); }
  const before = digest(fs.readFileSync(source));
  const dry = exportMigrationPackage({ source });
  assert.equal(dry.destination, null); assert.equal(dry.report.dryRun, true); assert.equal(dry.report.selectedCounts.users, undefined); assert.equal(dry.report.selectedCounts.orders, undefined); assert.equal(JSON.stringify(dry).includes(selectedEmail), false); assert.equal(dry.report.validation.passed, true);
  const now = new Date(Date.now() + Math.floor(Math.random() * 1_000_000));
  const written = exportMigrationPackage({ source, write: true, includeAccounts: true, includeOrders: true, includeMedia: true, now }); outputs.push(written.destination);
  const manifestBytes = fs.readFileSync(path.join(written.destination, "manifest.json")), manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.selectedCounts.menu_items, sourceMenuCount); assert.equal(manifest.validation.passed, true); assert.equal(manifest.constraints.queryOnly, true); assert.equal(manifest.linkage.unresolvedExportedEntityLinks, 0); assert.equal(manifest.importReady, false); assert.equal(fs.existsSync(path.join(written.destination, "INCOMPLETE.txt")), false);
  assert.equal(fs.readFileSync(path.join(written.destination, "manifest.sha256"), "utf8").split(" ")[0], digest(manifestBytes));
  let jsonContents = manifestBytes.toString();
  for (const file of manifest.files) { const bytes = fs.readFileSync(path.join(written.destination, file.path)); assert.equal(bytes.length, file.bytes); assert.equal(digest(bytes), file.sha256); if (file.path.endsWith(".json")) jsonContents += bytes.toString(); }
  for (const secret of secrets) assert.equal(jsonContents.includes(secret), false, "Credential values must be absent from every package JSON file");
  const users = JSON.parse(fs.readFileSync(path.join(written.destination, "users.json"), "utf8")); assert.ok(users.records.every(row => row.sourceId.startsWith("cal-eats:user:") && !("password_hash" in row.values)));
  assert.equal(digest(fs.readFileSync(source)), before, "Export must not modify the closed source database bytes");
  assert.throws(() => exportMigrationPackage({ source, write: true, now }), /overwrite/);
  assert.equal(digest(fs.readFileSync(path.join(written.destination, "manifest.json"))), digest(manifestBytes));
  const corrupt = new DatabaseSync(source); try { corrupt.prepare("UPDATE restaurants SET cover_media_id='export-test-photo' WHERE id=?").run(secondRestaurant); } finally { corrupt.close(); }
  const rejected = exportMigrationPackage({ source }); assert.ok(rejected.report.validation.crossTenantViolations > 0); assert.equal(rejected.report.validation.passed, false);
  assert.throws(() => exportMigrationPackage({ source, write: true, now: new Date(now.getTime() + 1) }), /checks failed/);
});

function createSyntheticFixture(filename) {
  const db = new DatabaseSync(filename); migrateDatabase(db);
  try {
    const stamp = "2026-10-28T10:00:00.000Z";
    for (const [id, role] of [["owner", "restaurant"], ["customer", "customer"]]) db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)").run(id, `Fictional ${id}`, `${id}@example.invalid`, "non-authenticating-fixture", role, stamp);
    for (const id of ["restaurant-1", "restaurant-2"]) { db.prepare("INSERT INTO restaurants(id,name,status,created_at) VALUES(?,?,'approved',?)").run(id, `Fictional ${id}`, stamp); db.prepare("INSERT INTO restaurant_memberships(restaurant_id,user_id,created_at,permission) VALUES(?,'owner',?,'owner')").run(id, stamp); }
    db.prepare("INSERT INTO menu_items(id,restaurant_id,name,description,price_minor,available,created_at,updated_at) VALUES('menu-1','restaurant-1','Fictional bowl','Fixture',1000,1,?,?)").run(stamp, stamp);
    db.prepare("INSERT INTO orders(id,restaurant_id,restaurant_name,customer_id,status,currency,subtotal_minor,delivery_fee_minor,total_minor,commission_minor,payment_method,payment_status,fulfillment,idempotency_key,request_hash,created_at,updated_at) VALUES('order-1','restaurant-1','Fictional restaurant','customer','completed','GBP',1000,0,1000,70,'mock_card','mock_captured','collection','fixture-key','fixture-hash',?,?)").run(stamp, stamp);
    db.prepare("INSERT INTO order_items(id,order_id,menu_item_id,name,unit_price_minor,quantity,base_price_minor) VALUES('line-1','order-1','menu-1','Fictional bowl',1000,1,1000)").run();
  } finally { db.close(); }
}
