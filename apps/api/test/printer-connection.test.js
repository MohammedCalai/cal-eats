import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { journeyFixture } from "./helpers.js";
import { migrateDatabase, openDatabase } from "../src/db/index.js";
import { migrations } from "../src/db/migrations.js";
import { seedDemoData } from "../src/seed.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
function setupFromZip(bytes) {
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const length = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString("utf8"), start = offset + 30 + nameLength + extraLength;
    if (name === "setup.json") return JSON.parse(bytes.subarray(start, start + length).toString("utf8"));
    offset = start + length;
  }
  assert.fail("Automatic printer setup must include setup.json");
}

async function printerFixture(f) {
  const owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310");
  const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0];
  const root = `/api/restaurant/restaurants/${restaurant.id}`;
  const created = await f.json(`${root}/printers`, { method: "POST", cookie: owner, body: { name: "Kitchen receipt printer", enabled: true, ipAddress: "192.0.2.24" } });
  assert.equal(created.status, 201, created.text);
  return { owner, restaurant, printer: created.body.data, root, setupPath: `${root}/printers/${created.body.data.id}/setup-package` };
}

test("one-use setup package is owner scoped, private, hashed at rest and has no device token", async () => {
  const f = await journeyFixture();
  try {
    const p = await printerFixture(f);
    const other = await f.login("restaurant2@calai.local", "LocalRestaurant2!4310");
    const customer = await f.login("customer@calai.local", "LocalCustomer!4310");
    const staffResponse = await f.json(`${p.root}/staff`, { method: "POST", cookie: p.owner, body: { name: "Kitchen staff", email: "setup-staff@example.invalid", password: "SetupStaff!4310" } });
    assert.equal(staffResponse.status, 201, staffResponse.text);
    const staff = await f.login("setup-staff@example.invalid", "SetupStaff!4310");
    for (const [cookie, expected] of [[undefined, 401], [other, 404], [customer, 403], [staff, 403]]) {
      assert.equal((await f.request(p.setupPath, { method: "POST", cookie, body: {} })).status, expected);
    }
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM printer_pairing_codes").get().n, 0);
    const downloaded = await f.request(p.setupPath, { method: "POST", cookie: p.owner, body: {} });
    assert.equal(downloaded.status, 200, downloaded.text.slice(0, 100));
    assert.equal(downloaded.headers.get("content-type"), "application/zip");
    assert.equal(downloaded.headers.get("cache-control"), "private, no-store");
    assert.equal(downloaded.headers.get("x-content-type-options"), "nosniff");
    const setup = setupFromZip(downloaded.bodyBuffer);
    assert.equal(setup.product, "cal-eats"); assert.equal(setup.printerId, p.printer.id); assert.equal(setup.restaurantId, p.restaurant.id);
    assert.equal(Object.hasOwn(setup, "token"), false);
    const row = f.db.prepare("SELECT * FROM printer_pairing_codes WHERE printer_id=?").get(p.printer.id);
    assert.equal(row.code_hash, hash(setup.code)); assert.equal(row.consumed_at, null); assert.equal(row.expires_at, setup.expiresAt);
    assert.equal(JSON.stringify(row).includes(setup.code), false);
    assert.equal(JSON.stringify(f.db.prepare("SELECT * FROM audit_events WHERE entity_id=?").all(p.printer.id)).includes(setup.code), false);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM printer_devices").get().n, 0);
    const disabled = await f.json(`${p.root}/printers/${p.printer.id}`, { method: "PATCH", cookie: p.owner, body: { enabled: false } });
    assert.equal(disabled.status, 200);
    assert.equal((await f.request(p.setupPath, { method: "POST", cookie: p.owner, body: {} })).status, 404);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM printer_pairing_codes").get().n, 1);
  } finally { await f.close(); }
});

test("consumed setup retries recover exactly the same generated credential after a lost response and reject other tokens", async () => {
  let now = Date.parse("2026-01-01T01:00:00Z");
  const f = await journeyFixture({ now: () => new Date(now) });
  try {
    const p = await printerFixture(f), downloaded = await f.request(p.setupPath, { method: "POST", cookie: p.owner, body: {} });
    const setup = setupFromZip(downloaded.bodyBuffer), token = randomBytes(32).toString("base64url"), body = { code: setup.code, name: "Windows kitchen", clientToken: token };
    const paired = await f.json("/api/devices/pair", { method: "POST", body });
    assert.equal(paired.status, 201, paired.text); assert.equal(paired.body.data.token, token);
    assert.equal(paired.body.data.printerId, p.printer.id); assert.equal(paired.body.data.restaurantId, p.restaurant.id);
    const row = f.db.prepare("SELECT * FROM printer_devices WHERE id=?").get(paired.body.data.deviceId);
    assert.equal(row.token_hash, hash(token)); assert.equal(JSON.stringify(row).includes(token), false);
    now += 8 * 86400000;
    const replay = await f.json("/api/devices/pair", { method: "POST", body });
    assert.equal(replay.status, 201, replay.text); assert.deepEqual(replay.body.data, paired.body.data);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM printer_devices").get().n, 1);
    assert.equal((await f.json("/api/devices/pair", { method: "POST", body: { ...body, clientToken: randomBytes(32).toString("base64url") } })).status, 401);
    assert.equal((await f.json("/api/devices/pair", { method: "POST", body: { code: setup.code, name: "Legacy retry" } })).status, 401);
    f.db.prepare("UPDATE printer_devices SET revoked_at=? WHERE id=?").run(f.config.now().toISOString(), paired.body.data.deviceId);
    assert.equal((await f.json("/api/devices/pair", { method: "POST", body })).status, 401);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM printer_devices").get().n, 1);
  } finally { await f.close(); }
});

