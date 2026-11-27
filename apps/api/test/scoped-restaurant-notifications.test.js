import assert from "node:assert/strict";
import test from "node:test";
import { journeyFixture } from "./helpers.js";
import { addNotification } from "../src/offers.js";

test("Both notification history and unread counts follow the selected restaurant for a multi-location owner", async () => {
  const fixture = await journeyFixture();
  try {
    const owner = await fixture.login("restaurant@calai.local", "LocalRestaurant!4310");
    const otherOwner = await fixture.login("restaurant2@calai.local", "LocalRestaurant2!4310");
    const ownerId = fixture.db.prepare("SELECT id FROM users WHERE email=?").get("restaurant@calai.local").id;
    const first = (await fixture.json("/api/restaurant/restaurants", { cookie: owner })).body.data[0].id;
    const second = (await fixture.json("/api/restaurant/restaurants", { cookie: otherOwner })).body.data[0].id;
    const list = (session, restaurantId) => fixture.json("/api/notifications?restaurantId=" + restaurantId, { cookie: session });
    assert.equal((await list(owner, second)).status, 404);
    fixture.db.prepare("INSERT INTO restaurant_memberships(restaurant_id,user_id,permission,created_at) VALUES(?,?,'owner',?)").run(second, ownerId, new Date().toISOString());
    for (const restaurantId of [first, second]) {
      addNotification(fixture.db, { userId: ownerId, restaurantId, type: "new_order", title: "Order",
        message: "A new order was placed", eventKey: "scope-" + restaurantId, now: new Date().toISOString() });
    }
    for (const restaurantId of [first, second]) {
      const response = await list(owner, restaurantId);
      assert.equal(response.status, 200, response.text);
      const { items, unreadCount } = response.body.data;
      assert.ok(items.length > 0);
      assert.ok(items.every(item => item.restaurantId === restaurantId));
      assert.equal(unreadCount, items.filter(item => !item.readAt).length);
      assert.ok(items.some(item => item.title === "Order"));
    }
    const all = await fixture.json("/api/notifications", { cookie: owner });
    assert.deepEqual(new Set(all.body.data.items.map(item => item.restaurantId)),new Set([first, second]));
  } finally {
    await fixture.close();
  }
});
