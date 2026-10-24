import assert from "node:assert/strict";
import test from "node:test";
import { journeyFixture } from "./helpers.js";

const accounts = {
  admin: ["admin@calai.local", "LocalAdmin!4310"],
  owner1: ["restaurant@calai.local", "LocalRestaurant!4310"],
  owner2: ["restaurant2@calai.local", "LocalRestaurant2!4310"],
  customer: ["customer@calai.local", "LocalCustomer!4310"]
};

async function cookies(f) {
  return { admin: await f.login(...accounts.admin), owner1: await f.login(...accounts.owner1), owner2: await f.login(...accounts.owner2), customer: await f.login(...accounts.customer) };
}

test("pending restaurant approval through delivery lifecycle preserves snapshots and recognizes one commission", async () => {
  const f = await journeyFixture();
  try {
    const c = await cookies(f);
    const owned = await f.json("/api/restaurant/restaurants", { cookie: c.owner2 });
    const restaurant = owned.body.data[0];
    assert.equal(restaurant.status, "pending");
    const added = await f.json(`/api/restaurant/restaurants/${restaurant.id}/menu`, { method: "POST", cookie: c.owner2, body: { name: "<script>special</script>", description: "fresh & hot", priceMinor: 1200 } });
    assert.equal(added.status, 201);
    const item = added.body.data;
    const configured = await f.json(`/api/restaurant/restaurants/${restaurant.id}/delivery`, { method: "PATCH", cookie: c.owner2, body: { enabled: true, outcodes: ["n1", "N2", "N1"], deliveryFeeMinor: 250, minDeliverySubtotalMinor: 1000 } });
    assert.deepEqual(configured.body.data.delivery.outcodes, ["N1", "N2"]);
    await f.json(`/api/restaurant/restaurants/${restaurant.id}/profile`, { method: "PATCH", cookie: c.owner2, body: { phone: "07000000000" } });
    const approved = await f.json(`/api/admin/restaurants/${restaurant.id}/approval`, { method: "PATCH", cookie: c.admin, body: { status: "approved" } });
    assert.equal(approved.body.data.status, "approved");
    const orderBody = { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 2 }], paymentMethod: "mock_card", fulfillment: "delivery", deliveryAddress: { line1: "1 <Main>", city: "London", postcode: "N1 1AA" } };
    const headers = { "Idempotency-Key": "delivery-1" };
    const created = await f.json("/api/orders", { method: "POST", cookie: c.customer, headers, body: orderBody });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.subtotalMinor, 2400);
    assert.equal(created.body.data.deliveryFeeMinor, 250);
    assert.equal(created.body.data.totalMinor, 2650);
    assert.equal(created.body.data.commissionMinor, 168);
    assert.equal(created.body.data.paymentStatus, "mock_authorized");
    const id = created.body.data.id;
    assert.equal((await f.json("/api/orders", { method: "POST", cookie: c.customer, headers, body: orderBody })).status, 200);
    assert.equal((await f.json("/api/orders", { method: "POST", cookie: c.customer, headers, body: { ...orderBody, paymentMethod: "cash" } })).status, 409);
    await f.json(`/api/restaurant/restaurants/${restaurant.id}/menu/${item.id}`, { method: "PATCH", cookie: c.owner2, body: { name: "Changed", priceMinor: 9999 } });
    await f.json(`/api/restaurant/restaurants/${restaurant.id}/delivery`, { method: "PATCH", cookie: c.owner2, body: { enabled: true, outcodes: ["N2"], deliveryFeeMinor: 999, minDeliverySubtotalMinor: 5000 } });
    await f.json(`/api/admin/restaurants/${restaurant.id}/approval`, { method: "PATCH", cookie: c.admin, body: { status: "rejected" } });
    assert.equal((await f.json(`/api/restaurant/orders/${id}/status`, { method: "PATCH", cookie: c.owner2, body: { status: "accepted" } })).body.error.code, "RESTAURANT_UNAVAILABLE");
    await f.json(`/api/admin/restaurants/${restaurant.id}/approval`, { method: "PATCH", cookie: c.admin, body: { status: "approved" } });
    const accepted = await f.json(`/api/restaurant/orders/${id}/status`, { method: "PATCH", cookie: c.owner2, body: { status: "accepted" } });
    assert.equal(accepted.body.data.paymentStatus, "mock_captured");
    assert.equal(accepted.body.data.ledger[0].kind, "commission_mock");
    assert.equal((await f.json(`/api/restaurant/orders/${id}/status`, { method: "PATCH", cookie: c.owner2, body: { status: "accepted" } })).body.data.ledger.length, 1);
    for (const status of ["preparing", "ready", "out_for_delivery", "completed"]) assert.equal((await f.json(`/api/restaurant/orders/${id}/status`, { method: "PATCH", cookie: c.owner2, body: { status } })).status, 200);
    const detail = await f.json(`/api/orders/${id}`, { cookie: c.customer });
    assert.equal(detail.body.data.items[0].name, "<script>special</script>");
    assert.equal(detail.body.data.items[0].unitPriceMinor, 1200);
    assert.equal(detail.body.data.deliveryFeeMinor, 250);
    assert.equal("ledger" in detail.body.data, false);
    assert.equal((await f.json("/api/admin/ledger", { cookie: c.admin })).body.data.length, 1);
    const receipt = await f.request(`/api/orders/${id}/receipt`, { cookie: c.customer });
    assert.equal(receipt.status, 200);
    assert.match(receipt.headers.get("content-security-policy"), /style-src 'unsafe-inline'/);
    assert.match(receipt.text, /&lt;script&gt;special&lt;\/script&gt;/);
    assert.match(receipt.text, /1 &lt;Main&gt;/);
    assert.doesNotMatch(receipt.text, /<script>special/);
    assert.match(receipt.text, /Mock card — no real payment processed/);
  } finally { await f.close(); }
});

