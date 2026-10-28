import { randomUUID } from "node:crypto";
import { requireRestaurantOwner, requireRole } from "./auth/authorization.js";
import { withTransaction } from "./db/index.js";
import { HttpError, exactObject, readJson, sendJson } from "./http.js";
import { decryptMessage, encryptMessage, messageFingerprint } from "./message-encryption.js";
import { queueCustomerEmailForNotification } from "./customer-emails.js";

const DAY = 86400_000;
const RETENTION_MS = 30 * DAY;
const WORKFLOW = new Set(["active", "follow_up", "vip", "resolved"]);
const THREAD_STATUS = new Set(["open", "awaiting_customer", "awaiting_restaurant", "resolved"]);
const TERMINAL_CASES = "'rejected','refunded','resolved'";
const clean = (value, min, max, label) => {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < min || text.length > max) throw new HttpError(400, "VALIDATION_ERROR", `${label} is invalid`);
  return text;
};
const numberParam = (url, name, fallback, max) => {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > max) throw new HttpError(400, "VALIDATION_ERROR", `${name} is invalid`);
  return Number(raw);
};
const pageParams = url => ({ page: numberParam(url, "page", 1, 100000), pageSize: numberParam(url, "pageSize", 25, 100) });
const pagination = (page, pageSize, total) => ({ page, pageSize, total, totalPages: Math.ceil(total / pageSize), hasNext: page * pageSize < total, hasPrevious: page > 1 });
const searchText = url => clean(url.searchParams.get("q") ?? "", 0, 100, "Search");
const like = value => `%${value.replace(/[\\%_]/g, "\\$&")}%`;
const notFound = () => new HttpError(404, "NOT_FOUND", "Resource not found");

function relationship(db, restaurantId, customerId) {
  const row = db.prepare("SELECT u.id,u.name FROM users u WHERE u.id=? AND u.role='customer' AND EXISTS(SELECT 1 FROM orders o WHERE o.restaurant_id=? AND o.customer_id=u.id)").get(customerId, restaurantId);
  if (!row) throw notFound();
  return row;
}

function directoryContext(db, restaurantId, userId, config) {
  const now = config.now(), cfg = db.prepare("SELECT * FROM loyalty_settings WHERE restaurant_id=?").get(restaurantId) ?? { regular_order_count: 3, regular_window_days: 60, lapsed_after_days: 30 };
  const params = { rid: restaurantId, viewer: userId, now: now.toISOString(), regularStart: new Date(+now - cfg.regular_window_days * DAY).toISOString(), lapsedCutoff: new Date(+now - cfg.lapsed_after_days * DAY).toISOString(), regularCount: cfg.regular_order_count };
  const sql = `WITH scoped_refunds AS (
    SELECT f.order_id,SUM(f.food_amount_minor+f.delivery_amount_minor) amount FROM refunds f JOIN orders ro ON ro.id=f.order_id WHERE ro.restaurant_id=$rid GROUP BY f.order_id
  ), history AS (
    SELECT o.customer_id,COUNT(*) total_order_count,MIN(o.created_at) first_order_at,MAX(o.created_at) last_order_at,
      SUM(CASE WHEN o.status='completed' AND o.total_minor-COALESCE(f.amount,0)>0 THEN 1 ELSE 0 END) completed_order_count,
      SUM(CASE WHEN o.status='completed' AND o.total_minor-COALESCE(f.amount,0)>0 AND o.created_at>=$regularStart THEN 1 ELSE 0 END) window_order_count,
      SUM(CASE WHEN o.status='completed' AND o.total_minor-COALESCE(f.amount,0)>0 THEN o.total_minor-COALESCE(f.amount,0) ELSE 0 END) net_spend_minor,
      MAX(CASE WHEN o.status='completed' AND o.total_minor-COALESCE(f.amount,0)>0 THEN o.created_at ELSE NULL END) last_completed_at
    FROM orders o LEFT JOIN scoped_refunds f ON f.order_id=o.id WHERE o.restaurant_id=$rid AND o.created_at<=$now GROUP BY o.customer_id
  ), unread AS (
    SELECT t.customer_id,COUNT(*) n FROM restaurant_customer_threads t JOIN restaurant_customer_messages m ON m.thread_id=t.id
    LEFT JOIN restaurant_customer_message_reads mr ON mr.thread_id=t.id AND mr.user_id=$viewer
    WHERE t.restaurant_id=$rid AND m.sender_user_id<>$viewer AND m.sender_role='customer' AND m.expires_at>$now
      AND m.ingest_sequence>COALESCE(mr.last_read_sequence,0) GROUP BY t.customer_id
  ), active_cases AS (
    SELECT customer_id,COUNT(*) n FROM refund_cases WHERE restaurant_id=$rid AND resolved_at IS NULL AND status NOT IN (${TERMINAL_CASES}) GROUP BY customer_id
  ), directory AS (
    SELECT h.*,u.name,u.email,COALESCE(mp.in_app_promotions,u.merchant_offers,0) merchant_offers,
      COALESCE(w.workflow_status,'active') workflow_status,COALESCE(um.n,0) unread_message_count,COALESCE(ac.n,0) active_refund_case_count,t.id thread_id,
      CASE WHEN COALESCE(um.n,0)>0 OR COALESCE(ac.n,0)>0 OR w.workflow_status='follow_up' THEN 1 ELSE 0 END needs_attention,
      CASE WHEN COALESCE(h.last_completed_at,h.last_order_at)<=$lapsedCutoff THEN 1 ELSE 0 END is_lapsed,
      CASE WHEN h.window_order_count>=$regularCount THEN 1 ELSE 0 END is_regular
    FROM history h JOIN users u ON u.id=h.customer_id LEFT JOIN marketing_preferences mp ON mp.user_id=u.id
    LEFT JOIN restaurant_customer_workflows w ON w.restaurant_id=$rid AND w.customer_id=h.customer_id
    LEFT JOIN restaurant_customer_threads t ON t.restaurant_id=$rid AND t.customer_id=h.customer_id
    LEFT JOIN unread um ON um.customer_id=h.customer_id LEFT JOIN active_cases ac ON ac.customer_id=h.customer_id
  )`;
  return { sql, params };
}

