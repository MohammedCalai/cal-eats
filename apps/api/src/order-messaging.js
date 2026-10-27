import { randomUUID } from "node:crypto";
import { requireRestaurantMembership, requireRestaurantOwner, requireUser } from "./auth/authorization.js";
import { withTransaction } from "./db/index.js";
import { HttpError, exactObject, readJson, sendJson } from "./http.js";
import { decryptMessage, encryptMessage, messageFingerprint } from "./message-encryption.js";
import { notificationStreamHub } from "./notification-stream.js";

export const DEFAULT_QUICK_RESPONSES = ["We’re preparing your order now.", "Sorry for the delay, we’re very busy.", "Your order will be ready shortly.", "Your driver is on the way.", "Your order is ready for collection.", "Thank you for ordering."];
const ACTIVE = new Set(["placed", "accepted", "preparing", "ready", "out_for_delivery"]);
const RETENTION_MS = 30 * 86400_000;
const MAX_SUPPORT_MINUTES = 1440;

const nowIso = (config) => config.now().toISOString();
const clean = (value, min, max, label) => { const text = typeof value === "string" ? value.trim() : ""; if (text.length < min || text.length > max) throw new HttpError(400, "VALIDATION_ERROR", `${label} is invalid`); return text; };
const supportMinutes = (config, row) => Math.min(MAX_SUPPORT_MINUTES, Math.max(0, row?.support_window_minutes ?? ((config.messagingSupportHours ?? 2) * 60)));

function settings(db, restaurantId, config) {
  const row = db.prepare("SELECT * FROM order_message_settings WHERE restaurant_id=?").get(restaurantId);
  return { quickResponses: row ? JSON.parse(row.quick_responses) : DEFAULT_QUICK_RESPONSES, supportWindowMinutes: supportMinutes(config, row), updatedAt: row?.updated_at ?? null };
}

function terminalAt(db, order) {
  return db.prepare("SELECT created_at FROM order_events WHERE order_id=? AND to_status IN ('completed','rejected') ORDER BY created_at DESC LIMIT 1").get(order.id)?.created_at ?? order.updated_at;
}

function availability(db, order, config) {
  if (ACTIVE.has(order.status)) return { open: true, closesAt: null };
  const minutes = settings(db, order.restaurant_id, config).supportWindowMinutes;
  const closesAt = new Date(Date.parse(terminalAt(db, order)) + minutes * 60_000).toISOString();
  return { open: config.now().getTime() < Date.parse(closesAt), closesAt };
}

export function orderMessageWindow(db, order, config) {
  const state = availability(db, order, config);
  return { messagingAvailable: state.open, messagingClosesAt: state.closesAt };
}

function access(db, session, orderId, { adminReason } = {}) {
  const user = requireUser(session); const order = db.prepare("SELECT * FROM orders WHERE id=?").get(orderId);
  if (!order) throw new HttpError(404, "NOT_FOUND", "Resource not found");
  if (user.role === "customer" && order.customer_id === user.id) return { user, order, role: "customer" };
  if (user.role === "restaurant" && db.prepare("SELECT 1 FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?").get(order.restaurant_id, user.id)) return { user, order, role: "restaurant" };
  if (user.role === "admin") {
    const reason = clean(adminReason, 10, 300, "Admin access reason");
    return { user, order, role: "admin", adminReason: reason };
  }
  throw new HttpError(404, "NOT_FOUND", "Resource not found");
}

function unreadCount(db, orderId, userId, now) {
  const cursor = db.prepare("SELECT * FROM order_message_reads WHERE order_id=? AND user_id=?").get(orderId, userId);
  if (!cursor) return db.prepare("SELECT COUNT(*) count FROM order_messages WHERE order_id=? AND sender_user_id<>? AND expires_at>?").get(orderId, userId, now).count;
  return db.prepare("SELECT COUNT(*) count FROM order_messages WHERE order_id=? AND sender_user_id<>? AND expires_at>? AND (created_at>? OR (created_at=? AND id>?))").get(orderId, userId, now, cursor.last_read_created_at, cursor.last_read_created_at, cursor.last_read_message_id).count;
}

async function dto(config, row) { return { id: row.id, orderId: row.order_id, senderUserId: row.sender_user_id, senderRole: row.sender_role, message: await decryptMessage(config, row), createdAt: row.created_at, expiresAt: row.expires_at }; }
function incidentDto(row) { return { id: row.id, orderId: row.order_id, reporterUserId: row.reporter_user_id, reporterRole: row.reporter_role, reason: row.reason, status: row.status, adminNote: row.admin_note, reviewedByUserId: row.reviewed_by_user_id, createdAt: row.created_at, updatedAt: row.updated_at }; }

