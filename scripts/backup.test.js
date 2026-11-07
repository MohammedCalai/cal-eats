import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKUP_ROOT, createBackup } from "./backup.js";
import { checkBackup } from "./restore-check.js";
import { journeyFixture } from "../apps/api/test/helpers.js";
import { addNotification } from "../apps/api/src/offers.js";

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

test("restorable backups omit phone tokens and pending alerts without changing the live source or order history", async () => {
  const item = fixture(`push-${process.pid}`);
  try {
    item.db.exec("CREATE TABLE customer_push_devices(id TEXT PRIMARY KEY,ciphertext TEXT); CREATE TABLE customer_push_outbox(id TEXT PRIMARY KEY,device_id TEXT REFERENCES customer_push_devices(id)); INSERT INTO customer_push_devices VALUES('phone-one','private-fixture-token-material'); INSERT INTO customer_push_outbox VALUES('alert-one','phone-one'); INSERT INTO orders VALUES('retained-order');");
    await createBackup({ source: item.source, destination: item.destination });
    const backup = new DatabaseSync(item.destination, { readOnly: true });
    try {
      assert.equal(backup.prepare("SELECT COUNT(*) n FROM customer_push_devices").get().n, 0);
      assert.equal(backup.prepare("SELECT COUNT(*) n FROM customer_push_outbox").get().n, 0);
      assert.equal(backup.prepare("SELECT id FROM orders").get().id, "retained-order");
      assert.equal(backup.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(backup.prepare("PRAGMA foreign_key_check").all().length, 0);
    } finally { backup.close(); }
    assert.equal(item.db.prepare("SELECT ciphertext FROM customer_push_devices").get().ciphertext, "private-fixture-token-material");
    assert.equal(item.db.prepare("SELECT COUNT(*) n FROM customer_push_outbox").get().n, 1);
    assert.equal(fs.readFileSync(item.destination).includes(Buffer.from("private-fixture-token-material")), false);
  } finally { item.cleanup(); }
});

test("a migrated backup cannot revive native customer sessions or replay Live Activity and push delivery", async () => {
  const f = await journeyFixture();
  const destination = path.join(BACKUP_ROOT, `live-activity-${process.pid}-backup.sqlite`);
  fs.rmSync(destination, { force: true });
  try {
    const customer = await f.login("customer@calai.local", "LocalCustomer!4310");
    const owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310");
    const restaurant = f.db.prepare("SELECT id FROM restaurants WHERE name='Calai Kitchen'").get();
    const menu = f.db.prepare("SELECT id FROM menu_items WHERE restaurant_id=? LIMIT 1").get(restaurant.id);
    const response = await f.json("/api/orders", { method: "POST", cookie: customer, headers: { "Idempotency-Key": "backup-privacy-fixture" }, body: {
      restaurantId: restaurant.id, items: [{ menuItemId: menu.id, quantity: 1 }], paymentMethod: "cash", fulfillment: "collection",
      customerPhone: "07100000000", allergyNotes: "fixture allergy note retained with order"
    } });
    assert.equal(response.status, 201, response.text);
    const order = response.body.data;
    const accepted = await f.json(`/api/restaurant/orders/${order.id}/status`, { method: "PATCH", cookie: owner, body: { status: "accepted", estimatedReadyAt: "2026-01-01T01:30:00.000Z" } });
    assert.equal(accepted.status, 200, accepted.text);
    assert.ok(f.db.prepare("SELECT COUNT(*) n FROM ledger_entries WHERE order_id=?").get(order.id).n > 0);
    const stamp = "2026-01-01T01:01:00.000Z", expires = "2026-01-01T08:00:00.000Z";
    f.db.prepare("INSERT INTO native_sessions VALUES(?,?,?,?,?,NULL)").run("backup-native-session", order.customerId, "private-fixture-session-hash", stamp, expires);
    f.db.prepare(`INSERT INTO customer_push_devices(id,installation_id,user_id,session_id,token_hash,ciphertext,nonce,auth_tag,key_version,platform,project_id,generation,sound_enabled,expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'ios',?,1,0,?,?,?)`).run("backup-push-device", "backup-installation", order.customerId, "backup-native-session", "backup-push-hash", "private-fixture-push-ciphertext", "nonce", "tag", "v1", "5bf59184-c670-44f4-be78-5229cbd02300", expires, stamp, stamp);
    f.db.prepare(`INSERT INTO customer_order_live_activities(id,activity_id,installation_id,user_id,session_id,order_id,project_id,token_hash,ciphertext,nonce,auth_tag,key_version,generation,state,expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,'active',?,?,?)`).run("backup-live-binding", "backup-activity", "backup-installation", order.customerId, "backup-native-session", order.id, "5bf59184-c670-44f4-be78-5229cbd02300", "backup-live-hash", "private-fixture-live-ciphertext", "nonce", "tag", "v1", expires, stamp, stamp);
    f.db.prepare("INSERT INTO order_live_activity_outbox(activity_id,generation,revision,status,available_at,updated_at) VALUES(?,1,1,'pending',?,?)").run("backup-live-binding", stamp, stamp);
    addNotification(f.db, { userId: order.customerId, type: "order_status", title: "Fixture order", message: "Fixture update", orderId: order.id, restaurantId: restaurant.id, eventKey: "backup-fixture-before", now: stamp });
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM customer_push_outbox").get().n, 1);
    const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    const snapshot = db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name}) => [name, rows(db, name)]));
    const before = snapshot(f.db);
    await createBackup({ source: f.config.dbPath, destination });
    assert.deepEqual(snapshot(f.db), before, "Backup sanitation must not modify any source row");
    const copy = new DatabaseSync(destination);
    try {
      copy.exec("PRAGMA foreign_keys=ON");
      for (const table of ["order_live_activity_outbox", "customer_order_live_activities", "customer_push_outbox", "customer_push_devices", "native_sessions"]) {
        assert.equal(rows(copy, table).length, 0, table);
      }
      for (const table of ["users", "restaurants", "orders", "order_items", "order_events", "ledger_entries", "contracts", "commission_policies", "order_live_activity_revisions"]) {
        assert.deepEqual(rows(copy, table), before[table], `Preserve ${table}`);
      }
      // Exercise the real database triggers on the restored copy: an order
      // update or new alert cannot resurrect a registration from the snapshot.
      copy.prepare("UPDATE orders SET status='preparing',updated_at=? WHERE id=?").run(stamp, order.id);
      addNotification(copy, { userId: order.customerId, type: "order_status", title: "Fixture restored order", message: "Fixture restored update", orderId: order.id, restaurantId: restaurant.id, eventKey: "backup-fixture-after", now: stamp });
      assert.equal(rows(copy, "order_live_activity_outbox").length, 0);
      assert.equal(rows(copy, "customer_push_outbox").length, 0);
      assert.equal(copy.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(copy.prepare("PRAGMA foreign_key_check").all().length, 0);
    } finally { copy.close(); }
    const bytes = fs.readFileSync(destination);
    for (const marker of ["private-fixture-session-hash", "private-fixture-push-ciphertext", "private-fixture-live-ciphertext"]) assert.equal(bytes.includes(Buffer.from(marker)), false, marker);
    assert.equal(checkBackup(destination).integrity, "ok");
  } finally {
    await f.close();
    for (const file of [destination, `${destination}-wal`, `${destination}-shm`]) fs.rmSync(file, { force: true });
  }
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
