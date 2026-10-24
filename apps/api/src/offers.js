import { createHash, randomUUID } from "node:crypto";
import { requireRestaurantOwner, requireRole, requireUser } from "./auth/authorization.js";
import { withTransaction } from "./db/index.js";
import { HttpError, exactObject, readJson, sendJson } from "./http.js";

const clean = (value, min, max, label) => {
  const result = typeof value === "string" ? value.trim() : "";
  if (result.length < min || result.length > max) throw new HttpError(400, "VALIDATION_ERROR", `${label} is invalid`);
  return result;
};
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const fingerprint = (value) => createHash("sha256").update(canonical(value)).digest("hex");

export function addNotification(db, { userId, type, title, message, orderId = null, offerId = null, restaurantId = null, eventKey, now }) {
  db.prepare("INSERT OR IGNORE INTO user_notifications(id,user_id,type,title,message,order_id,offer_id,restaurant_id,event_key,created_at,read_at) VALUES(?,?,?,?,?,?,?,?,?,?,NULL)").run(randomUUID(), userId, type, title, message, orderId, offerId, restaurantId, eventKey, now);
}

export function notifyNewOrder(db, order, now) {
  for (const member of db.prepare("SELECT user_id FROM restaurant_memberships WHERE restaurant_id=?").all(order.restaurant_id)) addNotification(db, { userId: member.user_id, type: "new_order", title: "New order", message: `New ${order.fulfillment} order from ${order.customer_name}`, orderId: order.id, restaurantId: order.restaurant_id, eventKey: `order:${order.id}:new`, now });
}

export function notifyOrderStatus(db, order, status, now, type = "order_status", eventSuffix = "") {
  const labels = { accepted: "accepted", preparing: "being prepared", ready: "ready", out_for_delivery: "out for delivery", completed: "completed", rejected: "rejected", refunded: "refunded" };
  addNotification(db, { userId: order.customer_id, type, title: status === "refunded" ? "Order refund recorded" : "Order update", message: status === "refunded" ? "A refund was recorded for your order" : `Your order is ${labels[status] ?? status}`, orderId: order.id, restaurantId: order.restaurant_id, eventKey: `order:${order.id}:${status}${eventSuffix}`, now });
}

export function releaseOfferForOrder(db, order, now) {
  if (!order.offer_grant_id) return;
  const grant = db.prepare("SELECT g.*,c.expires_at FROM offer_grants g JOIN offer_campaigns c ON c.id=g.campaign_id WHERE g.id=?").get(order.offer_grant_id);
  if (!grant || grant.status !== "reserved" || grant.reserved_order_id !== order.id) return;
  const status = grant.expires_at <= now ? "expired" : "available";
  db.prepare("UPDATE offer_grants SET status=?,reserved_order_id=NULL,updated_at=? WHERE id=? AND status='reserved' AND reserved_order_id=?").run(status, now, grant.id, order.id);
}

export function redeemOfferForOrder(db, order, now) {
  if (!order.offer_grant_id) return;
  db.prepare("UPDATE offer_grants SET status='redeemed',redeemed_order_id=?,updated_at=? WHERE id=? AND status='reserved' AND reserved_order_id=?").run(order.id, now, order.offer_grant_id, order.id);
}

function notificationDto(row) {
  return { id: row.id, type: row.type, title: row.title, message: row.message, ...(row.order_id ? { orderId: row.order_id } : {}), ...(row.offer_id ? { offerId: row.offer_id } : {}), ...(row.restaurant_id ? { restaurantId: row.restaurant_id } : {}), createdAt: row.created_at, readAt: row.read_at };
}
function campaignDto(db, row) {
  const counts = db.prepare("SELECT COUNT(*) recipientCount,SUM(viewed_at IS NOT NULL) openedCount,SUM(status='reserved') reservedCount,SUM(status='redeemed') redeemedCount FROM offer_grants WHERE campaign_id=?").get(row.id);
  return { id: row.id, title: row.title, message: row.message, menuItemId: row.menu_item_id, itemName: row.item_name, itemValueMinor: row.item_value_minor, minSubtotalMinor: row.min_subtotal_minor, expiresAt: row.expires_at, createdAt: row.created_at, recipientCount: counts.recipientCount, openedCount: counts.openedCount, reservedCount: counts.reservedCount, redeemedCount: counts.redeemedCount };
}
function grantDto(row, now) {
  const effectiveStatus = row.status === "available" && row.expires_at <= now ? "expired" : row.status;
  return { id: row.id, campaignId: row.campaign_id, restaurantId: row.restaurant_id, restaurantName: row.restaurant_name, title: row.title, message: row.message, menuItemId: row.menu_item_id, itemName: row.item_name, itemValueMinor: row.item_value_minor, minSubtotalMinor: row.min_subtotal_minor, expiresAt: row.expires_at, status: effectiveStatus, viewedAt: row.viewed_at };
}