test("tenant/customer isolation and delivery eligibility reject unsafe orders", async () => {
  const f = await journeyFixture();
  try {
    const c = await cookies(f);
    const r1 = (await f.json("/api/restaurant/restaurants", { cookie: c.owner1 })).body.data[0];
    const r2 = (await f.json("/api/restaurant/restaurants", { cookie: c.owner2 })).body.data[0];
    assert.equal((await f.json(`/api/restaurant/restaurants/${r2.id}/menu`, { cookie: c.owner1 })).status, 404);
    const menu = await f.json(`/api/restaurants/${r1.id}/menu`);
    const item = menu.body.data.items.find((entry) => entry.priceMinor >= 1000);
    const base = { restaurantId: r1.id, items: [{ menuItemId: item.id, quantity: 1 }], paymentMethod: "cash", fulfillment: "delivery" };
    const place = (suffix, body) => f.json("/api/orders", { method: "POST", cookie: c.customer, headers: { "Idempotency-Key": suffix }, body });
    assert.equal((await place("bad-post", { ...base, deliveryAddress: { line1: "1 Road", city: "London", postcode: "bad" } })).status, 400);
    assert.equal((await place("n10", { ...base, deliveryAddress: { line1: "1 Road", city: "London", postcode: "N10 1AA" } })).body.error.code, "DELIVERY_OUTSIDE_AREA");
    assert.equal((await place("tamper", { ...base, subtotalMinor: 1, deliveryAddress: { line1: "1 Road", city: "London", postcode: "N1 1AA" } })).status, 400);
    assert.equal((await place("collection-address", { ...base, fulfillment: "collection", deliveryAddress: { line1: "1 Road", city: "London", postcode: "N1 1AA" } })).status, 400);
    await f.json(`/api/restaurant/restaurants/${r1.id}/delivery`, { method: "PATCH", cookie: c.owner1, body: { enabled: true, outcodes: ["N1"], deliveryFeeMinor: 250, minDeliverySubtotalMinor: 5000 } });
    assert.equal((await place("minimum", { ...base, deliveryAddress: { line1: "1 Road", city: "London", postcode: "N1 1AA" } })).body.error.code, "DELIVERY_MINIMUM");
    await f.json(`/api/restaurant/restaurants/${r1.id}/delivery`, { method: "PATCH", cookie: c.owner1, body: { enabled: false, outcodes: ["N1"], deliveryFeeMinor: 250, minDeliverySubtotalMinor: 0 } });
    assert.equal((await place("disabled", { ...base, deliveryAddress: { line1: "1 Road", city: "London", postcode: "N1 1AA" } })).body.error.code, "DELIVERY_DISABLED");
    const disabledItem = menu.body.data.items[0];
    await f.json(`/api/restaurant/restaurants/${r1.id}/menu/${disabledItem.id}`, { method: "PATCH", cookie: c.owner1, body: { available: false } });
    const unavailable = await place("unavailable", { ...base, fulfillment: "collection", items: [{ menuItemId: disabledItem.id, quantity: 1 }] });
    assert.equal(unavailable.body.error.code, "MENU_UNAVAILABLE");
    assert.equal((await place("unapproved", { ...base, restaurantId: r2.id, fulfillment: "collection" })).status, 404);
  } finally { await f.close(); }
});