function customerDto(row) {
  return {
    customerId: row.customer_id, name: row.name, merchantOffers: Boolean(row.merchant_offers), eligibleForOffers: Boolean(row.merchant_offers && row.completed_order_count > 0),
    completedOrderCount: row.completed_order_count, totalOrderCount: row.total_order_count, netSpendMinor: row.net_spend_minor,
    averageOrderMinor: row.completed_order_count ? Math.round(row.net_spend_minor / row.completed_order_count) : 0,
    firstOrderAt: row.first_order_at, lastOrderAt: row.last_order_at, workflowStatus: row.workflow_status,
    engagementStatus: row.needs_attention ? "needs_attention" : row.workflow_status === "vip" ? "vip" : row.is_lapsed ? "lapsed" : row.is_regular ? "regular" : row.completed_order_count > 1 ? "returning" : "new",
    segments: { new: row.completed_order_count <= 1, returning: row.completed_order_count > 1, regular: Boolean(row.is_regular), lapsed: Boolean(row.is_lapsed), vip: row.workflow_status === "vip", needs_attention: Boolean(row.needs_attention) },
    unreadMessageCount: row.unread_message_count, activeRefundCaseCount: row.active_refund_case_count, threadId: row.thread_id ?? null
  };
}

function directory(db, restaurantId, user, url, config) {
  const { page, pageSize } = pageParams(url), context = directoryContext(db, restaurantId, user.id, config), params = { ...context.params };
  const q = searchText(url), segment = url.searchParams.get("segment") ?? "all", status = url.searchParams.get("status") ?? "all", sort = url.searchParams.get("sort") ?? "recent";
  const segments = { all: "1=1", new: "completed_order_count<=1", returning: "completed_order_count>1", regular: "is_regular=1", lapsed: "is_lapsed=1", vip: "workflow_status='vip'", needs_attention: "needs_attention=1" };
  const sorts = { recent: "last_order_at DESC,customer_id ASC", name: "name COLLATE NOCASE ASC,customer_id ASC", spend: "net_spend_minor DESC,customer_id ASC", orders: "completed_order_count DESC,customer_id ASC" };
  if (!(segment in segments) || !(sort in sorts) || (status !== "all" && !WORKFLOW.has(status))) throw new HttpError(400, "VALIDATION_ERROR", "Customer filters are invalid");
  const clauses = [segments[segment]];
  if (q) { clauses.push("(name LIKE $search ESCAPE '\\' OR email LIKE $search ESCAPE '\\')"); params.search = like(q); }
  if (status !== "all") { clauses.push("workflow_status=$workflow"); params.workflow = status; }
  const where = clauses.join(" AND "), total = db.prepare(`${context.sql} SELECT COUNT(*) n FROM directory WHERE ${where}`).get(params).n;
  const rows = db.prepare(`${context.sql} SELECT * FROM directory WHERE ${where} ORDER BY ${sorts[sort]} LIMIT $limit OFFSET $offset`).all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });
  const summary = db.prepare(`${context.sql} SELECT COUNT(*) totalCustomers,COALESCE(SUM(needs_attention),0) needsAttention,COALESCE(SUM(is_regular),0) regular,COALESCE(SUM(workflow_status='vip'),0) vip,COALESCE(SUM(is_lapsed),0) lapsed FROM directory`).get(context.params);
  return { items: rows.map(customerDto), pagination: pagination(page, pageSize, total), summary, filters: { q, segment, status, sort }, asOf: context.params.now };
}