export async function routeOffers({ req, res, url, db, config, session }) {
  if (req.method === "GET" && url.pathname === "/api/notifications") {
    const user = requireUser(session); const rows = db.prepare("SELECT * FROM user_notifications WHERE user_id=? ORDER BY created_at DESC,rowid DESC").all(user.id);
    return sendJson(res, 200, { data: { items: rows.map(notificationDto), unreadCount: rows.filter((row) => !row.read_at).length } });
  }
  let match = url.pathname.match(/^\/api\/notifications\/([^/]+)$/);
  if (match && req.method === "PATCH") {
    const user = requireUser(session); const body = await readJson(req, config.bodyLimit); exactObject(body, ["read"]);
    if (body.read !== true) throw new HttpError(400, "VALIDATION_ERROR", "read must be true");
    const row = db.prepare("SELECT * FROM user_notifications WHERE id=? AND user_id=?").get(match[1], user.id); if (!row) throw new HttpError(404, "NOT_FOUND", "Resource not found");
    db.prepare("UPDATE user_notifications SET read_at=COALESCE(read_at,?) WHERE id=?").run(config.now().toISOString(), row.id);
    return sendJson(res, 200, { data: notificationDto(db.prepare("SELECT * FROM user_notifications WHERE id=?").get(row.id)) });
  }
  match = url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/customers$/);
  if (match && req.method === "GET") {
    requireRestaurantOwner(db, session, match[1]);
    const rows = db.prepare("SELECT o.customer_id,u.name,u.merchant_offers,COUNT(*) completed_order_count,SUM(o.total_minor-COALESCE(x.refunded,0)) net_spend_minor,MAX(o.created_at) last_order_at FROM orders o JOIN users u ON u.id=o.customer_id LEFT JOIN (SELECT order_id,SUM(food_amount_minor+delivery_amount_minor) refunded FROM refunds GROUP BY order_id) x ON x.order_id=o.id WHERE o.restaurant_id=? AND o.status='completed' GROUP BY o.customer_id,u.name,u.merchant_offers ORDER BY last_order_at DESC").all(match[1]);
    return sendJson(res, 200, { data: rows.map((row) => ({ customerId: row.customer_id, name: row.name, merchantOffers: Boolean(row.merchant_offers), completedOrderCount: row.completed_order_count, netSpendMinor: row.net_spend_minor, averageOrderMinor: Math.round(row.net_spend_minor / row.completed_order_count), lastOrderAt: row.last_order_at })) });
  }
  match = url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/offers$/);
  if (match && req.method === "GET") { requireRestaurantOwner(db, session, match[1]); return sendJson(res, 200, { data: db.prepare("SELECT * FROM offer_campaigns WHERE restaurant_id=? ORDER BY created_at DESC").all(match[1]).map((row) => campaignDto(db, row)) }); }
  if (match && req.method === "POST") return createCampaign({ req, res, db, config, session, restaurantId: match[1] });
  if (req.method === "GET" && url.pathname === "/api/offers") {
    const user = requireRole(session, "customer"); const restaurantId = url.searchParams.get("restaurantId");
    const rows = db.prepare(`SELECT g.*,c.title,c.message,c.menu_item_id,c.item_name,c.item_value_minor,c.min_subtotal_minor,c.expires_at,r.name restaurant_name FROM offer_grants g JOIN offer_campaigns c ON c.id=g.campaign_id JOIN restaurants r ON r.id=g.restaurant_id WHERE g.customer_id=? ${restaurantId ? "AND g.restaurant_id=?" : ""} ORDER BY g.created_at DESC`).all(...(restaurantId ? [user.id, restaurantId] : [user.id]));
    return sendJson(res, 200, { data: rows.map((row) => grantDto(row, config.now().toISOString())) });
  }
  match = url.pathname.match(/^\/api\/offers\/([^/]+)$/);
  if (match && req.method === "PATCH") {
    const user = requireRole(session, "customer"); const body = await readJson(req, config.bodyLimit); exactObject(body, ["viewed"]); if (body.viewed !== true) throw new HttpError(400, "VALIDATION_ERROR", "viewed must be true");
    const row = db.prepare("SELECT * FROM offer_grants WHERE id=? AND customer_id=?").get(match[1], user.id); if (!row) throw new HttpError(404, "NOT_FOUND", "Resource not found");
    db.prepare("UPDATE offer_grants SET viewed_at=COALESCE(viewed_at,?),updated_at=? WHERE id=?").run(config.now().toISOString(), config.now().toISOString(), row.id);
    const joined = db.prepare("SELECT g.*,c.title,c.message,c.menu_item_id,c.item_name,c.item_value_minor,c.min_subtotal_minor,c.expires_at,r.name restaurant_name FROM offer_grants g JOIN offer_campaigns c ON c.id=g.campaign_id JOIN restaurants r ON r.id=g.restaurant_id WHERE g.id=?").get(row.id);
    return sendJson(res, 200, { data: grantDto(joined, config.now().toISOString()) });
  }
  return false;
}

