import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase, migrateDatabase, closeDatabase } from "../src/db/index.js";
import { discoverRestaurants } from "../src/restaurant-discovery.js";
import { DIRECTORY_NOW, directoryId, seedDirectoryFixture } from "../../../scripts/load-restaurant-directory.js";

function fixture() {
  const db = openDatabase(":memory:"); migrateDatabase(db);
  seedDirectoryFixture(db, { restaurants: 120, menuItemsPerRestaurant: 3, historyPerRestaurant: 5 });
  return db;
}
function query(db, suffix, customerId = null) {
  let statements = 0;
  const observed = { prepare(sql) {
    const prepared = db.prepare(sql);
    return { all(...args) { statements++; return prepared.all(...args); }, get(...args) { statements++; return prepared.get(...args); } };
  } };
  return { ...discoverRestaurants(observed, new URL(`http://127.0.0.1/api/restaurants?${suffix}`), DIRECTORY_NOW, customerId), statements };
}

test("discovery hydrates a bounded page with fixed query count, including the final and empty pages", () => {
  const db = fixture();
  try {
    for (const size of [1, 50, 100]) {
      const page = query(db, `pageSize=${size}`);
      assert.equal(page.rows.length, size);
      assert.equal(page.statements, 4, "Hydration must not execute one statement per restaurant");
      assert.equal(page.pagination.hasNext, true);
    }
    const final = query(db, "page=3&pageSize=50");
    assert.equal(final.rows.length, 20); assert.equal(final.statements, 4); assert.equal(final.pagination.hasNext, false);
    const empty = query(db, "page=4&pageSize=50");
    assert.equal(empty.rows.length, 0); assert.equal(empty.statements, 1);
    for (const consent of [0, 1]) {
      db.prepare("UPDATE users SET merchant_offers=? WHERE id='directory-customer'").run(consent);
      const signedIn = query(db, "pageSize=50", "directory-customer");
      assert.equal(signedIn.rows.length, 50); assert.equal(signedIn.statements, 5, "Signed-in discovery adds only one consent check");
      assert.ok(signedIn.rows.every(row => row.available_offer_id === null));
    }
  } finally { closeDatabase(db); }
});

test("batched ratings, menu terms and recent popularity remain tenant scoped and ranking precedes the page limit", () => {
  const db = fixture();
  try {
    db.prepare("DELETE FROM restaurant_order_ratings WHERE restaurant_id=?").run(directoryId(0));
    db.prepare("UPDATE menu_items SET available=0,name='Hidden menu keyword' WHERE id=?").run(`${directoryId(0)}-item-0`);
    const first = query(db, "pageSize=2");
    assert.equal(first.rows[0].rating_count, 0); assert.equal(first.rows[0].rating_average, null);
    assert.equal(first.rows[0].completed_order_count_30d, 1, "Old synthetic orders must not enter the last thirty days");
    assert.equal(first.rows[1].completed_order_count_30d, 2);
    assert.equal(first.rows[1].rating_count, 2); assert.equal(first.rows[1].rating_average, 2.5);
    assert.ok(!first.rows[0].search_terms.includes("Hidden menu keyword"));
    assert.ok(first.rows[1].search_terms.includes("Synthetic dish 0"));
    const popular = query(db, "collection=popular&pageSize=2");
    assert.deepEqual(popular.rows.map(row => row.id), [directoryId(4), directoryId(9)]);
    assert.deepEqual(popular.rows.map(row => row.completed_order_count_30d), [5, 5]);
    assert.equal(popular.statements, 3);
    const rare = query(db, "q=rare%20capers&pageSize=1");
    assert.deepEqual(rare.rows.map(row => row.id), [directoryId(119)]);
    assert.ok(rare.rows[0].search_terms.includes("Rare capers finale"));
  } finally { closeDatabase(db); }
});
