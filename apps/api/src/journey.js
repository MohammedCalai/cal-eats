import { createHash, randomUUID } from "node:crypto";
import { calculateCommissionAtRate, VALIDATION } from "../../../packages/contracts/src/index.js";
import { requireRole, requireRestaurantMembership, requireRestaurantOwner, requireUser } from "./auth/authorization.js";
import { HttpError, exactObject, readJson, sendJson } from "./http.js";
import { withTransaction } from "./db/index.js";
import { authorizeMockPayment, captureMockPayment } from "./payments/mock.js";
import { restaurantAvailability } from "./availability.js";
import { notifyNewOrder, notifyOrderStatus, redeemOfferForOrder, releaseOfferForOrder } from "./offers.js";
import { normalizeAddress } from "./address-validation.js";
import { restaurantReadiness } from "./readiness.js";
import { recordMarketplaceAcceptance, recordMarketplaceCompletion } from "./marketplace.js";

export const integer = (value, min, max, label) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new HttpError(400, "VALIDATION_ERROR", `${label} is invalid`);
  return value;
};
export const text = (value, min, max, label) => {
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
export function restaurantDto(row, { privateDetails = false, now = new Date() } = {}) {
  const availability = restaurantAvailability(row, now);
  const profile = { description: row.description, cuisine: row.cuisine, phone: row.phone, address: row.address, collectionEnabled: Boolean(row.collection_enabled), cashEnabled: Boolean(row.cash_enabled), paused: Boolean(row.paused), busyMinutes: row.busy_minutes, estimatedDeliveryMinutes: row.estimated_delivery_minutes, estimatedCollectionMinutes: row.estimated_collection_minutes, openingHours: JSON.parse(row.opening_hours ?? "[]"), holidayDates: JSON.parse(row.holiday_dates ?? "[]"), alwaysOpen: Boolean(row.always_open) };
  return { id: row.id, name: row.name, status: row.status, createdAt: row.created_at, coverImageUrl: row.cover_media_id ? `/api/media/${row.cover_media_id}` : null, ...(row.permission ? { permission: row.permission } : {}), delivery: deliveryFromRow(row), profile, ...availability, suspended: Boolean(row.suspended), foodInformation: { verificationStatus: row.food_verification_status, source: row.food_source, checkedAt: row.food_checked_at } };
}
export function itemDto(row) {
  return { id: row.id, restaurantId: row.restaurant_id, name: row.name, description: row.description, priceMinor: row.price_minor, available: Boolean(row.available), category: row.category, allergens: JSON.parse(row.allergens ?? "[]"), dietaryTags: JSON.parse(row.dietary_tags ?? "[]"), modifierGroups: JSON.parse(row.modifier_groups ?? "[]"), sortOrder: row.sort_order ?? 0, photoUrl: row.photo_media_id ? `/api/media/${row.photo_media_id}` : null };
}
const shortId = (value, label) => { const id = text(value, 1, 40, label); if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new HttpError(400, "VALIDATION_ERROR", `${label} is invalid`); return id; };
export const stringList = (value, label) => { if (!Array.isArray(value) || value.length > 30) throw new HttpError(400, "VALIDATION_ERROR", `${label} is invalid`); const list = value.map((entry) => text(entry, 1, 80, label)); if (new Set(list.map((entry) => entry.toLowerCase())).size !== list.length) throw new HttpError(400, "VALIDATION_ERROR", `${label} contains duplicates`); return list; };
export function validateModifierGroups(value) {
  if (!Array.isArray(value) || value.length > 10) throw new HttpError(400, "VALIDATION_ERROR", "Modifier groups are invalid");
  const groups = value.map((group) => {
    exactObject(group, ["id", "name", "minSelections", "maxSelections", "options"]);
    const id = shortId(group.id, "Modifier group ID"); const name = text(group.name, 1, 80, "Modifier group name");
    const minSelections = integer(group.minSelections, 0, 20, "Minimum selections"); const maxSelections = integer(group.maxSelections, 0, 20, "Maximum selections");
    if (!Array.isArray(group.options) || group.options.length > 30 || maxSelections < minSelections || maxSelections > group.options.length) throw new HttpError(400, "VALIDATION_ERROR", "Modifier selection bounds are invalid");
    const options = group.options.map((option) => { exactObject(option, ["id", "name", "priceMinor", "available"]); return { id: shortId(option.id, "Modifier option ID"), name: text(option.name, 1, 80, "Modifier option name"), priceMinor: integer(option.priceMinor, 0, VALIDATION.priceMaxMinor, "Modifier price"), available: bool(option.available, "Modifier availability") }; });
    if (new Set(options.map((option) => option.id)).size !== options.length || options.filter((option) => option.available).length < minSelections) throw new HttpError(400, "VALIDATION_ERROR", "Modifier options cannot satisfy the group");
    return { id, name, minSelections, maxSelections, options };
  });
  if (new Set(groups.map((group) => group.id)).size !== groups.length) throw new HttpError(400, "VALIDATION_ERROR", "Modifier group IDs must be unique");
  return groups;
}
function openingHours(value) {
  if (!Array.isArray(value) || value.length > 21) throw new HttpError(400, "VALIDATION_ERROR", "Opening hours are invalid");
  return value.map((entry) => { exactObject(entry, ["day", "open", "close"]); if (!Number.isInteger(entry.day) || entry.day < 0 || entry.day > 6 || typeof entry.open !== "string" || typeof entry.close !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(entry.open) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(entry.close) || entry.open === entry.close) throw new HttpError(400, "VALIDATION_ERROR", "Opening hours are invalid"); return { day: entry.day, open: entry.open, close: entry.close }; });
}
function dateList(value) { if (!Array.isArray(value) || value.length > 100) throw new HttpError(400, "VALIDATION_ERROR", "Holiday dates are invalid"); const dates = value.map((entry) => { if (typeof entry !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry) || Number.isNaN(Date.parse(`${entry}T00:00:00Z`))) throw new HttpError(400, "VALIDATION_ERROR", "Holiday date is invalid"); return entry; }); return [...new Set(dates)].sort(); }
export function ledgerDto(row) {
  return { id: row.id, orderId: row.order_id, restaurantId: row.restaurant_id, kind: row.kind, amountMinor: row.amount_minor, currency: row.currency, referenceType: row.reference_type, referenceId: row.reference_id, createdAt: row.created_at };
}
function refundDto(row) { return { id: row.id, foodAmountMinor: row.food_amount_minor, deliveryAmountMinor: row.delivery_amount_minor, totalMinor: row.food_amount_minor + row.delivery_amount_minor, reason: row.reason, mode: row.mode, createdAt: row.created_at }; }
export function orderDto(db, row, includeLedger = false, includeFinancial = true) {
  const items = db.prepare("SELECT * FROM order_items WHERE order_id=? ORDER BY rowid").all(row.id).map((item) => ({ id: item.id, menuItemId: item.menu_item_id, name: item.name, basePriceMinor: item.base_price_minor, unitPriceMinor: item.unit_price_minor, quantity: item.quantity, lineTotalMinor: item.unit_price_minor * item.quantity, selectedModifiers: JSON.parse(item.selected_modifiers ?? "[]"), allergens: JSON.parse(item.allergens ?? "[]"), category: item.category, isOfferItem: Boolean(item.is_offer_item) }));
  const events = db.prepare("SELECT id,kind,from_status,to_status,created_at FROM order_events WHERE order_id=? ORDER BY created_at,rowid").all(row.id).map((event) => ({ id: event.id, kind: event.kind, fromStatus: event.from_status, toStatus: event.to_status, createdAt: event.created_at }));
  const refunds = db.prepare("SELECT * FROM refunds WHERE order_id=? ORDER BY created_at,rowid").all(row.id);
  const refundedFoodMinor = refunds.reduce((sum, refund) => sum + refund.food_amount_minor, 0);
  const refundedDeliveryMinor = refunds.reduce((sum, refund) => sum + refund.delivery_amount_minor, 0);
  const result = { id: row.id, restaurantId: row.restaurant_id, restaurantName: row.restaurant_name, customerId: row.customer_id, customerName: row.customer_name, customerEmail: row.customer_email, customerPhone: row.customer_phone, deliveryInstructions: row.delivery_instructions, allergyNotes: row.allergy_notes, status: row.status, estimatedReadyAt: row.estimated_ready_at ?? null, currency: row.currency, subtotalMinor: row.subtotal_minor, deliveryFeeMinor: row.delivery_fee_minor, totalMinor: row.total_minor, deliveryAddress: row.delivery_address ? JSON.parse(row.delivery_address) : null, commissionMinor: row.commission_minor, contract: { rateBasisPoints: row.contract_rate_bps, commissionBase: row.commission_base ?? "food", policyVersion: row.contract_policy_version, demoOnly: Boolean(row.contract_demo_only) }, paymentMethod: row.payment_method, paymentStatus: row.payment_status, fulfillment: row.fulfillment, refundedFoodMinor, refundedDeliveryMinor, refundedTotalMinor: refundedFoodMinor + refundedDeliveryMinor, refunds: refunds.map(refundDto), ...(row.offer_snapshot ? { offer: JSON.parse(row.offer_snapshot) } : {}), createdAt: row.created_at, updatedAt: row.updated_at, items, events };
  if (includeLedger) result.ledger = db.prepare("SELECT * FROM ledger_entries WHERE order_id=? ORDER BY created_at,rowid").all(row.id).map(ledgerDto);
  if (!includeFinancial) { delete result.commissionMinor; delete result.contract; }
  return result;
}