function notifyRecipients(db, order, senderId, messageId, now) {
  const recipients = new Set([order.customer_id, ...db.prepare("SELECT user_id FROM restaurant_memberships WHERE restaurant_id=?").all(order.restaurant_id).map((x) => x.user_id)]);
  recipients.delete(senderId);
  for (const userId of recipients) db.prepare("INSERT OR IGNORE INTO user_notifications(id,user_id,type,title,message,order_id,offer_id,restaurant_id,event_key,created_at,read_at) VALUES(?,?,?,?,?,?,NULL,?,?,?,NULL)").run(randomUUID(), userId, "order_message", "New order message", "You have a new message about your order.", order.id, order.restaurant_id, `order-message:${messageId}`, now);
}

function auditAdminRead(db, actorId, orderId, reason, now) {
  db.prepare("INSERT INTO audit_events(id,actor_user_id,entity_type,entity_id,action,details,created_at) VALUES(?,?,?,?,?,?,?)").run(randomUUID(), actorId, "order_messages", orderId, "message_content_accessed", JSON.stringify({ reason }), now);
}

export function runMessageRetention(db, config) {
  const cutoff = new Date(config.now().getTime() - RETENTION_MS).toISOString();
  return withTransaction(db, () => {
    const result = db.prepare("DELETE FROM order_messages WHERE expires_at<=? OR created_at<=?").run(nowIso(config), cutoff);
    db.prepare("DELETE FROM order_message_rate_limits WHERE window_start_ms<=?").run(config.now().getTime() - 60_000);
    return result.changes;
  });
}

