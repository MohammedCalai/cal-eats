import { createHash, randomUUID } from "node:crypto";
import { calculateCommission, VALIDATION } from "../../../packages/contracts/src/index.js";
import { requireRole, requireRestaurantMembership, requireUser } from "./auth/authorization.js";
import { HttpError, exactObject, readJson, sendJson } from "./http.js";
import { withTransaction } from "./db/index.js";

const integer = (value, min, max, label) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new HttpError(400, "VALIDATION_ERROR", `${label} is invalid`);
  return value;
};
const text = (value, min, max, label) => {
  const result = typeof value === "string" ? value.trim() : "";
  if (result.length < min || result.length > max) throw new HttpError(400, "VALIDATION_ERROR", `${label} is invalid`);
  return result;
};
const bool = (value, label) => {
  if (typeof value !== "boolean") throw new HttpError(400, "VALIDATION_ERROR", `${label} is invalid`);
  return value;
};

function deliveryFromRow(row) {
  return { enabled: Boolean(row.delivery_enabled), outcodes: JSON.parse(row.delivery_outcodes), deliveryFeeMinor: row.delivery_fee_minor, minDeliverySubtotalMinor: row.min_delivery_subtotal_minor };
}
function restaurantDto(row) {
  return { id: row.id, name: row.name, status: row.status, createdAt: row.created_at, delivery: deliveryFromRow(row) };
}
function itemDto(row) {
  return { id: row.id, restaurantId: row.restaurant_id, name: row.name, description: row.description, priceMinor: row.price_minor, available: Boolean(row.available) };
}
function ledgerDto(row) {
  return { id: row.id, orderId: row.order_id, restaurantId: row.restaurant_id, kind: row.kind, amountMinor: row.amount_minor, currency: row.currency, createdAt: row.created_at };
}
function orderDto(db, row, includeLedger = false) {
  const items = db.prepare("SELECT * FROM order_items WHERE order_id=? ORDER BY rowid").all(row.id).map((item) => ({ id: item.id, menuItemId: item.menu_item_id, name: item.name, unitPriceMinor: item.unit_price_minor, quantity: item.quantity, lineTotalMinor: item.unit_price_minor * item.quantity }));
  const events = db.prepare("SELECT id,kind,from_status,to_status,created_at FROM order_events WHERE order_id=? ORDER BY created_at,rowid").all(row.id).map((event) => ({ id: event.id, kind: event.kind, fromStatus: event.from_status, toStatus: event.to_status, createdAt: event.created_at }));
  const result = { id: row.id, restaurantId: row.restaurant_id, restaurantName: row.restaurant_name, customerId: row.customer_id, status: row.status, currency: row.currency, subtotalMinor: row.subtotal_minor, deliveryFeeMinor: row.delivery_fee_minor, totalMinor: row.total_minor, deliveryAddress: row.delivery_address ? JSON.parse(row.delivery_address) : null, commissionMinor: row.commission_minor, paymentMethod: row.payment_method, paymentStatus: row.payment_status, fulfillment: row.fulfillment, createdAt: row.created_at, updatedAt: row.updated_at, items, events };
  if (includeLedger) result.ledger = db.prepare("SELECT * FROM ledger_entries WHERE order_id=? ORDER BY created_at,rowid").all(row.id).map(ledgerDto);
  return result;
}