test("unconsumed expired setup cannot pair and heartbeat distinguishes network reachability from a computer heartbeat", async () => {
  let now = Date.parse("2026-01-01T01:00:00Z");
  const f = await journeyFixture({ now: () => new Date(now) });
  try {
    const p = await printerFixture(f);
    let downloaded = await f.request(p.setupPath, { method: "POST", cookie: p.owner, body: {} }), setup = setupFromZip(downloaded.bodyBuffer);
    now += 8 * 86400000;
    assert.equal((await f.json("/api/devices/pair", { method: "POST", body: { code: setup.code, name: "Expired setup", clientToken: randomBytes(32).toString("base64url") } })).status, 401);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM printer_devices").get().n, 0);
    p.owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310");
    downloaded = await f.request(p.setupPath, { method: "POST", cookie: p.owner, body: {} }); setup = setupFromZip(downloaded.bodyBuffer);
    const paired = await f.json("/api/devices/pair", { method: "POST", body: { code: setup.code, name: "Working device", clientToken: randomBytes(32).toString("base64url") } });
    assert.equal(paired.status, 201, paired.text);
    const headers = { authorization: `Bearer ${paired.body.data.token}` };
    const state = async () => (await f.json(`${p.root}/printers`, { cookie: p.owner })).body.data.items.find((printer) => printer.id === p.printer.id);
    assert.equal((await state()).status, "offline");
    await f.json("/api/devices/heartbeat", { method: "POST", headers, body: {} });
    assert.equal((await state()).status, "connection_unverified");
    await f.json("/api/devices/heartbeat", { method: "POST", headers, body: { printerReachable: false, transport: "tcp-escpos" } });
    assert.equal((await state()).status, "printer_offline"); assert.equal((await state()).printerReachable, false);
    assert.equal((await f.json("/api/devices/jobs/claim", { method: "POST", headers, body: {} })).body.data.job, null);
    assert.equal((await f.json("/api/devices/heartbeat", { method: "POST", headers, body: { printerReachable: true } })).status, 400);
    assert.equal((await f.json("/api/devices/heartbeat", { method: "POST", headers, body: { printerReachable: true, transport: "invalid" } })).status, 400);
    await f.json("/api/devices/heartbeat", { method: "POST", headers, body: { printerReachable: true, transport: "tcp-escpos" } });
    assert.equal((await state()).status, "online"); assert.equal((await state()).printerReachable, true);
    const visible = JSON.stringify(await state()); assert.equal(visible.includes(paired.body.data.token), false); assert.equal(visible.includes("token_hash"), false);
    now += 60001; assert.equal((await state()).status, "offline");
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { await f.close(); }
});

test("upgrading the pre-reachability schema preserves an existing paired printer and adds nullable health fields", async () => {
  const db = openDatabase(":memory:");
  const stamp = "2026-01-01T00:00:00Z";
  try {
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)");
    for (const migration of migrations.filter((row) => row.version < 60)) {
      if (migration.foreignKeysOff) db.exec("PRAGMA foreign_keys=OFF");
      db.exec("BEGIN IMMEDIATE"); db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(migration.version, migration.name, stamp);
      db.exec("COMMIT");
      if (migration.foreignKeysOff) db.exec("PRAGMA foreign_keys=ON");
    }
    await seedDemoData(db, new Date(stamp));
    const restaurantId = db.prepare("SELECT id FROM restaurants ORDER BY id LIMIT 1").get().id, printerId = randomUUID(), deviceId = randomUUID(), tokenHash = hash("existing-device-secret");
    db.prepare("INSERT INTO restaurant_printers(id,restaurant_id,name,enabled,created_at,updated_at,ip_address) VALUES(?,?,?,1,?,?,?)").run(printerId, restaurantId, "Existing kitchen", stamp, stamp, "192.0.2.26");
    db.prepare("INSERT INTO printer_devices(id,printer_id,restaurant_id,name,token_hash,revoked_at,last_seen_at,created_at) VALUES(?,?,?,?,?,?,?,?)").run(deviceId, printerId, restaurantId, "Existing tablet", tokenHash, null, stamp, stamp);
    migrateDatabase(db);
    const device = db.prepare("SELECT * FROM printer_devices WHERE id=?").get(deviceId);
    assert.equal(device.printer_id, printerId); assert.equal(device.restaurant_id, restaurantId); assert.equal(device.token_hash, tokenHash); assert.equal(device.last_seen_at, stamp);
    assert.equal(device.printer_reachable, null); assert.equal(device.printer_checked_at, null); assert.equal(device.printer_transport, null);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM printer_test_jobs").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM printer_test_job_claim_tokens").get().n, 0);
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    migrateDatabase(db);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM printer_devices WHERE id=?").get(deviceId).n, 1);
  } finally { db.close(); }
});