function threadDto(row, unread = 0) {
  return { id: row.id, threadId: row.id, restaurantId: row.restaurant_id, customerId: row.customer_id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, lastMessageAt: row.last_message_at, unreadMessageCount: unread };
}
function unreadCount(db, threadId, userId, now) {
  return db.prepare(`SELECT COUNT(*) n FROM restaurant_customer_messages m LEFT JOIN restaurant_customer_message_reads r ON r.thread_id=m.thread_id AND r.user_id=?
    WHERE m.thread_id=? AND m.sender_user_id<>? AND m.sender_role<>(SELECT CASE WHEN role='restaurant' THEN 'restaurant' ELSE 'customer' END FROM users WHERE id=?) AND m.expires_at>? AND m.ingest_sequence>COALESCE(r.last_read_sequence,0)`).get(userId, threadId, userId, userId, now).n;
}
async function messageDto(config, row) {
  return { id: row.id, threadId: row.thread_id, conversationId: row.thread_id, senderUserId: row.sender_user_id, senderRole: row.sender_role, message: await decryptMessage(config, { ...row, order_id: `customer-thread:${row.thread_id}` }), createdAt: row.created_at, expiresAt: row.expires_at, ingestSequence: row.ingest_sequence };
}
function conversationAccess(db, session, threadId) {
  const user = requireRole(session, "customer"), thread = db.prepare("SELECT * FROM restaurant_customer_threads WHERE id=? AND customer_id=?").get(threadId, user.id);
  if (!thread) throw notFound();
  return { user, thread, role: "customer" };
}

function profile(db, restaurantId, customerId, user, config) {
  relationship(db, restaurantId, customerId);
  const context = directoryContext(db, restaurantId, user.id, config);
  const row = db.prepare(`${context.sql} SELECT * FROM directory WHERE customer_id=$customer`).get({ ...context.params, customer: customerId });
  const workflow = db.prepare("SELECT note FROM restaurant_customer_workflows WHERE restaurant_id=? AND customer_id=?").get(restaurantId, customerId);
  const recentOrders = db.prepare("SELECT id,status,total_minor,currency,created_at,fulfillment FROM orders WHERE restaurant_id=? AND customer_id=? ORDER BY created_at DESC,id DESC LIMIT 20").all(restaurantId, customerId).map(o => ({ id: o.id, status: o.status, totalMinor: o.total_minor, currency: o.currency, createdAt: o.created_at, fulfillment: o.fulfillment }));
  const recentOffers = db.prepare("SELECT g.id,g.status,g.created_at,g.viewed_at,c.title,c.expires_at,c.offer_type FROM offer_grants g JOIN offer_campaigns c ON c.id=g.campaign_id WHERE g.restaurant_id=? AND g.customer_id=? ORDER BY g.created_at DESC,g.id DESC LIMIT 20").all(restaurantId, customerId).map(o => ({ id: o.id, title: o.title, status: o.status === "available" && o.expires_at <= context.params.now ? "expired" : o.status, offerType: o.offer_type, viewedAt: o.viewed_at, createdAt: o.created_at, expiresAt: o.expires_at }));
  const refundCases = db.prepare("SELECT id,reference,order_id,status,reason,requested_amount_minor,created_at,updated_at FROM refund_cases WHERE restaurant_id=? AND customer_id=? ORDER BY updated_at DESC,id DESC LIMIT 20").all(restaurantId, customerId).map(c => ({ id: c.id, reference: c.reference, orderId: c.order_id, status: c.status, reason: c.reason, requestedAmountMinor: c.requested_amount_minor, createdAt: c.created_at, updatedAt: c.updated_at }));
  const thread = db.prepare("SELECT * FROM restaurant_customer_threads WHERE restaurant_id=? AND customer_id=?").get(restaurantId, customerId);
  return { customer: customerDto(row), note: workflow?.note ?? "", recentOrders, recentOffers, refundCases, conversation: thread ? threadDto(thread, row.unread_message_count) : null };
}