function normalizeOutcode(value) {
  const outcode = typeof value === "string" ? value.trim().toUpperCase().replace(/\s+/g, "") : "";
  if (!/^[A-Z]{1,2}\d[A-Z\d]?$/.test(outcode)) throw new HttpError(400, "VALIDATION_ERROR", "Delivery outcode is invalid");
  return outcode;
}
function normalizeAddress(value) {
  exactObject(value, ["line1", "line2", "city", "postcode"]);
  const compact = typeof value.postcode === "string" ? value.postcode.trim().toUpperCase().replace(/\s+/g, "") : "";
  const match = compact.match(/^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$/);
  if (!match) throw new HttpError(400, "VALIDATION_ERROR", "Delivery postcode is invalid");
  return {
    line1: text(value.line1, 1, VALIDATION.addressLineMax, "Address line 1"),
    ...(value.line2 === undefined ? {} : { line2: text(value.line2, 1, VALIDATION.addressLineMax, "Address line 2") }),
    city: text(value.city, 1, VALIDATION.cityMax, "City"),
    postcode: `${match[1]} ${match[2]}`,
    outcode: match[1]
  };
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const requestHash = (value) => createHash("sha256").update(canonical(value)).digest("hex");

function authorizedOrder(db, session, id) {
  const user = requireUser(session);
  const row = db.prepare("SELECT * FROM orders WHERE id=?").get(id);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Resource not found");
  const member = user.role === "restaurant" && db.prepare("SELECT 1 FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?").get(row.restaurant_id, user.id);
  if (user.role !== "admin" && row.customer_id !== user.id && !member) throw new HttpError(404, "NOT_FOUND", "Resource not found");
  return { row, user, includeLedger: user.role === "admin" || Boolean(member) };
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
function receiptHtml(order) {
  const money = (minor) => `£${(minor / 100).toFixed(2)}`;
  const rows = order.items.map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${item.quantity}</td><td>${money(item.lineTotalMinor)}</td></tr>`).join("");
  const address = order.deliveryAddress ? `<p><strong>Deliver to:</strong> ${[order.deliveryAddress.line1, order.deliveryAddress.line2, order.deliveryAddress.city, order.deliveryAddress.postcode].filter(Boolean).map(escapeHtml).join(", ")}</p>` : "";
  const payment = order.paymentMethod === "mock_card" ? "Mock card — no real payment processed" : "Cash — paid directly to restaurant; collection is confirmed only when completed";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Order receipt</title><style>body{font:16px system-ui;max-width:720px;margin:2rem auto}table{width:100%;border-collapse:collapse}td,th{padding:.5rem;border-bottom:1px solid #ccc;text-align:left}@media print{body{margin:0}}</style></head><body><h1>${escapeHtml(order.restaurantName)}</h1><p>Order ${escapeHtml(order.id)}</p><p>Fulfillment: ${escapeHtml(order.fulfillment)}</p>${address}<table><thead><tr><th>Item</th><th>Qty</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table><p>Food subtotal: ${money(order.subtotalMinor)}</p><p>Delivery fee: ${money(order.deliveryFeeMinor)}</p><p><strong>Total: ${money(order.totalMinor)}</strong></p><p>${escapeHtml(payment)}</p><p>Status: ${escapeHtml(order.status)}</p></body></html>`;
}

export async function routeJourney({ req, res, url, db, config, session }) {
  if (req.method === "GET" && url.pathname === "/api/restaurants") {
    return sendJson(res, 200, { data: db.prepare("SELECT * FROM restaurants WHERE status='approved' ORDER BY name").all().map(restaurantDto) });
  }
  let match = url.pathname.match(/^\/api\/restaurants\/([^/]+)\/menu$/);
  if (req.method === "GET" && match) {
    const restaurant = db.prepare("SELECT * FROM restaurants WHERE id=? AND status='approved'").get(match[1]);
    if (!restaurant) throw new HttpError(404, "NOT_FOUND", "Resource not found");
    const items = db.prepare("SELECT * FROM menu_items WHERE restaurant_id=? AND available=1 ORDER BY name").all(restaurant.id).map(itemDto);
    return sendJson(res, 200, { data: { restaurant: restaurantDto(restaurant), items } });
  }
  if (req.method === "GET" && url.pathname === "/api/restaurant/restaurants") {
    const user = requireRole(session, "restaurant");
    const rows = db.prepare("SELECT r.* FROM restaurants r JOIN restaurant_memberships m ON m.restaurant_id=r.id WHERE m.user_id=? ORDER BY r.created_at").all(user.id);
    return sendJson(res, 200, { data: rows.map(restaurantDto) });
  }
  if (req.method === "POST" && url.pathname === "/api/restaurant/restaurants") {
    const user = requireRole(session, "restaurant");
    const body = await readJson(req, config.bodyLimit); exactObject(body, ["name"]);
    const now = config.now().toISOString();
    const restaurant = { id: randomUUID(), name: text(body.name, 1, VALIDATION.restaurantNameMax, "Restaurant name"), status: "pending", created_at: now, delivery_enabled: 0, delivery_outcodes: "[]", delivery_fee_minor: 0, min_delivery_subtotal_minor: 0 };
    withTransaction(db, () => {
      db.prepare("INSERT INTO restaurants(id,name,status,created_at) VALUES(?,?,?,?)").run(restaurant.id, restaurant.name, restaurant.status, now);
      db.prepare("INSERT INTO restaurant_memberships VALUES(?,?,?)").run(restaurant.id, user.id, now);
    });
    return sendJson(res, 201, { data: restaurantDto(restaurant) });
  }
  match = url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/menu$/);
  if (match && req.method === "GET") {
    requireRestaurantMembership(db, session, match[1]);
    const restaurant = db.prepare("SELECT * FROM restaurants WHERE id=?").get(match[1]);
    return sendJson(res, 200, { data: { restaurant: restaurantDto(restaurant), items: db.prepare("SELECT * FROM menu_items WHERE restaurant_id=? ORDER BY name").all(match[1]).map(itemDto) } });
  }
  if (match && req.method === "POST") {
    requireRestaurantMembership(db, session, match[1]);
    const body = await readJson(req, config.bodyLimit); exactObject(body, ["name", "description", "priceMinor"]);
    const now = config.now().toISOString();
    const item = { id: randomUUID(), restaurant_id: match[1], name: text(body.name, 1, VALIDATION.menuNameMax, "Item name"), description: text(body.description ?? "", 0, VALIDATION.descriptionMax, "Description"), price_minor: integer(body.priceMinor, 0, VALIDATION.priceMaxMinor, "Price"), available: 1, created_at: now, updated_at: now };
    db.prepare("INSERT INTO menu_items VALUES(?,?,?,?,?,?,?,?)").run(item.id, item.restaurant_id, item.name, item.description, item.price_minor, item.available, now, now);
    return sendJson(res, 201, { data: itemDto(item) });
  }
  match = url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/menu\/([^/]+)$/);
  if (match && req.method === "PATCH") {
    requireRestaurantMembership(db, session, match[1]);
    const body = await readJson(req, config.bodyLimit); exactObject(body, ["name", "description", "priceMinor", "available"]);
    if (!Object.keys(body).length) throw new HttpError(400, "VALIDATION_ERROR", "At least one field is required");
    const current = db.prepare("SELECT * FROM menu_items WHERE id=? AND restaurant_id=?").get(match[2], match[1]);
    if (!current) throw new HttpError(404, "NOT_FOUND", "Resource not found");
    const updated = { ...current, name: body.name === undefined ? current.name : text(body.name, 1, VALIDATION.menuNameMax, "Item name"), description: body.description === undefined ? current.description : text(body.description, 0, VALIDATION.descriptionMax, "Description"), price_minor: body.priceMinor === undefined ? current.price_minor : integer(body.priceMinor, 0, VALIDATION.priceMaxMinor, "Price"), available: body.available === undefined ? current.available : Number(bool(body.available, "Available")), updated_at: config.now().toISOString() };
    db.prepare("UPDATE menu_items SET name=?,description=?,price_minor=?,available=?,updated_at=? WHERE id=?").run(updated.name, updated.description, updated.price_minor, updated.available, updated.updated_at, updated.id);
    return sendJson(res, 200, { data: itemDto(updated) });
  }
  match = url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/delivery$/);
  if (match && req.method === "PATCH") {
    requireRestaurantMembership(db, session, match[1]);
    const body = await readJson(req, config.bodyLimit); exactObject(body, ["enabled", "outcodes", "deliveryFeeMinor", "minDeliverySubtotalMinor"]);
    if (!Array.isArray(body.outcodes) || body.outcodes.length > VALIDATION.deliveryOutcodesMax) throw new HttpError(400, "VALIDATION_ERROR", "Delivery outcodes are invalid");
    const outcodes = [...new Set(body.outcodes.map(normalizeOutcode))].sort();
    const enabled = bool(body.enabled, "Delivery enabled");
    if (enabled && !outcodes.length) throw new HttpError(400, "VALIDATION_ERROR", "Enabled delivery requires an outcode");
    const fee = integer(body.deliveryFeeMinor, 0, VALIDATION.priceMaxMinor, "Delivery fee");
    const minimum = integer(body.minDeliverySubtotalMinor, 0, VALIDATION.priceMaxMinor, "Delivery minimum");
    db.prepare("UPDATE restaurants SET delivery_enabled=?,delivery_outcodes=?,delivery_fee_minor=?,min_delivery_subtotal_minor=? WHERE id=?").run(Number(enabled), JSON.stringify(outcodes), fee, minimum, match[1]);
    return sendJson(res, 200, { data: restaurantDto(db.prepare("SELECT * FROM restaurants WHERE id=?").get(match[1])) });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/restaurants") {
    requireRole(session, "admin");
    return sendJson(res, 200, { data: db.prepare("SELECT * FROM restaurants ORDER BY created_at").all().map(restaurantDto) });
  }
  match = url.pathname.match(/^\/api\/admin\/restaurants\/([^/]+)\/approval$/);
  if (match && req.method === "PATCH") {
    const user = requireRole(session, "admin");
    const body = await readJson(req, config.bodyLimit); exactObject(body, ["status"]);
    if (!["approved", "rejected"].includes(body.status)) throw new HttpError(400, "VALIDATION_ERROR", "Approval status is invalid");
    const restaurant = db.prepare("SELECT * FROM restaurants WHERE id=?").get(match[1]);
    if (!restaurant) throw new HttpError(404, "NOT_FOUND", "Resource not found");
    const now = config.now().toISOString();
    withTransaction(db, () => {
      db.prepare("UPDATE restaurants SET status=? WHERE id=?").run(body.status, restaurant.id);
      db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(), user.id, "restaurant", restaurant.id, "approval_changed", JSON.stringify({ from: restaurant.status, to: body.status }), now);
    });
    return sendJson(res, 200, { data: restaurantDto(db.prepare("SELECT * FROM restaurants WHERE id=?").get(restaurant.id)) });
  }
  if (req.method === "POST" && url.pathname === "/api/orders") return createOrder({ req, res, db, config, session });
  if (req.method === "GET" && url.pathname === "/api/orders") {
    const user = requireRole(session, "customer");
    return sendJson(res, 200, { data: db.prepare("SELECT * FROM orders WHERE customer_id=? ORDER BY created_at DESC").all(user.id).map((row) => orderDto(db, row)) });
  }
  match = url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/orders$/);
  if (match && req.method === "GET") {
    requireRestaurantMembership(db, session, match[1]);
    return sendJson(res, 200, { data: db.prepare("SELECT * FROM orders WHERE restaurant_id=? ORDER BY created_at DESC").all(match[1]).map((row) => orderDto(db, row, true)) });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/orders") {
    requireRole(session, "admin");
    return sendJson(res, 200, { data: db.prepare("SELECT * FROM orders ORDER BY created_at DESC").all().map((row) => orderDto(db, row, true)) });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/ledger") {
    requireRole(session, "admin");
    return sendJson(res, 200, { data: db.prepare("SELECT * FROM ledger_entries ORDER BY created_at DESC").all().map(ledgerDto) });
  }
  match = url.pathname.match(/^\/api\/restaurant\/orders\/([^/]+)\/status$/);
  if (match && req.method === "PATCH") return updateStatus({ req, res, db, config, session, id: match[1] });
  match = url.pathname.match(/^\/api\/orders\/([^/]+)\/receipt$/);
  if (match && req.method === "GET") {
    const access = authorizedOrder(db, session, match[1]);
    const html = receiptHtml(orderDto(db, access.row, access.includeLedger));
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) }); res.end(html); return true;
  }
  match = url.pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (match && req.method === "GET") {
    const access = authorizedOrder(db, session, match[1]);
    return sendJson(res, 200, { data: orderDto(db, access.row, access.includeLedger) });
  }
  return false;
}