async function createCampaign({ req, res, db, config, session, restaurantId }) {
  const user = requireRestaurantOwner(db, session, restaurantId); const key = clean(req.headers["idempotency-key"], 1, 100, "Idempotency-Key");
  const body = await readJson(req, config.bodyLimit); exactObject(body, ["customerIds", "title", "message", "menuItemId", "minSubtotalMinor", "expiresInDays"]);
  if (!Array.isArray(body.customerIds) || body.customerIds.length < 1 || body.customerIds.length > 100 || new Set(body.customerIds).size !== body.customerIds.length || body.customerIds.some((id) => typeof id !== "string" || !id)) throw new HttpError(400, "VALIDATION_ERROR", "Recipients are invalid");
  if (!Number.isSafeInteger(body.minSubtotalMinor) || body.minSubtotalMinor < 0 || body.minSubtotalMinor > 100000 || !Number.isInteger(body.expiresInDays) || body.expiresInDays < 1 || body.expiresInDays > 90) throw new HttpError(400, "VALIDATION_ERROR", "Offer terms are invalid");
  const normalized = { customerIds: [...body.customerIds].sort(), title: clean(body.title, 1, 80, "Title"), message: clean(body.message, 1, 500, "Message"), menuItemId: clean(body.menuItemId, 1, 100, "Menu item"), minSubtotalMinor: body.minSubtotalMinor, expiresInDays: body.expiresInDays };
  const hash = fingerprint({ restaurantId, ...normalized }); const prior = db.prepare("SELECT * FROM offer_campaigns WHERE created_by_user_id=? AND idempotency_key=?").get(user.id, key);
  if (prior) { if (prior.request_hash !== hash) throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used for another request"); return sendJson(res, 200, { data: campaignDto(db, prior) }); }
  const created = withTransaction(db, () => {
    const existing = db.prepare("SELECT * FROM offer_campaigns WHERE created_by_user_id=? AND idempotency_key=?").get(user.id, key);
    if (existing) { if (existing.request_hash !== hash) throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used for another request"); return { row: existing, replay: true }; }
    const item = db.prepare("SELECT * FROM menu_items WHERE id=? AND restaurant_id=? AND available=1").get(normalized.menuItemId, restaurantId);
    if (!item) throw new HttpError(409, "MENU_UNAVAILABLE", "Offer item is unavailable");
    if (JSON.parse(item.modifier_groups ?? "[]").some((group) => group.minSelections > 0)) throw new HttpError(409, "OFFER_ITEM_REQUIRES_MODIFIERS", "Offer item cannot require modifiers");
    const eligible = new Set(db.prepare(`SELECT DISTINCT o.customer_id FROM orders o JOIN users u ON u.id=o.customer_id WHERE o.restaurant_id=? AND o.status='completed' AND u.merchant_offers=1 AND o.customer_id IN (${normalized.customerIds.map(() => "?").join(",")})`).all(restaurantId, ...normalized.customerIds).map((row) => row.customer_id));
    if (eligible.size !== normalized.customerIds.length) throw new HttpError(409, "RECIPIENT_NOT_ELIGIBLE", "Every recipient must allow offers and have a completed order at this restaurant");
    const nowDate = config.now(); const now = nowDate.toISOString(); const id = randomUUID(); const expiresAt = new Date(nowDate.getTime() + normalized.expiresInDays * 86400000).toISOString();
    db.prepare("INSERT INTO offer_campaigns VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, restaurantId, user.id, key, hash, normalized.title, normalized.message, item.id, item.name, item.price_minor, normalized.minSubtotalMinor, expiresAt, now);
    for (const customerId of normalized.customerIds) { const grantId = randomUUID(); db.prepare("INSERT INTO offer_grants VALUES(?,?,?,?,?,?,?,?,?,?)").run(grantId, id, restaurantId, customerId, "available", null, null, null, now, now); addNotification(db, { userId: customerId, type: "offer", title: normalized.title, message: normalized.message, offerId: grantId, restaurantId, eventKey: `offer:${grantId}:issued`, now }); }
    db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(), user.id, "offer_campaign", id, "offer_campaign_created", JSON.stringify({ recipientCount: normalized.customerIds.length }), now);
    return { row: db.prepare("SELECT * FROM offer_campaigns WHERE id=?").get(id), replay: false };
  });
  return sendJson(res, created.replay ? 200 : 201, { data: campaignDto(db, created.row) });
}