function normalizeOutcode(value) {
  const outcode = typeof value === "string" ? value.trim().toUpperCase().replace(/\s+/g, "") : "";
  if (!/^[A-Z]{1,2}\d[A-Z\d]?$/.test(outcode)) throw new HttpError(400, "VALIDATION_ERROR", "Delivery outcode is invalid");
  return outcode;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const requestHash = (value) => createHash("sha256").update(canonical(value)).digest("hex");

export function authorizedOrder(db, session, id) {
  const user = requireUser(session);
  const row = db.prepare("SELECT * FROM orders WHERE id=?").get(id);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Resource not found");
  const member = user.role === "restaurant" && db.prepare("SELECT permission FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?").get(row.restaurant_id, user.id);
  if (user.role !== "admin" && row.customer_id !== user.id && !member) throw new HttpError(404, "NOT_FOUND", "Resource not found");
  return { row, user, includeLedger: user.role === "admin" || member?.permission === "owner", includeFinancial: !member || member.permission === "owner" };
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
function receiptHtml(order, printJobId = null) {
  const money = (minor) => `£${(minor / 100).toFixed(2)}`;
  const rows = order.items.map((item) => `<tr><td>${escapeHtml(item.name)}${item.isOfferItem ? "<br><strong>FREE OFFER ITEM</strong>" : ""}${item.selectedModifiers.length ? `<br><small>${item.selectedModifiers.map((modifier) => escapeHtml(modifier.name)).join(", ")}</small>` : ""}${item.allergens.length ? `<br><small>Allergens: ${item.allergens.map(escapeHtml).join(", ")} (restaurant supplied)</small>` : ""}</td><td>${item.quantity}</td><td>${item.isOfferItem ? `Free (value ${money(item.basePriceMinor)})` : money(item.lineTotalMinor)}</td></tr>`).join("");
  const address = order.deliveryAddress ? `<p><strong>Deliver to:</strong> ${[order.deliveryAddress.line1, order.deliveryAddress.line2, order.deliveryAddress.city, order.deliveryAddress.postcode].filter(Boolean).map(escapeHtml).join(", ")}</p>` : "";
  const payment = order.paymentMethod === "mock_card" ? "Mock card — no real payment processed" : "Cash — paid directly to restaurant; collection is confirmed only when completed";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Order receipt</title><style>@page{size:80mm auto;margin:4mm}body{font:12px system-ui;width:72mm;margin:0 auto}table{width:100%;border-collapse:collapse}td,th{padding:2mm 0;border-bottom:1px solid #ccc;text-align:left}.allergy{border:2px solid #000;padding:2mm}@media screen{body{padding:1rem}}</style></head><body><h1>${escapeHtml(order.restaurantName)}</h1><p>Order ${escapeHtml(order.id)}</p><p>Created: ${escapeHtml(order.createdAt)}</p>${printJobId ? `<p><strong>Reprint reference:</strong> ${escapeHtml(printJobId)}</p>` : ""}<p>Customer: ${escapeHtml(order.customerName)} · ${escapeHtml(order.customerPhone || "No phone supplied")}</p><p>Fulfillment: ${escapeHtml(order.fulfillment)}</p>${address}${order.deliveryInstructions ? `<p>Instructions: ${escapeHtml(order.deliveryInstructions)}</p>` : ""}${order.allergyNotes ? `<p class="allergy"><strong>ALLERGY NOTE:</strong> ${escapeHtml(order.allergyNotes)}</p>` : ""}<table><thead><tr><th>Item</th><th>Qty</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table><p>Food subtotal: ${money(order.subtotalMinor)}</p><p>Delivery fee: ${money(order.deliveryFeeMinor)}</p><p>Refunded: ${money(order.refundedTotalMinor)}</p><p><strong>Total: ${money(order.totalMinor - order.refundedTotalMinor)}</strong></p><p>${escapeHtml(payment)}</p><p>Payment status: ${escapeHtml(order.paymentStatus)}</p><p>Order status: ${escapeHtml(order.status)}</p></body></html>`;
}

export async function routeJourney({ req, res, url, db, config, session }) {
  if (req.method === "GET" && url.pathname === "/api/restaurants") {
    const postcode = url.searchParams.get("postcode"); const fulfillment = url.searchParams.get("fulfillment"); const q = url.searchParams.get("q")?.trim().toLowerCase(); const cuisine = url.searchParams.get("cuisine")?.trim().toLowerCase();
    if (fulfillment && !["delivery", "collection"].includes(fulfillment)) throw new HttpError(400, "VALIDATION_ERROR", "Fulfillment filter is invalid");
    let outcode = null;
    if (postcode) { const compact = postcode.trim().toUpperCase().replace(/\s+/g, ""); const matchPostcode = compact.match(/^([A-Z]{1,2}\d[A-Z\d]?)(?:\d[A-Z]{2})?$/); if (!matchPostcode) throw new HttpError(400, "VALIDATION_ERROR", "Postcode is invalid"); outcode = matchPostcode[1]; }
    const rows = db.prepare("SELECT * FROM restaurants WHERE status='approved' AND suspended=0 ORDER BY name").all().filter((row) => {
      if (fulfillment === "delivery" && (!row.delivery_enabled || (outcode && !JSON.parse(row.delivery_outcodes).includes(outcode)))) return false;
      if (fulfillment === "collection" && !row.collection_enabled) return false;
      if (q && !`${row.name} ${row.description} ${row.cuisine}`.toLowerCase().includes(q)) return false;
      if (cuisine && row.cuisine.toLowerCase() !== cuisine) return false;
      return true;
    });
    return sendJson(res, 200, { data: rows.map((row) => restaurantDto(row, { now: config.now() })) });
  }
  let match = url.pathname.match(/^\/api\/restaurants\/([^/]+)\/menu$/);
  if (req.method === "GET" && match) {
    const restaurant = db.prepare("SELECT * FROM restaurants WHERE id=? AND status='approved'").get(match[1]);
    if (!restaurant) throw new HttpError(404, "NOT_FOUND", "Resource not found");
    const items = db.prepare("SELECT * FROM menu_items WHERE restaurant_id=? AND available=1 ORDER BY sort_order,created_at,rowid").all(restaurant.id).map(itemDto);
    return sendJson(res, 200, { data: { restaurant: restaurantDto(restaurant, { now: config.now() }), items } });
  }
  if (req.method === "GET" && url.pathname === "/api/restaurant/restaurants") {
    const user = requireRole(session, "restaurant");
    const rows = db.prepare("SELECT r.*,m.permission FROM restaurants r JOIN restaurant_memberships m ON m.restaurant_id=r.id WHERE m.user_id=? ORDER BY r.created_at").all(user.id);
    return sendJson(res, 200, { data: rows.map((row) => restaurantDto(row, { privateDetails: true, now: config.now() })) });
  }
  if (req.method === "POST" && url.pathname === "/api/restaurant/restaurants") {
    const user = requireRole(session, "restaurant");
    if (db.prepare("SELECT 1 FROM restaurant_memberships WHERE user_id=? AND permission='staff'").get(user.id)) throw new HttpError(403, "OWNER_REQUIRED", "Staff cannot create restaurants");
    const body = await readJson(req, config.bodyLimit); exactObject(body, ["name"]);
    const now = config.now().toISOString();
    const restaurant = { id: randomUUID(), name: text(body.name, 1, VALIDATION.restaurantNameMax, "Restaurant name"), status: "pending", created_at: now, delivery_enabled: 0, delivery_outcodes: "[]", delivery_fee_minor: 0, min_delivery_subtotal_minor: 0 };
    withTransaction(db, () => {
      db.prepare("INSERT INTO restaurants(id,name,status,created_at) VALUES(?,?,?,?)").run(restaurant.id, restaurant.name, restaurant.status, now);
      db.prepare("INSERT INTO restaurant_memberships(restaurant_id,user_id,created_at,permission) VALUES(?,?,?,'owner')").run(restaurant.id, user.id, now);
      db.prepare("INSERT INTO contracts VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), restaurant.id, 700, 24, "demo-v1", 1, null, null, now);
    });
    return sendJson(res, 201, { data: restaurantDto(db.prepare("SELECT * FROM restaurants WHERE id=?").get(restaurant.id), { privateDetails: true, now: config.now() }) });
  }
  match = url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/menu$/);
  if (match && req.method === "GET") {
    requireRestaurantMembership(db, session, match[1]);
    const restaurant = db.prepare("SELECT * FROM restaurants WHERE id=?").get(match[1]);
    return sendJson(res, 200, { data: { restaurant: restaurantDto(restaurant, { privateDetails: true, now: config.now() }), items: db.prepare("SELECT * FROM menu_items WHERE restaurant_id=? ORDER BY sort_order,created_at,rowid").all(match[1]).map(itemDto) } });
  }
  if (match && req.method === "POST") {
    requireRestaurantOwner(db, session, match[1]);
    const body = await readJson(req, config.bodyLimit); exactObject(body, ["name", "description", "priceMinor", "category", "allergens", "dietaryTags", "modifierGroups"]);
    const now = config.now().toISOString();
    const item = { id: randomUUID(), restaurant_id: match[1], name: text(body.name, 1, VALIDATION.menuNameMax, "Item name"), description: text(body.description ?? "", 0, VALIDATION.descriptionMax, "Description"), price_minor: integer(body.priceMinor, 0, VALIDATION.priceMaxMinor, "Price"), available: 1, created_at: now, updated_at: now, category: text(body.category ?? "", 0, 80, "Category"), allergens: JSON.stringify(stringList(body.allergens ?? [], "Allergens")), dietary_tags: JSON.stringify(stringList(body.dietaryTags ?? [], "Dietary tags")), modifier_groups: JSON.stringify(validateModifierGroups(body.modifierGroups ?? [])), sort_order: db.prepare("SELECT COALESCE(MAX(sort_order),-1)+1 next FROM menu_items WHERE restaurant_id=?").get(match[1]).next };
    db.prepare("INSERT INTO menu_items(id,restaurant_id,name,description,price_minor,available,created_at,updated_at,category,allergens,dietary_tags,modifier_groups,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(...Object.values(item));
    return sendJson(res, 201, { data: itemDto(item) });
  }
  match = url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/menu\/([^/]+)$/);
  if (match && req.method === "PATCH") {
    requireRestaurantOwner(db, session, match[1]);
    const body = await readJson(req, config.bodyLimit); exactObject(body, ["name", "description", "priceMinor", "available", "category", "allergens", "dietaryTags", "modifierGroups"]);
    if (!Object.keys(body).length) throw new HttpError(400, "VALIDATION_ERROR", "At least one field is required");
    const current = db.prepare("SELECT * FROM menu_items WHERE id=? AND restaurant_id=?").get(match[2], match[1]);
    if (!current) throw new HttpError(404, "NOT_FOUND", "Resource not found");
    const updated = { ...current, name: body.name === undefined ? current.name : text(body.name, 1, VALIDATION.menuNameMax, "Item name"), description: body.description === undefined ? current.description : text(body.description, 0, VALIDATION.descriptionMax, "Description"), price_minor: body.priceMinor === undefined ? current.price_minor : integer(body.priceMinor, 0, VALIDATION.priceMaxMinor, "Price"), available: body.available === undefined ? current.available : Number(bool(body.available, "Available")), category: body.category === undefined ? current.category : text(body.category, 0, 80, "Category"), allergens: body.allergens === undefined ? current.allergens : JSON.stringify(stringList(body.allergens, "Allergens")), dietary_tags: body.dietaryTags === undefined ? current.dietary_tags : JSON.stringify(stringList(body.dietaryTags, "Dietary tags")), modifier_groups: body.modifierGroups === undefined ? current.modifier_groups : JSON.stringify(validateModifierGroups(body.modifierGroups)), updated_at: config.now().toISOString() };
    db.prepare("UPDATE menu_items SET name=?,description=?,price_minor=?,available=?,category=?,allergens=?,dietary_tags=?,modifier_groups=?,updated_at=? WHERE id=?").run(updated.name, updated.description, updated.price_minor, updated.available, updated.category, updated.allergens, updated.dietary_tags, updated.modifier_groups, updated.updated_at, updated.id);
    return sendJson(res, 200, { data: itemDto(updated) });
  }
  match = url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/delivery$/);
  if (match && req.method === "PATCH") {
    requireRestaurantOwner(db, session, match[1]);
    const body = await readJson(req, config.bodyLimit); exactObject(body, ["enabled", "outcodes", "deliveryFeeMinor", "minDeliverySubtotalMinor"]);
    if (!Array.isArray(body.outcodes) || body.outcodes.length > VALIDATION.deliveryOutcodesMax) throw new HttpError(400, "VALIDATION_ERROR", "Delivery outcodes are invalid");
    const outcodes = [...new Set(body.outcodes.map(normalizeOutcode))].sort();
    const enabled = bool(body.enabled, "Delivery enabled");
    if (enabled && !outcodes.length) throw new HttpError(400, "VALIDATION_ERROR", "Enabled delivery requires an outcode");
    const fee = integer(body.deliveryFeeMinor, 0, VALIDATION.priceMaxMinor, "Delivery fee");
    const minimum = integer(body.minDeliverySubtotalMinor, 0, VALIDATION.priceMaxMinor, "Delivery minimum");
    db.prepare("UPDATE restaurants SET delivery_enabled=?,delivery_outcodes=?,delivery_fee_minor=?,min_delivery_subtotal_minor=? WHERE id=?").run(Number(enabled), JSON.stringify(outcodes), fee, minimum, match[1]);
    return sendJson(res, 200, { data: restaurantDto(db.prepare("SELECT * FROM restaurants WHERE id=?").get(match[1]), { privateDetails: true, now: config.now() }) });
  }
  match = url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/profile$/);
  if (match && req.method === "PATCH") {
    requireRestaurantOwner(db, session, match[1]);
    const body = await readJson(req, config.bodyLimit); exactObject(body, ["name", "description", "cuisine", "phone", "address", "collectionEnabled", "cashEnabled", "paused", "busyMinutes", "estimatedDeliveryMinutes", "estimatedCollectionMinutes", "openingHours", "holidayDates", "alwaysOpen"]);
    const row = db.prepare("SELECT * FROM restaurants WHERE id=?").get(match[1]); if (!row) throw new HttpError(404, "NOT_FOUND", "Resource not found");
    const next = { name: body.name === undefined ? row.name : text(body.name, 1, VALIDATION.restaurantNameMax, "Restaurant name"), description: body.description === undefined ? row.description : text(body.description, 0, 500, "Description"), cuisine: body.cuisine === undefined ? row.cuisine : text(body.cuisine, 0, 80, "Cuisine"), phone: body.phone === undefined ? row.phone : text(body.phone, 0, 30, "Phone"), address: body.address === undefined ? row.address : text(body.address, 0, 250, "Address"), collection: body.collectionEnabled === undefined ? row.collection_enabled : Number(bool(body.collectionEnabled, "Collection enabled")), cash: body.cashEnabled === undefined ? row.cash_enabled : Number(bool(body.cashEnabled, "Cash enabled")), paused: body.paused === undefined ? row.paused : Number(bool(body.paused, "Paused")), busy: body.busyMinutes === undefined ? row.busy_minutes : integer(body.busyMinutes, 0, 240, "Busy minutes"), deliveryEstimate: body.estimatedDeliveryMinutes === undefined ? row.estimated_delivery_minutes : integer(body.estimatedDeliveryMinutes, 1, 240, "Delivery estimate"), collectionEstimate: body.estimatedCollectionMinutes === undefined ? row.estimated_collection_minutes : integer(body.estimatedCollectionMinutes, 1, 240, "Collection estimate"), hours: body.openingHours === undefined ? row.opening_hours : JSON.stringify(openingHours(body.openingHours)), holidays: body.holidayDates === undefined ? row.holiday_dates : JSON.stringify(dateList(body.holidayDates)), always: body.alwaysOpen === undefined ? row.always_open : Number(bool(body.alwaysOpen, "Always open")) };
    db.prepare("UPDATE restaurants SET name=?,description=?,cuisine=?,phone=?,address=?,collection_enabled=?,cash_enabled=?,paused=?,busy_minutes=?,estimated_delivery_minutes=?,estimated_collection_minutes=?,opening_hours=?,holiday_dates=?,always_open=? WHERE id=?").run(next.name, next.description, next.cuisine, next.phone, next.address, next.collection, next.cash, next.paused, next.busy, next.deliveryEstimate, next.collectionEstimate, next.hours, next.holidays, next.always, row.id);
    return sendJson(res, 200, { data: restaurantDto(db.prepare("SELECT * FROM restaurants WHERE id=?").get(row.id), { privateDetails: true, now: config.now() }) });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/restaurants") {
    requireRole(session, "admin");
    return sendJson(res, 200, { data: db.prepare("SELECT * FROM restaurants ORDER BY created_at").all().map((row) => restaurantDto(row, { privateDetails: true, now: config.now() })) });
  }
  match = url.pathname.match(/^\/api\/admin\/restaurants\/([^/]+)\/approval$/);
  if (match && req.method === "PATCH") {
    const user = requireRole(session, "admin");
    const body = await readJson(req, config.bodyLimit); exactObject(body, ["status"]);
    if (!["approved", "rejected"].includes(body.status)) throw new HttpError(400, "VALIDATION_ERROR", "Approval status is invalid");
    const restaurant = db.prepare("SELECT * FROM restaurants WHERE id=?").get(match[1]);
    if (!restaurant) throw new HttpError(404, "NOT_FOUND", "Resource not found");
    if (body.status === "approved" && restaurant.status !== "approved" && !restaurantReadiness(db, restaurant.id).ready) throw new HttpError(409, "RESTAURANT_NOT_READY", "Restaurant setup is incomplete");
    const now = config.now().toISOString();
    withTransaction(db, () => {
      db.prepare("UPDATE restaurants SET status=? WHERE id=?").run(body.status, restaurant.id);
      db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(), user.id, "restaurant", restaurant.id, "approval_changed", JSON.stringify({ from: restaurant.status, to: body.status }), now);
    });
    return sendJson(res, 200, { data: restaurantDto(db.prepare("SELECT * FROM restaurants WHERE id=?").get(restaurant.id), { privateDetails: true, now: config.now() }) });
  }
  match = url.pathname.match(/^\/api\/admin\/restaurants\/([^/]+)\/suspension$/);
  if (match && req.method === "PATCH") {
    const user = requireRole(session, "admin"); const body = await readJson(req, config.bodyLimit); exactObject(body, ["suspended", "reason"]); const suspended = bool(body.suspended, "Suspended"); const reason = text(body.reason, 1, 300, "Suspension reason"); const row = db.prepare("SELECT * FROM restaurants WHERE id=?").get(match[1]); if (!row) throw new HttpError(404, "NOT_FOUND", "Resource not found"); const now = config.now().toISOString();
    withTransaction(db, () => { db.prepare("UPDATE restaurants SET suspended=?,suspension_reason=? WHERE id=?").run(Number(suspended), suspended ? reason : "", row.id); db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(), user.id, "restaurant", row.id, "suspension_changed", JSON.stringify({ suspended, reason }), now); });
    return sendJson(res, 200, { data: restaurantDto(db.prepare("SELECT * FROM restaurants WHERE id=?").get(row.id), { privateDetails: true, now: config.now() }) });
  }
  if (req.method === "POST" && url.pathname === "/api/orders") return createOrder({ req, res, db, config, session });
  if (req.method === "GET" && url.pathname === "/api/orders") {
    const user = requireRole(session, "customer");
    return sendJson(res, 200, { data: db.prepare("SELECT * FROM orders WHERE customer_id=? ORDER BY created_at DESC").all(user.id).map((row) => orderDto(db, row)) });
  }
  match = url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/orders$/);
  if (match && req.method === "GET") {
    const member = requireRestaurantMembership(db, session, match[1]);
    const permission = db.prepare("SELECT permission FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?").get(match[1], member.id).permission;
    return sendJson(res, 200, { data: db.prepare("SELECT * FROM orders WHERE restaurant_id=? ORDER BY created_at DESC").all(match[1]).map((row) => orderDto(db, row, permission === "owner", permission === "owner")) });
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
    const printJobId = url.searchParams.get("printJobId");
    if (printJobId && !db.prepare("SELECT 1 FROM print_jobs WHERE id=? AND order_id=?").get(printJobId, access.row.id)) throw new HttpError(404, "NOT_FOUND", "Resource not found");
    const html = receiptHtml(orderDto(db, access.row, access.includeLedger, access.includeFinancial), printJobId);
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) }); res.end(html); return true;
  }
  match = url.pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (match && req.method === "GET") {
    const access = authorizedOrder(db, session, match[1]);
    return sendJson(res, 200, { data: orderDto(db, access.row, access.includeLedger, access.includeFinancial) });
  }
  return false;
}