test("cash collection lifecycle has separate receivable and forbids invalid transitions", async () => {
  const f = await journeyFixture();
  try {
    const c = await cookies(f);
    const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: c.owner1 })).body.data[0];
    const item = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
    await Promise.all([
      f.json(`/api/restaurant/restaurants/${restaurant.id}/menu/${item.id}`, { method: "PATCH", cookie: c.owner1, body: { name: "Concurrently renamed" } }),
      f.json(`/api/restaurant/restaurants/${restaurant.id}/menu/${item.id}`, { method: "PATCH", cookie: c.owner1, body: { description: "Concurrently described" } })
    ]);
    const refreshedItem = (await f.json(`/api/restaurant/restaurants/${restaurant.id}/menu`, { cookie: c.owner1 })).body.data.items.find((entry) => entry.id === item.id);
    assert.equal(refreshedItem.name, "Concurrently renamed");
    assert.equal(refreshedItem.description, "Concurrently described");
    const created = await f.json("/api/orders", { method: "POST", cookie: c.customer, headers: { "Idempotency-Key": "cash-1" }, body: { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], paymentMethod: "cash", fulfillment: "collection" } });
    const id = created.body.data.id;
    assert.equal(created.body.data.paymentStatus, "cash_due");
    const second = await f.json("/api/auth/register", { method: "POST", body: { name: "Other Customer", email: "other@example.test", password: "another long passphrase" } });
    const secondCookie = second.headers.get("set-cookie").split(";", 1)[0];
    assert.equal((await f.json(`/api/orders/${id}`, { cookie: secondCookie })).status, 404);
    assert.equal((await f.json(`/api/restaurant/orders/${id}/status`, { method: "PATCH", cookie: c.owner1, body: { status: "completed" } })).status, 409);
    assert.equal((await f.json(`/api/restaurant/orders/${id}/status`, { method: "PATCH", cookie: c.owner2, body: { status: "accepted" } })).status, 404);
    for (const status of ["accepted", "preparing", "ready", "completed"]) {
      const response = await f.json(`/api/restaurant/orders/${id}/status`, { method: "PATCH", cookie: c.owner1, body: { status } });
      assert.equal(response.status, 200);
      if (status === "accepted") assert.equal(response.body.data.ledger[0].kind, "commission_cash_receivable");
      if (status === "completed") assert.equal(response.body.data.paymentStatus, "cash_collected");
    }
    const receipt = await f.request(`/api/orders/${id}/receipt`, { cookie: c.owner1 });
    assert.match(receipt.text, /Cash — paid directly to restaurant/);
  } finally { await f.close(); }
});

test("concurrent acceptance and competing decisions use current transactional state", async () => {
  const f = await journeyFixture();
  try {
    const c = await cookies(f);
    const restaurant = (await f.json("/api/restaurant/restaurants", { cookie: c.owner1 })).body.data[0];
    const item = (await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0];
    const make = async (key) => (await f.json("/api/orders", { method: "POST", cookie: c.customer, headers: { "Idempotency-Key": key }, body: { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], paymentMethod: "mock_card", fulfillment: "collection" } })).body.data.id;
    const first = await make("concurrent-accept");
    const accept = () => f.json(`/api/restaurant/orders/${first}/status`, { method: "PATCH", cookie: c.owner1, body: { status: "accepted" } });
    const duplicateResults = await Promise.all([accept(), accept()]);
    assert.deepEqual(duplicateResults.map((result) => result.status), [200, 200]);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM ledger_entries WHERE order_id=?").get(first).n, 1);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM order_events WHERE order_id=?").get(first).n, 2);
    const second = await make("competing-decision");
    const [accepted, rejected] = await Promise.all([
      f.json(`/api/restaurant/orders/${second}/status`, { method: "PATCH", cookie: c.owner1, body: { status: "accepted" } }),
      f.json(`/api/restaurant/orders/${second}/status`, { method: "PATCH", cookie: c.owner1, body: { status: "rejected" } })
    ]);
    assert.deepEqual([accepted.status, rejected.status].sort(), [200, 409]);
    const stored = f.db.prepare("SELECT status,payment_status FROM orders WHERE id=?").get(second);
    const ledgerCount = f.db.prepare("SELECT count(*) AS n FROM ledger_entries WHERE order_id=?").get(second).n;
    if (stored.status === "accepted") { assert.equal(stored.payment_status, "mock_captured"); assert.equal(ledgerCount, 1); }
    else { assert.equal(stored.status, "rejected"); assert.equal(stored.payment_status, "mock_cancelled"); assert.equal(ledgerCount, 0); }
  } finally { await f.close(); }
});