export async function routeOrderMessaging({ req, res, url, db, config, session }) {
  if (req.method === "GET" && url.pathname === "/api/notifications/stream") {
    const user = requireUser(session);
    return notificationStreamHub(db, { ...config.notificationStream, now: config.now }).subscribe({ req, res, userId: user.id, sessionId: session.sessionId, native: Boolean(session.native), lastEventId: req.headers["last-event-id"] ?? url.searchParams.get("lastEventId") });
  }
  let match = url.pathname.match(/^\/api\/orders\/([^/]+)\/message-incidents$/);
  if (match && req.method === "POST") {
    const granted = access(db, session, match[1]); if (granted.role === "admin") throw new HttpError(403, "FORBIDDEN", "Administrators cannot report participant incidents");
    const body = await readJson(req, config.bodyLimit); exactObject(body, ["reason"]); const reason = clean(body.reason, 1, 300, "Reason"); const now = nowIso(config); const since = new Date(config.now().getTime() - 3600_000).toISOString();
    const duplicate = db.prepare("SELECT * FROM order_message_incidents WHERE order_id=? AND reporter_user_id=? AND reason=? AND status<>'resolved' ORDER BY created_at DESC LIMIT 1").get(granted.order.id, granted.user.id, reason);
    if (duplicate) return sendJson(res, 200, { data: incidentDto(duplicate) });
    if (db.prepare("SELECT COUNT(*) count FROM order_message_incidents WHERE order_id=? AND reporter_user_id=? AND created_at>?").get(granted.order.id, granted.user.id, since).count >= 3) throw new HttpError(429, "INCIDENT_RATE_LIMITED", "Please wait before sending another report");
    const id = randomUUID(); db.prepare("INSERT INTO order_message_incidents(id,order_id,reporter_user_id,reporter_role,reason,status,admin_note,reviewed_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,'reported','',NULL,?,?)").run(id, granted.order.id, granted.user.id, granted.role, reason, now, now);
    return sendJson(res, 201, { data: incidentDto(db.prepare("SELECT * FROM order_message_incidents WHERE id=?").get(id)) });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/message-incidents") {
    const user = requireUser(session); if (user.role !== "admin") throw new HttpError(403, "FORBIDDEN", "Forbidden"); const status = url.searchParams.get("status"); if (status && !["reported", "under_review", "resolved"].includes(status)) throw new HttpError(400, "VALIDATION_ERROR", "Incident status is invalid");
    const rows = status ? db.prepare("SELECT * FROM order_message_incidents WHERE status=? ORDER BY created_at DESC").all(status) : db.prepare("SELECT * FROM order_message_incidents ORDER BY created_at DESC").all(); return sendJson(res, 200, { data: rows.map(incidentDto) });
  }
  match = url.pathname.match(/^\/api\/admin\/message-incidents\/([^/]+)$/);
  if (match && req.method === "PATCH") {
    const user = requireUser(session); if (user.role !== "admin") throw new HttpError(403, "FORBIDDEN", "Forbidden"); const body = await readJson(req, config.bodyLimit); exactObject(body, ["status", "note"]); if (!["under_review", "resolved"].includes(body.status)) throw new HttpError(400, "VALIDATION_ERROR", "Incident status is invalid"); const note = clean(body.note, 1, 300, "Admin note"); const row = db.prepare("SELECT * FROM order_message_incidents WHERE id=?").get(match[1]); if (!row) throw new HttpError(404, "NOT_FOUND", "Resource not found"); const now = nowIso(config);
    withTransaction(db, () => { db.prepare("UPDATE order_message_incidents SET status=?,admin_note=?,reviewed_by_user_id=?,updated_at=? WHERE id=?").run(body.status, note, user.id, now, row.id); db.prepare("INSERT INTO audit_events(id,actor_user_id,entity_type,entity_id,action,details,created_at) VALUES(?,?,?,?,?,?,?)").run(randomUUID(), user.id, "order_message_incident", row.id, "message_incident_status_changed", JSON.stringify({ fromStatus: row.status, toStatus: body.status, note }), now); });
    return sendJson(res, 200, { data: incidentDto(db.prepare("SELECT * FROM order_message_incidents WHERE id=?").get(row.id)) });
  }
  match = url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/message-settings$/);
  if (match && req.method === "GET") { requireRestaurantMembership(db, session, match[1]); return sendJson(res, 200, { data: settings(db, match[1], config) }); }
  if (match && req.method === "PATCH") {
    const user = requireRestaurantOwner(db, session, match[1]); const body = await readJson(req, config.bodyLimit); exactObject(body, ["quickResponses", "supportWindowMinutes"]);
    if (!Array.isArray(body.quickResponses) || body.quickResponses.length !== 6) throw new HttpError(400, "VALIDATION_ERROR", "Six quick responses are required");
    const quick = body.quickResponses.map((x) => clean(x, 1, 120, "Quick response"));
    if (!Number.isInteger(body.supportWindowMinutes) || body.supportWindowMinutes < 0 || body.supportWindowMinutes > MAX_SUPPORT_MINUTES) throw new HttpError(400, "VALIDATION_ERROR", "Support window is invalid");
    const now = nowIso(config); db.prepare("INSERT INTO order_message_settings(restaurant_id,quick_responses,support_window_minutes,updated_by_user_id,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(restaurant_id) DO UPDATE SET quick_responses=excluded.quick_responses,support_window_minutes=excluded.support_window_minutes,updated_by_user_id=excluded.updated_by_user_id,updated_at=excluded.updated_at").run(match[1], JSON.stringify(quick), body.supportWindowMinutes, user.id, now);
    return sendJson(res, 200, { data: settings(db, match[1], config) });
  }
  match = url.pathname.match(/^\/api\/orders\/([^/]+)\/messages\/read$/);
  if (match && ["POST", "PUT", "PATCH"].includes(req.method)) {
    const granted = access(db, session, match[1]); const body = await readJson(req, config.bodyLimit); exactObject(body, ["lastMessageId"]); const id = clean(body.lastMessageId, 1, 100, "Message");
    if (!availability(db, granted.order, config).open) throw new HttpError(410, "MESSAGING_CLOSED", "This order conversation is closed");
    const row = db.prepare("SELECT * FROM order_messages WHERE id=? AND order_id=? AND expires_at>?").get(id, granted.order.id, nowIso(config)); if (!row) throw new HttpError(404, "NOT_FOUND", "Resource not found");
    const prior = db.prepare("SELECT * FROM order_message_reads WHERE order_id=? AND user_id=?").get(granted.order.id, granted.user.id);
    if (!prior || row.created_at > prior.last_read_created_at || (row.created_at === prior.last_read_created_at && row.id > prior.last_read_message_id)) {
      const readAt = nowIso(config); withTransaction(db, () => {
        db.prepare("INSERT INTO order_message_reads VALUES(?,?,?,?,?) ON CONFLICT(order_id,user_id) DO UPDATE SET last_read_created_at=excluded.last_read_created_at,last_read_message_id=excluded.last_read_message_id,updated_at=excluded.updated_at").run(granted.order.id, granted.user.id, row.created_at, row.id, readAt);
        db.prepare("UPDATE user_notifications SET read_at=? WHERE user_id=? AND order_id=? AND type='order_message' AND read_at IS NULL AND event_key IN (SELECT 'order-message:'||id FROM order_messages WHERE order_id=? AND (created_at<? OR (created_at=? AND id<=?)))").run(readAt, granted.user.id, granted.order.id, granted.order.id, row.created_at, row.created_at, row.id);
      });
    }
    return sendJson(res, 200, { data: { orderId: granted.order.id, lastMessageId: id, unreadCount: unreadCount(db, granted.order.id, granted.user.id, nowIso(config)) } });
  }
  match = url.pathname.match(/^\/api\/orders\/([^/]+)\/messages$/);
  if (!match) return false;
  if (req.method === "GET") {
    const granted = access(db, session, match[1], { adminReason: url.searchParams.get("reason") }); const state = availability(db, granted.order, config);
    if (!state.open && granted.role !== "admin") throw new HttpError(410, "MESSAGING_CLOSED", "This order conversation is closed");
    const rawLimit = url.searchParams.get("limit"); const parsedLimit = rawLimit === null ? 50 : Number(rawLimit); if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) throw new HttpError(400, "VALIDATION_ERROR", "Message limit is invalid"); const limit = parsedLimit; const before = url.searchParams.get("before"); const now = nowIso(config);
    const rows = before ? db.prepare("SELECT * FROM order_messages WHERE order_id=? AND expires_at>? AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?").all(granted.order.id, now, before, before, url.searchParams.get("beforeId") ?? "~", limit) : db.prepare("SELECT * FROM order_messages WHERE order_id=? AND expires_at>? ORDER BY created_at DESC,id DESC LIMIT ?").all(granted.order.id, now, limit);
    if (granted.role === "admin") auditAdminRead(db, granted.user.id, granted.order.id, granted.adminReason, now);
    const items = []; for (const row of rows.reverse()) items.push(await dto(config, row));
    return sendJson(res, 200, { data: { items, unreadCount: unreadCount(db, granted.order.id, granted.user.id, now), isOpen: state.open, closedAt: state.closesAt, restaurantPhone: granted.role === "customer" ? (db.prepare("SELECT phone FROM restaurants WHERE id=?").get(granted.order.restaurant_id)?.phone || null) : null, quickResponses: granted.role === "restaurant" ? settings(db, granted.order.restaurant_id, config).quickResponses : [], nextCursor: rows.length === limit ? { before: rows[0].created_at, beforeId: rows[0].id } : null } });
  }
  if (req.method === "POST") {
    const granted = access(db, session, match[1]); if (granted.role === "admin") throw new HttpError(403, "FORBIDDEN", "Administrators cannot send order messages");
    if (!availability(db, granted.order, config).open) throw new HttpError(410, "MESSAGING_CLOSED", "This order conversation is closed");
    const body = await readJson(req, config.bodyLimit); exactObject(body, ["message", "clientMessageId"]); const key = clean(req.headers["idempotency-key"] ?? body.clientMessageId, 1, 100, "Idempotency-Key"); const message = clean(body.message, 1, 300, "Message");
    const hash = messageFingerprint(config, granted.order.id, message); const prior = db.prepare("SELECT * FROM order_messages WHERE sender_user_id=? AND order_id=? AND idempotency_key=?").get(granted.user.id, granted.order.id, key);
    if (prior) { if (prior.request_hash !== hash) throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used"); if (prior.expires_at <= nowIso(config)) throw new HttpError(410, "MESSAGE_EXPIRED", "This message has expired"); return sendJson(res, 200, { data: await dto(config, prior) }); }
    const createdAt = nowIso(config); const expiresAt = new Date(Date.parse(createdAt) + RETENTION_MS).toISOString(); const id = randomUUID(); const encrypted = await encryptMessage(config, message, { id, orderId: granted.order.id, senderUserId: granted.user.id, createdAt, expiresAt });
    const created = withTransaction(db, () => {
      const order = db.prepare("SELECT * FROM orders WHERE id=?").get(granted.order.id); if (!availability(db, order, config).open) throw new HttpError(410, "MESSAGING_CLOSED", "This order conversation is closed");
      const bucket = db.prepare("SELECT * FROM order_message_rate_limits WHERE user_id=? AND order_id=?").get(granted.user.id, order.id); const stamp = config.now().getTime();
      if (!bucket || stamp - bucket.window_start_ms >= 60_000) db.prepare("INSERT INTO order_message_rate_limits VALUES(?,?,?,1) ON CONFLICT(user_id,order_id) DO UPDATE SET window_start_ms=excluded.window_start_ms,message_count=1").run(granted.user.id, order.id, stamp);
      else { if (bucket.message_count >= 8) throw new HttpError(429, "MESSAGE_RATE_LIMITED", "Please wait before sending more messages"); db.prepare("UPDATE order_message_rate_limits SET message_count=message_count+1 WHERE user_id=? AND order_id=?").run(granted.user.id, order.id); }
      db.prepare("INSERT INTO order_messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(id, order.id, granted.user.id, granted.role, key, hash, encrypted.ciphertext, encrypted.nonce, encrypted.authTag, encrypted.keyVersion, createdAt, expiresAt);
      notifyRecipients(db, order, granted.user.id, id, createdAt); return db.prepare("SELECT * FROM order_messages WHERE id=?").get(id);
    });
    return sendJson(res, 201, { data: await dto(config, created) });
  }
  return false;
}
