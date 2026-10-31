import assert from "node:assert/strict";
import test from "node:test";
import { journeyFixture } from "./helpers.js";
import { assertMediaCapacity, RESTAURANT_MEDIA_LIMIT_BYTES } from "../src/media-policy.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII=";
const image = { mimeType: "image/png", dataBase64: png };

test("100 MB allowance accepts the exact boundary and reclaims only replaced bytes", () => {
  assert.equal(RESTAURANT_MEDIA_LIMIT_BYTES, 100_000_000);
  assert.doesNotThrow(() => assertMediaCapacity(99_000_000, 1_000_000));
  assert.doesNotThrow(() => assertMediaCapacity(100_000_000, 1_000_000, 1_000_000));
  assert.throws(() => assertMediaCapacity(100_000_000, 1), { code: "MEDIA_LIMIT", status: 409 });
});

test("media quota is tenant scoped, replacement is atomic, and removal releases bytes", async () => {
  const f = await journeyFixture();
  try {
    const owner = await f.login("restaurant@calai.local", "LocalRestaurant!4310");
    const other = await f.login("restaurant2@calai.local", "LocalRestaurant2!4310");
    const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0];
    const second = (await f.json("/api/restaurant/restaurants", { cookie: other })).body.data[0];
    const cover = `/api/restaurant/restaurants/${restaurant.id}/cover`;
    const photo = `/api/restaurant/restaurants/${restaurant.id}/menu/${(await f.json(`/api/restaurant/restaurants/${restaurant.id}/menu`, { cookie: owner })).body.data.items[0].id}/photo`;
    const upload = () => f.json(cover, { method: "POST", cookie: owner, body: image });
    const initial = await upload();
    assert.equal(initial.status, 201, initial.text);
    assert.equal(initial.body.data.storage.usedBytes, Buffer.from(png, "base64").length);
    assert.equal((await f.json(cover, { method: "POST", cookie: other, body: image })).status, 404);
    // Model a pre-existing full library via metadata, without allocating 100 MB in this focused test.
    f.db.prepare("INSERT INTO media_assets VALUES(?,?,?,X'00',1,1,?,?)").run("quota-fixture", restaurant.id, "image/png", 100_000_000 - initial.body.data.storage.usedBytes, "2026-01-01T00:00:00.000Z");
    const replacement = await upload();
    assert.equal(replacement.status, 201, replacement.text);
    assert.equal(replacement.body.data.storage.remainingBytes, 0);
    assert.equal(f.db.prepare("SELECT id FROM media_assets WHERE id=?").get(initial.body.data.id), undefined);
    const rejected = await f.json(photo, { method: "POST", cookie: owner, body: image });
    assert.equal(rejected.body.error.code, "MEDIA_LIMIT");
    assert.equal(f.db.prepare("SELECT cover_media_id FROM restaurants WHERE id=?").get(restaurant.id).cover_media_id, replacement.body.data.id);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM media_assets WHERE restaurant_id=?").get(restaurant.id).n, 2);
    const separate = await f.json(`/api/restaurant/restaurants/${second.id}/cover`, { method: "POST", cookie: other, body: image });
    assert.equal(separate.status, 201, separate.text);
    assert.equal(separate.body.data.storage.usedBytes, initial.body.data.storage.usedBytes);
    const removed = await f.json(cover, { method: "DELETE", cookie: owner });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.data.storage.remainingBytes, initial.body.data.storage.usedBytes);
    assert.equal((await f.json(photo, { method: "POST", cookie: owner, body: image })).status, 201);
    assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { await f.close(); }
});

test("discovery filters before bounded stable pagination and finds matches beyond the first page", async () => {
  const f = await journeyFixture();
  try {
    const insert = f.db.prepare("INSERT INTO restaurants(id,name,status,created_at,cuisine,collection_enabled,delivery_enabled,delivery_outcodes) VALUES(?,?,'approved',?,'Scaling',1,1,'[\"LU1\"]')");
    for (let index = 0; index < 111; index++) insert.run(`scale-${String(index).padStart(3, "0")}`, "Same restaurant name", "2026-01-01T00:00:00.000Z");
    f.db.prepare("INSERT INTO menu_items(id,restaurant_id,name,description,price_minor,available,created_at,updated_at) VALUES('rare-item','scale-110','Rare caper platter','',100,1,?,?)").run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    const first = await f.json("/api/restaurants?cuisine=Scaling");
    assert.equal(first.body.data.length, 50);
    assert.deepEqual(first.body.pagination, { page: 1, pageSize: 50, hasNext: true, hasPrevious: false });
    const second = await f.json("/api/restaurants?cuisine=Scaling&page=2");
    const third = await f.json("/api/restaurants?cuisine=Scaling&page=3");
    const ids = [...first.body.data, ...second.body.data, ...third.body.data].map(row => row.id);
    assert.equal(new Set(ids).size, 111);
    assert.deepEqual(ids, [...ids].sort());
    assert.equal(third.body.pagination.hasNext, false);
    const searched = await f.json("/api/restaurants?q=rare%20caper&fulfillment=delivery&postcode=LU1%201AA&pageSize=1");
    assert.deepEqual(searched.body.data.map(row => row.id), ["scale-110"]);
    assert.equal((await f.json("/api/restaurants?q=rare%20caper&fulfillment=delivery&postcode=N1%201AA")).body.data.length, 0);
    for (const query of ["page=0", "pageSize=101", "pageSize=1.5"]) assert.equal((await f.json(`/api/restaurants?${query}`)).status, 400);
  } finally { await f.close(); }
});