async function createOrder({ req, res, db, config, session }) {
  const user = requireRole(session, "customer");
  const key = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"].trim() : "";
  if (!key || key.length > VALIDATION.idempotencyKeyMax) throw new HttpError(400, "VALIDATION_ERROR", "Idempotency-Key is required and invalid");
  const body = await readJson(req, config.bodyLimit);
  exactObject(body, ["restaurantId", "items", "paymentMethod", "fulfillment", "deliveryAddress", "customerPhone", "deliveryInstructions", "allergyNotes", "offerId"]);
  if (typeof body.restaurantId !== "string" || !Array.isArray(body.items) || !body.items.length || body.items.length > VALIDATION.orderItemsMax || !["mock_card", "cash"].includes(body.paymentMethod) || !["collection", "delivery"].includes(body.fulfillment)) throw new HttpError(400, "VALIDATION_ERROR", "Order is invalid");
  if (body.fulfillment === "collection" && body.deliveryAddress !== undefined) throw new HttpError(400, "VALIDATION_ERROR", "Collection orders cannot include a delivery address");
  const address = body.fulfillment === "delivery" ? normalizeAddress(body.deliveryAddress) : null;
  const normalizedItems = body.items.map((entry) => { exactObject(entry, ["menuItemId", "quantity", "modifiers"]); return { menuItemId: text(entry.menuItemId, 1, 100, "Menu item"), quantity: integer(entry.quantity, 1, VALIDATION.quantityMax, "Quantity"), modifiers: entry.modifiers ?? [] }; });
  if (new Set(normalizedItems.map((item) => item.menuItemId)).size !== normalizedItems.length) throw new HttpError(400, "VALIDATION_ERROR", "Duplicate menu items are not allowed");
  const customerPhone = body.customerPhone === undefined ? "" : text(body.customerPhone, 0, 30, "Customer phone");
  const deliveryInstructions = body.deliveryInstructions === undefined ? "" : text(body.deliveryInstructions, 0, 500, "Delivery instructions");
  const allergyNotes = body.allergyNotes === undefined ? "" : text(body.allergyNotes, 0, 500, "Allergy notes");
  if (body.fulfillment === "collection" && deliveryInstructions) throw new HttpError(400, "VALIDATION_ERROR", "Collection orders cannot include delivery instructions");
  const offerId = body.offerId === undefined ? null : text(body.offerId, 1, 100, "Offer");
  const canonicalBody = { restaurantId: body.restaurantId, items: normalizedItems, paymentMethod: body.paymentMethod, fulfillment: body.fulfillment, customerPhone, deliveryInstructions, allergyNotes, ...(offerId ? { offerId } : {}), ...(address ? { deliveryAddress: address } : {}) };
  const hash = requestHash(canonicalBody);
  const outcome = withTransaction(db, () => {
  const prior = db.prepare("SELECT * FROM orders WHERE customer_id=? AND idempotency_key=?").get(user.id, key);
  if (prior) {
    if (prior.request_hash !== hash) throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used for another request");
    return { replay: prior };
  }
  const restaurant = db.prepare("SELECT * FROM restaurants WHERE id=? AND status='approved'").get(body.restaurantId);
  if (!restaurant) throw new HttpError(404, "NOT_FOUND", "Resource not found");
  if (restaurant.suspended) throw new HttpError(409, "RESTAURANT_SUSPENDED", "Restaurant is suspended");
  const availability = restaurantAvailability(restaurant, config.now());
  if (!availability.acceptingOrders) throw new HttpError(409, "RESTAURANT_CLOSED", availability.closedReason);
  if (body.fulfillment === "collection" && !restaurant.collection_enabled) throw new HttpError(409, "COLLECTION_DISABLED", "Restaurant collection is disabled");
  if (body.paymentMethod === "cash" && !restaurant.cash_enabled) throw new HttpError(409, "CASH_DISABLED", "Restaurant is not accepting cash");
  const contract = db.prepare("SELECT * FROM contracts WHERE restaurant_id=? AND accepted_at IS NOT NULL").get(restaurant.id);
  if (!contract) throw new HttpError(409, "CONTRACT_NOT_ACCEPTED", "Local demo contract has not been accepted");
  const menu = normalizedItems.map((entry) => ({ entry, row: db.prepare("SELECT * FROM menu_items WHERE id=? AND restaurant_id=? AND available=1").get(entry.menuItemId, restaurant.id) }));
  if (menu.some(({ row }) => !row)) throw new HttpError(409, "MENU_UNAVAILABLE", "One or more menu items are unavailable");
  for (const line of menu) {
    const groups = JSON.parse(line.row.modifier_groups ?? "[]");
    if (!Array.isArray(line.entry.modifiers) || line.entry.modifiers.length > groups.length) throw new HttpError(400, "VALIDATION_ERROR", "Modifier selections are invalid");
    const supplied = new Map();
    for (const selection of line.entry.modifiers) { exactObject(selection, ["groupId", "optionIds"]); const groupId = shortId(selection.groupId, "Modifier group"); if (supplied.has(groupId) || !Array.isArray(selection.optionIds)) throw new HttpError(400, "VALIDATION_ERROR", "Modifier selections are invalid"); supplied.set(groupId, selection.optionIds); }
    line.selected = []; let extra = 0;
    for (const group of groups) {
      const optionIds = supplied.get(group.id) ?? [];
      if (new Set(optionIds).size !== optionIds.length || optionIds.length < group.minSelections || optionIds.length > group.maxSelections) throw new HttpError(409, "MODIFIER_SELECTION_INVALID", `Selections for ${group.name} are invalid`);
      for (const optionId of optionIds) { const option = group.options.find((candidate) => candidate.id === optionId); if (!option || !option.available) throw new HttpError(409, "MODIFIER_UNAVAILABLE", "A selected modifier is unavailable"); extra += option.priceMinor; line.selected.push({ groupId: group.id, groupName: group.name, optionId: option.id, name: option.name, priceMinor: option.priceMinor }); }
      supplied.delete(group.id);
    }
    if (supplied.size) throw new HttpError(400, "VALIDATION_ERROR", "Unknown modifier group");
    line.unitPrice = line.row.price_minor + extra;
  }
  const subtotal = menu.reduce((sum, { entry, unitPrice }) => sum + unitPrice * entry.quantity, 0);
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
  if (body.paymentMethod === "mock_card" && !authorizeMockPayment({ amountMinor: subtotal + fee }).ok) throw new HttpError(409, "PAYMENT_DECLINED", "Mock payment was declined");
  const deliveryAddress = address ? Object.fromEntries(Object.entries(address).filter(([key]) => key !== "outcode")) : null;
  const customer = db.prepare("SELECT * FROM users WHERE id=?").get(user.id);
  const marketplacePolicy = db.prepare("SELECT * FROM commission_policies WHERE restaurant_id=? AND accepted_at IS NOT NULL AND starts_at<=? AND ends_at>? ORDER BY created_at DESC LIMIT 1").get(restaurant.id, now, now);
  const rateBasisPoints = marketplacePolicy?.rate_bps ?? contract.rate_bps, commissionBase = marketplacePolicy?.commission_base ?? "food", commissionAmount = subtotal + (commissionBase === "food_plus_delivery" ? fee : 0);
  const order = { id: randomUUID(), restaurant_id: restaurant.id, restaurant_name: restaurant.name, customer_id: user.id, status: "placed", currency: "GBP", subtotal_minor: subtotal, delivery_fee_minor: fee, total_minor: subtotal + fee, delivery_address: deliveryAddress ? JSON.stringify(deliveryAddress) : null, commission_minor: calculateCommissionAtRate(commissionAmount, rateBasisPoints), payment_method: body.paymentMethod, payment_status: body.paymentMethod === "mock_card" ? "mock_authorized" : "cash_due", fulfillment: body.fulfillment, idempotency_key: key, request_hash: hash, created_at: now, updated_at: now, contract_rate_bps: rateBasisPoints, contract_policy_version: marketplacePolicy?.version ?? contract.policy_version, contract_demo_only: marketplacePolicy ? marketplacePolicy.development_assumption : contract.demo_only, customer_name: customer.name, customer_email: customer.email, customer_phone: customerPhone || customer.phone, delivery_instructions: deliveryInstructions, allergy_notes: allergyNotes, offer_grant_id: offerId, offer_snapshot: null, commission_base: commissionBase };
    let gift = null;
    if (offerId) {
      if (subtotal <= 0) throw new HttpError(409, "OFFER_REQUIRES_PURCHASE", "An offer requires a paid food item");
      const grant = db.prepare("SELECT g.*,c.title,c.menu_item_id,c.item_name,c.item_value_minor,c.min_subtotal_minor,c.expires_at FROM offer_grants g JOIN offer_campaigns c ON c.id=g.campaign_id WHERE g.id=? AND g.customer_id=? AND g.restaurant_id=?").get(offerId, user.id, restaurant.id);
      if (!grant) throw new HttpError(404, "NOT_FOUND", "Resource not found");
      if (grant.status !== "available") throw new HttpError(409, "OFFER_UNAVAILABLE", "Offer is no longer available");
      if (grant.expires_at <= now) throw new HttpError(409, "OFFER_EXPIRED", "Offer has expired");
      if (subtotal < grant.min_subtotal_minor) throw new HttpError(409, "OFFER_MINIMUM", "Order does not meet the offer minimum");
      gift = db.prepare("SELECT * FROM menu_items WHERE id=? AND restaurant_id=? AND available=1").get(grant.menu_item_id, restaurant.id);
      if (!gift || JSON.parse(gift.modifier_groups ?? "[]").some((group) => group.minSelections > 0)) throw new HttpError(409, "OFFER_ITEM_UNAVAILABLE", "Offer item is unavailable");
      order.offer_snapshot = JSON.stringify({ offerId: grant.id, title: grant.title, menuItemId: grant.menu_item_id, itemName: grant.item_name, itemValueMinor: grant.item_value_minor });
      gift.offerName = grant.item_name; gift.offerValue = grant.item_value_minor;
    }
    db.prepare("INSERT INTO orders(id,restaurant_id,restaurant_name,customer_id,status,currency,subtotal_minor,delivery_fee_minor,total_minor,delivery_address,commission_minor,payment_method,payment_status,fulfillment,idempotency_key,request_hash,created_at,updated_at,contract_rate_bps,contract_policy_version,contract_demo_only,customer_name,customer_email,customer_phone,delivery_instructions,allergy_notes,offer_grant_id,offer_snapshot,commission_base) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(...Object.values(order));
    if (offerId) { const reserved = db.prepare("UPDATE offer_grants SET status='reserved',reserved_order_id=?,updated_at=? WHERE id=? AND status='available'").run(order.id, now, offerId); if (reserved.changes !== 1) throw new HttpError(409, "OFFER_UNAVAILABLE", "Offer is no longer available"); }
    for (const { entry, row, selected, unitPrice } of menu) db.prepare("INSERT INTO order_items(id,order_id,menu_item_id,name,unit_price_minor,quantity,base_price_minor,selected_modifiers,allergens,category,is_offer_item) VALUES(?,?,?,?,?,?,?,?,?,?,0)").run(randomUUID(), order.id, row.id, row.name, unitPrice, entry.quantity, row.price_minor, JSON.stringify(selected), row.allergens, row.category);
    if (gift) db.prepare("INSERT INTO order_items(id,order_id,menu_item_id,name,unit_price_minor,quantity,base_price_minor,selected_modifiers,allergens,category,is_offer_item) VALUES(?,?,?,?,0,1,?,?,?,?,1)").run(randomUUID(), order.id, gift.id, gift.offerName, gift.offerValue, "[]", gift.allergens, gift.category);
    db.prepare("INSERT INTO order_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(), order.id, user.id, "status_changed", null, "placed", now);
    notifyNewOrder(db, order, now);
    return { order };
  });
  const stored = outcome.replay ?? outcome.order;
  return sendJson(res, outcome.replay ? 200 : 201, { data: orderDto(db, stored) });
}

async function updateStatus({ req, res, db, config, session, id }) {
  const user = requireRole(session, "restaurant");
  const body = await readJson(req, config.bodyLimit); exactObject(body, ["status"]);
  const result = withTransaction(db, () => {
    const order = db.prepare("SELECT * FROM orders WHERE id=?").get(id);
    const membership = order && db.prepare("SELECT permission FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?").get(order.restaurant_id, user.id);
    if (!order || !membership) throw new HttpError(404, "NOT_FOUND", "Resource not found");
    if (body.status === order.status) return { order, permission: membership.permission };
    const totals = db.prepare("SELECT COUNT(*) count,COALESCE(SUM(food_amount_minor),0) AS food,COALESCE(SUM(delivery_amount_minor),0) AS delivery FROM refunds WHERE order_id=?").get(order.id);
    if (totals.count > 0 && totals.food === order.subtotal_minor && totals.delivery === order.delivery_fee_minor) throw new HttpError(409, "ORDER_FULLY_REFUNDED", "Fully refunded orders cannot advance");
    const paths = order.fulfillment === "delivery" ? { placed: ["accepted", "rejected"], accepted: ["preparing"], preparing: ["ready"], ready: ["out_for_delivery"], out_for_delivery: ["completed"] } : { placed: ["accepted", "rejected"], accepted: ["preparing"], preparing: ["ready"], ready: ["completed"] };
    if (!paths[order.status]?.includes(body.status)) throw new HttpError(409, "INVALID_TRANSITION", "Order status transition is not allowed");
    if (order.status === "placed" && body.status === "accepted" && !db.prepare("SELECT 1 FROM restaurants WHERE id=? AND status='approved' AND suspended=0").get(order.restaurant_id)) throw new HttpError(409, "RESTAURANT_UNAVAILABLE", "Restaurant is not approved or is suspended");
    const now = config.now().toISOString();
    let paymentStatus = order.payment_status;
    if (body.status === "accepted" && order.payment_method === "mock_card") {
      const capture = (config.mockCapture ?? captureMockPayment)({ amountMinor: order.total_minor });
      if (!capture?.ok) throw new HttpError(409, "PAYMENT_CAPTURE_FAILED", "Mock payment capture failed");
      paymentStatus = "mock_captured";
    }
    if (body.status === "rejected") paymentStatus = order.payment_method === "mock_card" ? "mock_cancelled" : "cash_cancelled";
    if (body.status === "completed" && order.payment_method === "cash") paymentStatus = "cash_collected";
    db.prepare("UPDATE orders SET status=?,payment_status=?,updated_at=? WHERE id=?").run(body.status, paymentStatus, now, order.id);
    db.prepare("INSERT INTO order_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(), order.id, user.id, "status_changed", order.status, body.status, now);
    if (body.status === "rejected") releaseOfferForOrder(db, order, now);
    if (body.status === "completed") redeemOfferForOrder(db, order, now);
    notifyOrderStatus(db, order, body.status, now);
    if (body.status === "accepted") {
      const kind = order.payment_method === "mock_card" ? "commission_mock" : "commission_cash_receivable";
      db.prepare("INSERT OR IGNORE INTO ledger_entries(id,order_id,restaurant_id,kind,amount_minor,currency,reference_type,reference_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), order.id, order.restaurant_id, kind, order.commission_minor, order.currency, "order", order.id, now);
      recordMarketplaceAcceptance(db, db.prepare("SELECT * FROM orders WHERE id=?").get(order.id), now);
    }
    if (body.status === "completed") recordMarketplaceCompletion(db, db.prepare("SELECT * FROM orders WHERE id=?").get(order.id), now);
    return { order: db.prepare("SELECT * FROM orders WHERE id=?").get(order.id), permission: membership.permission };
  });
  return sendJson(res, 200, { data: orderDto(db, result.order, result.permission === "owner", result.permission === "owner") });
}