async function createOrder({ req, res, db, config, session }) {
  const user = requireRole(session, "customer");
  const key = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"].trim() : "";
  if (!key || key.length > VALIDATION.idempotencyKeyMax) throw new HttpError(400, "VALIDATION_ERROR", "Idempotency-Key is required and invalid");
  const body = await readJson(req, config.bodyLimit);
  exactObject(body, ["restaurantId", "items", "paymentMethod", "fulfillment", "deliveryAddress"]);
  if (typeof body.restaurantId !== "string" || !Array.isArray(body.items) || !body.items.length || body.items.length > VALIDATION.orderItemsMax || !["mock_card", "cash"].includes(body.paymentMethod) || !["collection", "delivery"].includes(body.fulfillment)) throw new HttpError(400, "VALIDATION_ERROR", "Order is invalid");
  if (body.fulfillment === "collection" && body.deliveryAddress !== undefined) throw new HttpError(400, "VALIDATION_ERROR", "Collection orders cannot include a delivery address");
  const address = body.fulfillment === "delivery" ? normalizeAddress(body.deliveryAddress) : null;
  const normalizedItems = body.items.map((entry) => { exactObject(entry, ["menuItemId", "quantity"]); return { menuItemId: text(entry.menuItemId, 1, 100, "Menu item"), quantity: integer(entry.quantity, 1, VALIDATION.quantityMax, "Quantity") }; });
  if (new Set(normalizedItems.map((item) => item.menuItemId)).size !== normalizedItems.length) throw new HttpError(400, "VALIDATION_ERROR", "Duplicate menu items are not allowed");
  const canonicalBody = { restaurantId: body.restaurantId, items: normalizedItems, paymentMethod: body.paymentMethod, fulfillment: body.fulfillment, ...(address ? { deliveryAddress: address } : {}) };
  const hash = requestHash(canonicalBody);
  const prior = db.prepare("SELECT * FROM orders WHERE customer_id=? AND idempotency_key=?").get(user.id, key);
  if (prior) {
    if (prior.request_hash !== hash) throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used for another request");
    return sendJson(res, 200, { data: orderDto(db, prior) });
  }
  const restaurant = db.prepare("SELECT * FROM restaurants WHERE id=? AND status='approved'").get(body.restaurantId);
  if (!restaurant) throw new HttpError(404, "NOT_FOUND", "Resource not found");
  const menu = normalizedItems.map((entry) => ({ entry, row: db.prepare("SELECT * FROM menu_items WHERE id=? AND restaurant_id=? AND available=1").get(entry.menuItemId, restaurant.id) }));
  if (menu.some(({ row }) => !row)) throw new HttpError(409, "MENU_UNAVAILABLE", "One or more menu items are unavailable");
  const subtotal = menu.reduce((sum, { entry, row }) => sum + row.price_minor * entry.quantity, 0);
  if (!Number.isSafeInteger(subtotal) || subtotal > VALIDATION.priceMaxMinor) throw new HttpError(400, "VALIDATION_ERROR", "Order subtotal is invalid");
  let fee = 0;
  if (address) {
    const delivery = deliveryFromRow(restaurant);
    if (!delivery.enabled) throw new HttpError(409, "DELIVERY_DISABLED", "Restaurant delivery is disabled");
    if (!delivery.outcodes.includes(address.outcode)) throw new HttpError(409, "DELIVERY_OUTSIDE_AREA", "Address is outside the delivery area");
    if (subtotal < delivery.minDeliverySubtotalMinor) throw new HttpError(409, "DELIVERY_MINIMUM", "Order does not meet the delivery minimum");
    fee = delivery.deliveryFeeMinor;
  }
  const now = config.now().toISOString();
  const deliveryAddress = address ? Object.fromEntries(Object.entries(address).filter(([key]) => key !== "outcode")) : null;
  const order = { id: randomUUID(), restaurant_id: restaurant.id, restaurant_name: restaurant.name, customer_id: user.id, status: "placed", currency: "GBP", subtotal_minor: subtotal, delivery_fee_minor: fee, total_minor: subtotal + fee, delivery_address: deliveryAddress ? JSON.stringify(deliveryAddress) : null, commission_minor: calculateCommission(subtotal), payment_method: body.paymentMethod, payment_status: body.paymentMethod === "mock_card" ? "mock_authorized" : "cash_due", fulfillment: body.fulfillment, idempotency_key: key, request_hash: hash, created_at: now, updated_at: now };
  withTransaction(db, () => {
    db.prepare("INSERT INTO orders VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(...Object.values(order));
    for (const { entry, row } of menu) db.prepare("INSERT INTO order_items VALUES(?,?,?,?,?,?)").run(randomUUID(), order.id, row.id, row.name, row.price_minor, entry.quantity);
    db.prepare("INSERT INTO order_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(), order.id, user.id, "status_changed", null, "placed", now);
  });
  return sendJson(res, 201, { data: orderDto(db, order) });
}

async function updateStatus({ req, res, db, config, session, id }) {
  const user = requireRole(session, "restaurant");
  const body = await readJson(req, config.bodyLimit); exactObject(body, ["status"]);
  const updated = withTransaction(db, () => {
    const order = db.prepare("SELECT * FROM orders WHERE id=?").get(id);
    if (!order || !db.prepare("SELECT 1 FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?").get(order.restaurant_id, user.id)) throw new HttpError(404, "NOT_FOUND", "Resource not found");
    if (body.status === order.status) return order;
    const paths = order.fulfillment === "delivery" ? { placed: ["accepted", "rejected"], accepted: ["preparing"], preparing: ["ready"], ready: ["out_for_delivery"], out_for_delivery: ["completed"] } : { placed: ["accepted", "rejected"], accepted: ["preparing"], preparing: ["ready"], ready: ["completed"] };
    if (!paths[order.status]?.includes(body.status)) throw new HttpError(409, "INVALID_TRANSITION", "Order status transition is not allowed");
    if (order.status === "placed" && body.status === "accepted" && !db.prepare("SELECT 1 FROM restaurants WHERE id=? AND status='approved'").get(order.restaurant_id)) throw new HttpError(409, "RESTAURANT_UNAVAILABLE", "Restaurant is not approved");
    const now = config.now().toISOString();
    let paymentStatus = order.payment_status;
    if (body.status === "accepted" && order.payment_method === "mock_card") paymentStatus = "mock_captured";
    if (body.status === "rejected") paymentStatus = order.payment_method === "mock_card" ? "mock_cancelled" : "cash_cancelled";
    if (body.status === "completed" && order.payment_method === "cash") paymentStatus = "cash_collected";
    db.prepare("UPDATE orders SET status=?,payment_status=?,updated_at=? WHERE id=?").run(body.status, paymentStatus, now, order.id);
    db.prepare("INSERT INTO order_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(), order.id, user.id, "status_changed", order.status, body.status, now);
    if (body.status === "accepted") {
      const kind = order.payment_method === "mock_card" ? "commission_mock" : "commission_cash_receivable";
      db.prepare("INSERT OR IGNORE INTO ledger_entries VALUES(?,?,?,?,?,?,?)").run(randomUUID(), order.id, order.restaurant_id, kind, order.commission_minor, order.currency, now);
    }
    return db.prepare("SELECT * FROM orders WHERE id=?").get(order.id);
  });
  return sendJson(res, 200, { data: orderDto(db, updated, true) });
}