function inbox(db, restaurantId, user, url, config, customer = false) {
  const { page, pageSize } = pageParams(url), now = config.now().toISOString(), q = searchText(url), status = url.searchParams.get("status") ?? "all", unread = url.searchParams.get("unread");
  if ((status !== "all" && !THREAD_STATUS.has(status)) || (unread !== null && !["true", "false"].includes(unread))) throw new HttpError(400, "VALIDATION_ERROR", "Inbox filters are invalid");
  const params = { viewer: user.id, now, incomingRole: customer ? "restaurant" : "customer" }, clauses = [];
  if (status !== "all") { clauses.push("status=$status"); params.status = status; }
  if (q) { clauses.push(customer ? "restaurant_name LIKE $search ESCAPE '\\'" : "customer_name LIKE $search ESCAPE '\\'"); params.search = like(q); }
  if (!customer) { params.rid = restaurantId; params.supportMinutes = Math.min(1440, Math.max(0, (config.messagingSupportHours ?? 2) * 60)); }
  const customerThreads = `SELECT t.id,t.restaurant_id,t.customer_id,t.status,t.created_at,t.updated_at,t.last_message_at,u.name customer_name,r.name restaurant_name,'customer' conversation_type,NULL order_id,1 messaging_available,
    (SELECT COUNT(*) FROM restaurant_customer_messages m LEFT JOIN restaurant_customer_message_reads mr ON mr.thread_id=t.id AND mr.user_id=$viewer WHERE m.thread_id=t.id AND m.sender_role=$incomingRole AND m.expires_at>$now AND m.ingest_sequence>COALESCE(mr.last_read_sequence,0)) unread_count
    FROM restaurant_customer_threads t JOIN users u ON u.id=t.customer_id JOIN restaurants r ON r.id=t.restaurant_id WHERE ${customer ? "t.customer_id=$viewer" : "t.restaurant_id=$rid"}`;
  const orderThreads = customer ? "" : `, order_messages_scoped AS (
    SELECT m.*,ROW_NUMBER() OVER(PARTITION BY m.order_id ORDER BY m.created_at DESC,m.id DESC) position,
      CASE WHEN m.sender_role=$incomingRole AND (mr.order_id IS NULL OR m.created_at>mr.last_read_created_at OR (m.created_at=mr.last_read_created_at AND m.id>mr.last_read_message_id)) THEN 1 ELSE 0 END unread
    FROM order_messages m JOIN orders o ON o.id=m.order_id LEFT JOIN order_message_reads mr ON mr.order_id=m.order_id AND mr.user_id=$viewer WHERE o.restaurant_id=$rid AND m.expires_at>$now
  ), order_thread_rows AS (
    SELECT o.id,o.restaurant_id,o.customer_id,o.created_at,o.updated_at,m.created_at last_message_at,u.name customer_name,r.name restaurant_name,'order' conversation_type,o.id order_id,m.sender_role last_sender_role,
      CASE WHEN o.status IN ('placed','accepted','preparing','ready','out_for_delivery') THEN 1
        WHEN julianday($now)<julianday(COALESCE((SELECT created_at FROM order_events e WHERE e.order_id=o.id AND e.to_status IN ('completed','rejected') ORDER BY e.created_at DESC LIMIT 1),o.updated_at))+COALESCE(ms.support_window_minutes,$supportMinutes)/1440.0 THEN 1 ELSE 0 END messaging_available,
      (SELECT COALESCE(SUM(om.unread),0) FROM order_messages_scoped om WHERE om.order_id=o.id) unread_count
    FROM order_messages_scoped m JOIN orders o ON o.id=m.order_id JOIN users u ON u.id=o.customer_id JOIN restaurants r ON r.id=o.restaurant_id LEFT JOIN order_message_settings ms ON ms.restaurant_id=o.restaurant_id WHERE m.position=1
  )`;
  const union = customer ? customerThreads : `${customerThreads} UNION ALL SELECT id,restaurant_id,customer_id,CASE WHEN messaging_available=0 THEN 'resolved' WHEN last_sender_role='customer' THEN 'awaiting_restaurant' ELSE 'awaiting_customer' END status,created_at,updated_at,last_message_at,customer_name,restaurant_name,conversation_type,order_id,messaging_available,unread_count FROM order_thread_rows`;
  const cte = `WITH base AS (SELECT 1)${orderThreads}, all_threads AS (${union}), threads AS (SELECT * FROM all_threads${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""})`;
  const unreadWhere = unread === "true" ? " WHERE unread_count>0" : "";
  const total = db.prepare(`${cte} SELECT COUNT(*) n FROM threads${unreadWhere}`).get(params).n;
  const rows = db.prepare(`${cte} SELECT * FROM threads${unreadWhere} ORDER BY last_message_at DESC,id DESC LIMIT $limit OFFSET $offset`).all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });
  const summary = db.prepare(`${cte} SELECT COUNT(*) totalConversations,COALESCE(SUM(unread_count),0) unreadMessages,COALESCE(SUM(status='awaiting_restaurant'),0) awaitingRestaurant FROM threads`).get(params);
  return { items: rows.map(t => ({ ...threadDto(t, t.unread_count), customerName: t.customer_name, restaurantName: t.restaurant_name, conversationType: t.conversation_type, orderId: t.order_id, messagingAvailable: Boolean(t.messaging_available) })), pagination: pagination(page, pageSize, total), summary };
}

