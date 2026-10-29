import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { routeDashboardExports } from "../src/dashboard-exports.js";
import { journeyFixture } from "./helpers.js";

function parseCsv(text) {
  const rows = [], row = []; let value = "", quoted = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (char === "," && !quoted) { row.push(value); value = ""; }
    else if (char === "\n" && !quoted) { row.push(value); rows.push([...row]); row.length = 0; value = ""; }
    else if (char !== "\r" || quoted) value += char;
  }
  const [headers, ...data] = rows;
  return data.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index]])));
}

test("dashboard CSV exports enforce owner/admin scope, London periods, privacy and safe spreadsheet cells", async () => {
  const now = "2026-10-29T12:00:00.000Z", f = await journeyFixture({ now: () => new Date(now) });
  try {
    const ownerCookie = await f.login("restaurant@calai.local", "LocalRestaurant!4310"), customerCookie = await f.login("customer@calai.local", "LocalCustomer!4310");
    const owner = f.db.prepare("SELECT id,role FROM users WHERE email='restaurant@calai.local'").get(), otherOwner = f.db.prepare("SELECT id,role FROM users WHERE email='restaurant2@calai.local'").get(), admin = f.db.prepare("SELECT id,role FROM users WHERE email='admin@calai.local'").get(), customer = f.db.prepare("SELECT id,role FROM users WHERE email='customer@calai.local'").get();
    const restaurant = f.db.prepare("SELECT r.* FROM restaurants r JOIN restaurant_memberships m ON m.restaurant_id=r.id WHERE m.user_id=?").get(owner.id), otherRestaurant = f.db.prepare("SELECT r.* FROM restaurants r JOIN restaurant_memberships m ON m.restaurant_id=r.id WHERE m.user_id=?").get(otherOwner.id);
    const item = f.db.prepare("SELECT id FROM menu_items WHERE restaurant_id=? LIMIT 1").get(restaurant.id);
    let sequence = 0;
    async function place(createdAt) {
      const response = await f.json("/api/orders", { method: "POST", cookie: customerCookie, headers: { "Idempotency-Key": `csv-order-${sequence++}` }, body: { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], paymentMethod: "mock_card", fulfillment: "collection" } });
      assert.equal(response.status, 201, response.text);
      f.db.prepare("UPDATE orders SET created_at=? WHERE id=?").run(createdAt, response.body.data.id);
      return response.body.data;
    }
    const ownToday = await place("2026-10-29T08:00:00.000Z"), ownYesterday = await place("2026-10-28T23:59:59.999Z");
    const chat = await f.json(`/api/orders/${ownToday.id}/messages`, { method: "POST", cookie: customerCookie, headers: { "Idempotency-Key": "csv-private-message" }, body: { message: "CSV_PRIVATE_CHAT_MARKER" } });
    assert.equal(chat.status, 201, chat.text);
    f.db.prepare("UPDATE orders SET status='completed',payment_status='mock_captured',customer_name='CSV_PRIVATE_CUSTOMER_MARKER',delivery_address=? WHERE id=?").run(JSON.stringify({ line1: "CSV_PRIVATE_ADDRESS_MARKER" }), ownToday.id);
    const formulaName = '\t=SUM(1,2)\r\n"Kitchen"';
    f.db.prepare("UPDATE restaurants SET name=? WHERE id=?").run(formulaName, restaurant.id);
    f.db.prepare("UPDATE orders SET restaurant_name=? WHERE id=?").run(formulaName, ownToday.id);
    f.db.prepare("UPDATE menu_items SET name=? WHERE id=?").run("  +SUM(1,2)", item.id);
    f.db.prepare("UPDATE order_items SET name=? WHERE order_id=?").run("  +SUM(1,2)", ownToday.id);
    const foreignId = randomUUID();
    f.db.prepare("INSERT INTO orders(id,restaurant_id,restaurant_name,customer_id,status,subtotal_minor,total_minor,commission_minor,payment_method,payment_status,fulfillment,idempotency_key,request_hash,created_at,updated_at) VALUES(?,?,?,?,'placed',9999,9999,700,'cash','cash_due','collection',?,?,?,?)").run(foreignId, otherRestaurant.id, otherRestaurant.name, customer.id, "csv-foreign-order", "fixture", "2026-10-29T09:00:00.000Z", now);
    const staffId = randomUUID();
    f.db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,'CSV staff','csv-staff@example.invalid','fixture','restaurant',?)").run(staffId, now);
    f.db.prepare("INSERT INTO restaurant_memberships(restaurant_id,user_id,permission,created_at) VALUES(?,?,'staff',?)").run(restaurant.id, staffId, now);
    async function request(path, user = owner) {
      const headers = new Map(), response = { status: null, text: "" };
      const res = { writeHead(status, values) { response.status = status; for (const [name, value] of Object.entries(values)) headers.set(name.toLowerCase(), value); }, end(body) { response.text = body; } };
      try { response.handled = await routeDashboardExports({ req: { method: "GET" }, res, url: new URL(path, "http://csv.local"), db: f.db, config: f.config, session: user ? { user } : null }); }
      catch (error) { response.status = error.status; response.error = error.code; response.errorMessage = error.message; }
      return { ...response, headers, rows: response.status === 200 ? parseCsv(response.text) : [] };
    }
    const base = `/api/restaurant/restaurants/${restaurant.id}/dashboard`;
    const orders = await request(`${base}/orders.csv?period=today`);
    assert.equal(orders.status, 200, orders.errorMessage); assert.equal(orders.handled, true); assert.equal(orders.rows.length, 1);
    assert.equal(orders.rows[0].orderId, ownToday.id); assert.equal(orders.rows[0].status, "completed"); assert.equal(orders.rows[0].fulfillment, "collection");
    assert.equal(orders.rows[0].restaurantName, "'" + formulaName);
    assert.equal(orders.text.charCodeAt(0), 0xFEFF); assert.match(orders.headers.get("content-type"), /text\/csv/); assert.match(orders.headers.get("content-disposition"), /attachment; filename="Cal-Eats-business-orders-2026-10-29-2026-10-29.csv"/); assert.equal(orders.headers.get("cache-control"), "no-store");
    for (const value of [foreignId, ownYesterday.id, "CSV_PRIVATE_CHAT_MARKER", "CSV_PRIVATE_CUSTOMER_MARKER", "CSV_PRIVATE_ADDRESS_MARKER", customer.id, "password", "totalMinor", "commissionMinor", "paymentStatus"]) assert.equal(orders.text.includes(value), false, value);
    const yesterday = await request(`${base}/orders.csv?period=yesterday`);
    assert.deepEqual(yesterday.rows.map(row => row.orderId), [ownYesterday.id]);
    const metrics = await request(`${base}/metrics.csv?period=today`);
    assert.equal(metrics.status, 200);
    assert.equal(metrics.rows.find(row => row.metric === "ordersPlaced").value, "1");
    assert.equal(metrics.rows.find(row => row.metric === "completedOrders").value, "1");
    assert.equal(metrics.rows.find(row => row.metric === "popularItemQuantity").itemName, "'  +SUM(1,2)");
    assert.equal(metrics.rows.find(row => row.metric === "activeOrders").basis, "current_all_dates");
    assert.equal(metrics.rows.every(row => row.restaurantId === restaurant.id), true);
    assert.equal((await request(`${base}/orders.csv`, otherOwner)).status, 404);
    assert.equal((await request(`${base}/orders.csv`, { id: staffId, role: "restaurant" })).status, 403);
    assert.equal((await request(`${base}/orders.csv`, customer)).status, 403);
    assert.equal((await request(`${base}/orders.csv`, admin)).status, 403);
    assert.equal((await request(`${base}/orders.csv`, null)).status, 401);
    assert.equal((await request(`${base}/orders.csv?period=all_time`)).status, 400);
    const adminOrders = await request("/api/admin/dashboard/orders.csv?from=2026-10-29&to=2026-10-29", admin);
    assert.equal(adminOrders.status, 200); assert.equal(adminOrders.rows.length, 2); assert.equal(adminOrders.rows.some(row => row.orderId === foreignId), true);
    assert.equal(adminOrders.rows.find(row => row.orderId === ownToday.id).totalMinor, String(ownToday.totalMinor));
    for (const value of ["CSV_PRIVATE_CHAT_MARKER", "CSV_PRIVATE_CUSTOMER_MARKER", "CSV_PRIVATE_ADDRESS_MARKER", customer.id]) assert.equal(adminOrders.text.includes(value), false, value);
    for (const [amount, stamp, key] of [[10000, "2026-10-29T10:00:00.000Z", "selected"], [50000, "2026-10-28T10:00:00.000Z", "outside"]]) {
      f.db.prepare("INSERT INTO marketplace_operations(id,operation_key,restaurant_id,order_id,kind,status,amount_minor,currency,provider_mode,metadata,created_at,updated_at) VALUES(?,?,?,?,'provider_cost','confirmed',?,'GBP','local_simulator','{}',?,?)").run(randomUUID(), `csv-cost-${key}`, restaurant.id, ownToday.id, amount, stamp, stamp);
    }
    const adminMetrics = await request("/api/admin/dashboard/metrics.csv?from=2026-10-29&to=2026-10-29", admin);
    assert.equal(adminMetrics.status, 200); assert.equal(adminMetrics.rows.find(row => row.metric === "ordersPlaced").value, "2");
    const exportedMetric = key => adminMetrics.rows.find(row => row.metric === key).value;
    assert.equal(exportedMetric("grossSalesMinor"), String(ownToday.totalMinor));
    assert.equal(exportedMetric("providerCostMinor"), "10000");
    const expectedMargin = ownToday.commissionMinor - 10000;
    assert.ok(expectedMargin < 0); assert.equal(exportedMetric("estimatedMarginMinor"), String(expectedMargin));
    const adminCookie = await f.login("admin@calai.local", "LocalAdmin!4310");
    const displayedFinance = await f.json("/api/admin/finance/summary?from=2026-10-29&to=2026-10-29", { cookie: adminCookie });
    assert.equal(displayedFinance.status, 200, displayedFinance.text);
    assert.equal(Number(exportedMetric("estimatedMarginMinor")), displayedFinance.body.data.marginMinor);
    assert.equal(Number(exportedMetric("providerCostMinor")), displayedFinance.body.data.actualProviderCostMinor);
    const restaurants = await request("/api/admin/dashboard/restaurants.csv?from=2026-10-29&to=2026-10-29", admin);
    assert.equal(restaurants.status, 200); assert.equal(restaurants.rows.length, 2); assert.equal(restaurants.rows.find(row => row.restaurantId === restaurant.id).ordersPlaced, "1");
    assert.equal((await request("/api/admin/dashboard/orders.csv", owner)).status, 403);
    assert.equal((await request("/api/admin/dashboard/metrics.csv?from=2026-10-30&to=2026-10-29", admin)).status, 400);
    assert.equal((await request("/api/admin/dashboard/orders.csv?from=not-a-date", admin)).status, 400);
    const audit = f.db.prepare("SELECT actor_user_id,entity_id,details FROM audit_events WHERE action='dashboard_csv_exported'").all();
    assert.equal(audit.length, 6); assert.equal(audit.every(row => [owner.id, admin.id].includes(row.actor_user_id)), true);
    assert.equal(audit.every(row => !row.details.includes("CSV_PRIVATE_")), true);
    assert.equal((await request("/api/other")).handled, false);
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { await f.close(); }
});
