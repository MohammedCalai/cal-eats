import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { journeyFixture } from "./helpers.js";
import { mediaSha256, runMediaObjectCleanup } from "../src/media-object-store.js";
import { mediaStorage, RESTAURANT_MEDIA_LIMIT_BYTES } from "../src/media-policy.js";
import { mediaRelocationPlan, relocateInlineMedia } from "../../../scripts/migrate-media-to-objects.js";

const image = { mimeType: "image/png", dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII=" };
const bytes = Buffer.from(image.dataBase64, "base64");

function memoryStore() {
  const objects = new Map();
  let writes = 0;
  return {
    backendId: "private-test-bucket",
    objects,
    get writes() { return writes; },
    async put({ key, bytes, sha256 }) {
      assert.equal(objects.has(key), false);
      assert.equal(mediaSha256(bytes), sha256);
      const versionId = randomUUID();
      objects.set(key, { versionId, bytes: Buffer.from(bytes) });
      writes++;
      return { versionId };
    },
    async read({ key, versionId }) {
      const object = objects.get(key);
      assert.equal(object.versionId, versionId);
      return object.bytes;
    },
    async remove(key) { objects.delete(key); }
  };
}

async function inlineCover(f, restaurantName, email, password) {
  const restaurantId = f.db.prepare("SELECT id FROM restaurants WHERE name=?").get(restaurantName).id;
  const route = `/api/restaurant/restaurants/${restaurantId}/cover`;
  const cookie = await f.login(email, password);
  const created = await f.json(route, { method: "POST", cookie, body: image });
  assert.equal(created.status, 201, created.text);
  return { ...created.body.data, route, restaurantId, cookie };
}

test("relocation preserves public and private URLs, references and exact charged bytes across batches and repeats", async () => {
  const f = await journeyFixture({ mediaObjectStore: null });
  try {
    const publicCover = await inlineCover(f, "Calai Kitchen", "restaurant@calai.local", "LocalRestaurant!4310");
    const privateCover = await inlineCover(f, "Second Spoon", "restaurant2@calai.local", "LocalRestaurant2!4310");
    assert.equal((await f.request(privateCover.url)).status, 404);
    const store = memoryStore();
    f.config.mediaObjectStore = store;
    assert.equal(mediaRelocationPlan(f.db).inlineImages, 2);

    const first = await relocateInlineMedia(f.db, store, { limit: 1 });
    assert.equal(first.relocated, 1);
    assert.equal(first.relocatedBytes, bytes.length);
    assert.equal(first.inlineImages, 1);
    assert.equal(first.externalImages, 1);
    assert.deepEqual(first.failures, {});
    const second = await relocateInlineMedia(f.db, store);
    assert.equal(second.relocated, 1);
    assert.equal(second.inlineImages, 0);
    assert.equal(second.externalImages, 2);
    const rerun = await relocateInlineMedia(f.db, store);
    assert.equal(rerun.relocated, 0);
    assert.equal(store.writes, 2);

    for (const cover of [publicCover, privateCover]) {
      const row = f.db.prepare("SELECT m.data,m.byte_length,o.object_key,o.restaurant_id FROM media_assets m JOIN media_asset_objects o ON o.media_id=m.id WHERE m.id=?").get(cover.id);
      assert.equal(row.data.length, 0);
      assert.equal(row.byte_length, bytes.length);
      assert.equal(row.restaurant_id, cover.restaurantId);
      assert.ok(row.object_key.startsWith(`restaurants/${cover.restaurantId}/`));
      assert.equal(f.db.prepare("SELECT cover_media_id FROM restaurants WHERE id=?").get(cover.restaurantId).cover_media_id, cover.id);
      assert.deepEqual(mediaStorage(f.db, cover.restaurantId), {
        usedBytes: bytes.length, limitBytes: 100_000_000, remainingBytes: RESTAURANT_MEDIA_LIMIT_BYTES - bytes.length
      });
      const served = await f.request(cover.url, { cookie: cover.cookie });
      assert.equal(served.status, 200);
      assert.deepEqual(served.bodyBuffer, bytes);
      assert.equal(served.headers.get("content-length"), bytes.length);
      assert.equal(served.headers.get("cache-control"), "no-store");
    }
    assert.equal((await f.request(publicCover.url)).status, 200);
    assert.equal((await f.request(privateCover.url, { cookie: publicCover.cookie })).status, 404);
    assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { await f.close(); }
});

test("ambiguous saves and bad readback retain SQLite bytes, with only abandoned keys cleaned after retry", async () => {
  const f = await journeyFixture({ mediaObjectStore: null });
  try {
    const cover = await inlineCover(f, "Calai Kitchen", "restaurant@calai.local", "LocalRestaurant!4310");
    const store = memoryStore();
    f.config.mediaObjectStore = store;
    const put = store.put;
    const read = store.read;
    store.put = async input => { await put(input); throw Error("private provider failure"); };
    const ambiguous = await relocateInlineMedia(f.db, store);
    assert.deepEqual(ambiguous.failures, { object_verification_failed: 1 });
    assert.equal(ambiguous.inlineImages, 1);
    store.put = put;
    store.read = async () => Buffer.alloc(bytes.length);
    const corrupt = await relocateInlineMedia(f.db, store);
    assert.deepEqual(corrupt.failures, { object_verification_failed: 1 });
    assert.equal(corrupt.inlineImages, 1);
    assert.deepEqual((await f.request(cover.url)).bodyBuffer, bytes);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM media_object_cleanup").get().count, 2);

    store.read = read;
    assert.equal((await relocateInlineMedia(f.db, store)).relocated, 1);
    const key = f.db.prepare("SELECT object_key FROM media_asset_objects WHERE media_id=?").get(cover.id).object_key;
    f.db.prepare("UPDATE media_object_cleanup SET available_at='2025-01-01T00:00:00.000Z'").run();
    assert.equal((await runMediaObjectCleanup(f.db, f.config)).removed, 2);
    assert.deepEqual([...store.objects.keys()], [key]);
    assert.deepEqual((await f.request(cover.url)).bodyBuffer, bytes);
    await assert.rejects(relocateInlineMedia(f.db, { ...store, backendId: "different-bucket" }), /requires review/);
  } finally { await f.close(); }
});

test("a concurrent relocation binds the image once and a concurrent removal is not resurrected", async () => {
  const f = await journeyFixture({ mediaObjectStore: null });
  try {
    const first = await inlineCover(f, "Calai Kitchen", "restaurant@calai.local", "LocalRestaurant!4310");
    const store = memoryStore();
    f.config.mediaObjectStore = store;
    const reports = await Promise.all([relocateInlineMedia(f.db, store), relocateInlineMedia(f.db, store)]);
    assert.equal(reports.reduce((sum, report) => sum + report.relocated, 0), 1);
    assert.equal(reports.reduce((sum, report) => sum + report.alreadyChanged, 0), 1);
    assert.deepEqual((await f.request(first.url)).bodyBuffer, bytes);

    f.config.mediaObjectStore = null;
    const second = await inlineCover(f, "Second Spoon", "restaurant2@calai.local", "LocalRestaurant2!4310");
    f.config.mediaObjectStore = store;
    const put = store.put;
    store.put = async input => {
      const saved = await put(input);
      assert.equal((await f.json(second.route, { method: "DELETE", cookie: second.cookie })).status, 200);
      return saved;
    };
    const removed = await relocateInlineMedia(f.db, store);
    assert.equal(removed.alreadyChanged, 1);
    assert.equal(removed.relocated, 0);
    assert.equal(removed.totalImages, 1);
    assert.equal(f.db.prepare("SELECT 1 FROM media_assets WHERE id=?").get(second.id), undefined);
    assert.equal((await f.request(second.url, { cookie: second.cookie })).status, 404);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM media_object_cleanup").get().count, 2);
  } finally { await f.close(); }
});

test("operator planning mode opens an existing database read-only and needs no storage configuration", async () => {
  const f = await journeyFixture({ mediaObjectStore: null });
  try {
    const cover = await inlineCover(f, "Calai Kitchen", "restaurant@calai.local", "LocalRestaurant!4310");
    const script = fileURLToPath(new URL("../../../scripts/migrate-media-to-objects.js", import.meta.url));
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, CALAI_MEDIA_STORAGE: "database" } });
    const plan = run("--plan", "--db", f.config.dbPath);
    assert.equal(plan.status, 0, plan.stderr);
    assert.equal(JSON.parse(plan.stdout).inlineImages, 1);
    assert.equal(run("--apply", "--db", f.config.dbPath).status, 1);
    assert.equal(run("--apply", "--db", f.config.dbPath, "--limit", "101").status, 1);
    assert.deepEqual((await f.request(cover.url)).bodyBuffer, bytes);
    assert.equal(mediaRelocationPlan(f.db).externalImages, 0);
  } finally { await f.close(); }
});