async function readMessages(db, thread, user, url, config) {
  if (!thread) return { thread: null, items: [], unreadCount: 0, nextCursor: null, readThroughMessageId: null };
  const limit = numberParam(url, "limit", 30, 100), now = config.now().toISOString(), before = url.searchParams.get("before"), beforeId = url.searchParams.get("beforeId");
  if ((before && Number.isNaN(Date.parse(before))) || (beforeId && !before)) throw new HttpError(400, "VALIDATION_ERROR", "Message cursor is invalid");
  const rows = before ? db.prepare("SELECT * FROM restaurant_customer_messages WHERE thread_id=? AND expires_at>? AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?").all(thread.id, now, before, before, beforeId ?? "~", limit + 1) : db.prepare("SELECT * FROM restaurant_customer_messages WHERE thread_id=? AND expires_at>? ORDER BY created_at DESC,id DESC LIMIT ?").all(thread.id, now, limit + 1);
  const hasMore = rows.length > limit, selected = rows.slice(0, limit), oldest = selected.at(-1), items = [];
  const readThrough = selected.reduce((latest, row) => !latest || row.ingest_sequence > latest.ingest_sequence ? row : latest, null);
  for (const row of selected.reverse()) items.push(await messageDto(config, row));
  const unread = unreadCount(db, thread.id, user.id, now);
  return { thread: {...threadDto(thread, unread),restaurantName:db.prepare("SELECT name FROM restaurants WHERE id=?").get(thread.restaurant_id)?.name??null}, items, unreadCount: unread, nextCursor: hasMore ? { before: oldest.created_at, beforeId: oldest.id } : null, readThroughMessageId: readThrough?.id ?? null };
}

async function sendMessage({ req, res, db, config, user, role, restaurantId, customerId, thread }) {
  const body = await readJson(req, config.bodyLimit); exactObject(body, ["message", "clientMessageId"]);
  const message = clean(body.message, 1, 2000, "Message"), key = clean(req.headers["idempotency-key"] ?? body.clientMessageId, 1, 100, "Idempotency-Key");
  relationship(db, restaurantId, customerId);
  const existing = thread ?? db.prepare("SELECT * FROM restaurant_customer_threads WHERE restaurant_id=? AND customer_id=?").get(restaurantId, customerId);
  const threadId = existing?.id ?? randomUUID(), hash = messageFingerprint(config, `customer-thread:${threadId}`, message), now = config.now().toISOString();
  const prior = existing && db.prepare("SELECT * FROM restaurant_customer_messages WHERE thread_id=? AND sender_user_id=? AND idempotency_key=?").get(threadId, user.id, key);
  if (prior) {
    if (prior.request_hash !== hash) throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used");
    if (prior.expires_at <= now) throw new HttpError(410, "MESSAGE_EXPIRED", "This message has expired");
    return sendJson(res, 200, { data: await messageDto(config, prior) });
  }
  const id = randomUUID(), expiresAt = new Date(Date.parse(now) + RETENTION_MS).toISOString();
  const encrypted = await encryptMessage(config, message, { id, orderId: `customer-thread:${threadId}`, senderUserId: user.id, createdAt: now, expiresAt });
  const created = withTransaction(db, () => {
    // Encryption may yield; recheck both the relationship and current membership before writing.
    relationship(db, restaurantId, customerId);
    if (role === "restaurant" && !db.prepare("SELECT 1 FROM restaurant_memberships WHERE restaurant_id=? AND user_id=? AND permission='owner'").get(restaurantId, user.id)) throw notFound();
    const race = db.prepare("SELECT id FROM restaurant_customer_threads WHERE restaurant_id=? AND customer_id=?").get(restaurantId, customerId);
    if (race && race.id !== threadId) throw new HttpError(409, "CONVERSATION_CHANGED", "The conversation changed. Reload before sending again");
    if (!race) db.prepare("INSERT INTO restaurant_customer_threads VALUES(?,?,?,'open',?,?,?)").run(threadId, restaurantId, customerId, now, now, now);
    const retry = db.prepare("SELECT * FROM restaurant_customer_messages WHERE thread_id=? AND sender_user_id=? AND idempotency_key=?").get(threadId, user.id, key);
    if (retry) {
      if (retry.request_hash !== hash) throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used");
      return { row: retry, replay: true };
    }
    const stamp = config.now().getTime(), bucket = db.prepare("SELECT * FROM restaurant_customer_message_rate_limits WHERE user_id=? AND thread_id=?").get(user.id, threadId);
    const recentCount = db.prepare("SELECT COALESCE(SUM(message_count),0) n FROM restaurant_customer_message_rate_limits WHERE user_id=? AND window_start_ms>?").get(user.id, stamp - 60000).n;
    if (recentCount >= 60) throw new HttpError(429, "MESSAGE_RATE_LIMITED", "Please wait before sending more messages");
    if (!bucket || stamp - bucket.window_start_ms >= 60_000) db.prepare("INSERT INTO restaurant_customer_message_rate_limits VALUES(?,?,?,1) ON CONFLICT(user_id,thread_id) DO UPDATE SET window_start_ms=excluded.window_start_ms,message_count=1").run(user.id, threadId, stamp);
    else {
      if (bucket.message_count >= 8) throw new HttpError(429, "MESSAGE_RATE_LIMITED", "Please wait before sending more messages");
      db.prepare("UPDATE restaurant_customer_message_rate_limits SET message_count=message_count+1 WHERE user_id=? AND thread_id=?").run(user.id, threadId);
    }
    // The durable counter survives message retention and is assigned only after replay checks.
    // Encryption can complete out of creation-time order, so timestamps cannot order read cursors.
    const sequence = db.prepare("INSERT INTO restaurant_customer_thread_sequences(thread_id,last_sequence) VALUES(?,1) ON CONFLICT(thread_id) DO UPDATE SET last_sequence=restaurant_customer_thread_sequences.last_sequence+1 RETURNING last_sequence").get(threadId).last_sequence;
    db.prepare("INSERT INTO restaurant_customer_messages(id,thread_id,sender_user_id,sender_role,idempotency_key,request_hash,ciphertext,nonce,auth_tag,key_version,created_at,expires_at,ingest_sequence) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, threadId, user.id, role, key, hash, encrypted.ciphertext, encrypted.nonce, encrypted.authTag, encrypted.keyVersion, now, expiresAt, sequence);
    const ingestedAt = new Date(stamp).toISOString();
    db.prepare("UPDATE restaurant_customer_threads SET status=?,last_message_at=?,updated_at=? WHERE id=?").run(role === "customer" ? "awaiting_restaurant" : "awaiting_customer", ingestedAt, ingestedAt, threadId);
    const recipients = role === "customer" ? db.prepare("SELECT user_id FROM restaurant_memberships WHERE restaurant_id=? AND permission='owner'").all(restaurantId).map(r => r.user_id) : [customerId];
    for (const recipient of recipients) {
      const eventKey=`customer-message:${id}`,inserted=db.prepare("INSERT OR IGNORE INTO user_notifications(id,user_id,type,title,message,restaurant_id,conversation_id,customer_id,event_key,created_at) VALUES(?,?,'customer_message','New customer conversation message','You have a new message in your restaurant conversation.',?,?,?,?,?)").run(randomUUID(), recipient, restaurantId, threadId, customerId,eventKey,ingestedAt);
      if(inserted.changes)queueCustomerEmailForNotification(db,recipient,eventKey);
    }
    return { row: db.prepare("SELECT * FROM restaurant_customer_messages WHERE id=?").get(id), replay: false };
  });
  return sendJson(res, created.replay ? 200 : 201, { data: await messageDto(config, created.row) });
}

async function markRead(req, db, thread, user, config) {
  const body = await readJson(req, config.bodyLimit); exactObject(body, ["lastMessageId"]);
  if (!thread) throw notFound();
  const messageId = clean(body.lastMessageId, 1, 100, "Message"), now = config.now().toISOString(), row = db.prepare("SELECT * FROM restaurant_customer_messages WHERE id=? AND thread_id=? AND expires_at>?").get(messageId, thread.id, now);
  if (!row) throw notFound();
  withTransaction(db, () => {
    const prior = db.prepare("SELECT * FROM restaurant_customer_message_reads WHERE thread_id=? AND user_id=?").get(thread.id, user.id);
    if (!prior || row.ingest_sequence > prior.last_read_sequence) {
      db.prepare("INSERT INTO restaurant_customer_message_reads(thread_id,user_id,last_read_created_at,last_read_message_id,updated_at,last_read_sequence) VALUES(?,?,?,?,?,?) ON CONFLICT(thread_id,user_id) DO UPDATE SET last_read_created_at=excluded.last_read_created_at,last_read_message_id=excluded.last_read_message_id,updated_at=excluded.updated_at,last_read_sequence=excluded.last_read_sequence").run(thread.id, user.id, row.created_at, row.id, now, row.ingest_sequence);
      db.prepare("UPDATE user_notifications SET read_at=? WHERE user_id=? AND conversation_id=? AND type='customer_message' AND read_at IS NULL AND event_key IN (SELECT 'customer-message:'||id FROM restaurant_customer_messages WHERE thread_id=? AND ingest_sequence<=?)").run(now, user.id, thread.id, thread.id, row.ingest_sequence);
    }
  });
  return { threadId: thread.id, lastMessageId: row.id, unreadCount: unreadCount(db, thread.id, user.id, now) };
}

export function runCustomerMessageRetention(db, config) {
  const now = config.now().toISOString();
  return withTransaction(db, () => {
    db.prepare("DELETE FROM user_notifications WHERE type='customer_message' AND event_key IN (SELECT 'customer-message:'||id FROM restaurant_customer_messages WHERE expires_at<=?)").run(now);
    const result = db.prepare("DELETE FROM restaurant_customer_messages WHERE expires_at<=?").run(now);
    db.prepare("DELETE FROM restaurant_customer_message_rate_limits WHERE window_start_ms<=?").run(config.now().getTime() - 60000);
    return result.changes;
  });
}

export async function routeCustomerRelationships({ req, res, url, db, config, session }) {
  let match = url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/(customers|inbox)(?:\/([^/]+)\/(profile|conversation)(?:\/(read))?)?$/);
  if (match) {
    const [, restaurantId, resource, customerId, action, read] = match, user = requireRestaurantOwner(db, session, restaurantId);
    if (resource === "inbox" && !customerId && req.method === "GET") return sendJson(res, 200, { data: inbox(db, restaurantId, user, url, config) });
    if (resource === "customers" && !customerId && req.method === "GET") return sendJson(res, 200, { data: directory(db, restaurantId, user, url, config) });
    if (!customerId || resource !== "customers") return false;
    relationship(db, restaurantId, customerId);
    if (action === "profile" && !read) {
      if (req.method === "PATCH") {
        const body = await readJson(req, config.bodyLimit); exactObject(body, ["workflowStatus", "note"]);
        if (!WORKFLOW.has(body.workflowStatus)) throw new HttpError(400, "VALIDATION_ERROR", "Customer status is invalid");
        const note = clean(body.note ?? "", 0, 2000, "Customer note"), now = config.now().toISOString();
        withTransaction(db, () => {
          db.prepare("INSERT INTO restaurant_customer_workflows VALUES(?,?,?,?,?,?) ON CONFLICT(restaurant_id,customer_id) DO UPDATE SET workflow_status=excluded.workflow_status,note=excluded.note,updated_by_user_id=excluded.updated_by_user_id,updated_at=excluded.updated_at").run(restaurantId, customerId, body.workflowStatus, note, user.id, now);
          db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(), user.id, "restaurant_customer", `${restaurantId}:${customerId}`, "customer_workflow_updated", JSON.stringify({ workflowStatus: body.workflowStatus, noteUpdated: true }), now);
        });
      }
      if (["GET", "PATCH"].includes(req.method)) return sendJson(res, 200, { data: profile(db, restaurantId, customerId, user, config) });
    }
    if (action === "conversation") {
      const thread = db.prepare("SELECT * FROM restaurant_customer_threads WHERE restaurant_id=? AND customer_id=?").get(restaurantId, customerId);
      if (read && req.method === "POST") return sendJson(res, 200, { data: await markRead(req, db, thread, user, config) });
      if (read) return false;
      if (req.method === "GET") return sendJson(res, 200, { data: await readMessages(db, thread, user, url, config) });
      if (req.method === "POST") return sendMessage({ req, res, db, config, user, role: "restaurant", restaurantId, customerId, thread });
      if (req.method === "PATCH") {
        if (!thread) throw notFound();
        const body = await readJson(req, config.bodyLimit); exactObject(body, ["status"]);
        if (!THREAD_STATUS.has(body.status)) throw new HttpError(400, "VALIDATION_ERROR", "Conversation status is invalid");
        const now = config.now().toISOString();
        withTransaction(db, () => {
          db.prepare("UPDATE restaurant_customer_threads SET status=?,updated_at=? WHERE id=?").run(body.status, now, thread.id);
          db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(), user.id, "customer_conversation", thread.id, "customer_conversation_status_updated", JSON.stringify({ status: body.status }), now);
        });
        return sendJson(res, 200, { data: threadDto({ ...thread, status: body.status, updated_at: now }, unreadCount(db, thread.id, user.id, now)) });
      }
    }
    return false;
  }
  if (url.pathname === "/api/customer/conversations" && req.method === "GET") {
    const user = requireRole(session, "customer"); return sendJson(res, 200, { data: inbox(db, null, user, url, config, true) });
  }
  match = url.pathname.match(/^\/api\/customer\/conversations\/([^/]+)\/(messages|read)$/);
  if (!match) return false;
  const { user, thread, role } = conversationAccess(db, session, match[1]);
  if (match[2] === "read" && req.method === "POST") return sendJson(res, 200, { data: await markRead(req, db, thread, user, config) });
  if (match[2] === "messages" && req.method === "GET") return sendJson(res, 200, { data: await readMessages(db, thread, user, url, config) });
  if (match[2] === "messages" && req.method === "POST") return sendMessage({ req, res, db, config, user, role, restaurantId: thread.restaurant_id, customerId: thread.customer_id, thread });
  return false;
}
