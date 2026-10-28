import { createHash, randomUUID } from "node:crypto";
import { requireUser, requireRole, requireRestaurantMembership } from "./auth/authorization.js";
import { withTransaction } from "./db/index.js";
import { HttpError, exactObject, readJson, sendJson } from "./http.js";
import { encryptMessage, decryptMessage, messageFingerprint, messageEncryptionReadiness } from "./message-encryption.js";
import { queueCustomerEmailForNotification } from "./customer-emails.js";

const text = (value, min, max, label) => {
  const result = typeof value === "string" ? value.trim() : "";
  if (result.length < min || result.length > max) throw new HttpError(400, "VALIDATION_ERROR", `${label} is invalid`);
  return result;
};
const query = `SELECT s.*,u.name AS customer_name,u.role AS requester_role,r.name AS restaurant_name,origin.name AS requester_restaurant_name FROM support_cases s JOIN users u ON u.id=s.user_id LEFT JOIN restaurants r ON r.id=s.restaurant_id LEFT JOIN restaurants origin ON origin.id=s.requester_restaurant_id`;
export const supportSummary = row => ({
  id: row.id, reference: row.id.slice(0, 8).toUpperCase(), userId: row.user_id,
  customerName: row.customer_name, orderId: row.order_id, restaurantId: row.restaurant_id ?? null,
  requesterRole: row.requester_role, requesterName: row.customer_name, requesterRestaurantId: row.requester_restaurant_id ?? null, requesterRestaurantName: row.requester_restaurant_name ?? null,
  assignedTo: row.requester_role === "customer" && row.restaurant_id ? "restaurant" : "platform",
  recipient: row.requester_role === "customer" && row.restaurant_id ? row.restaurant_name || "Restaurant team" : "Cal-Eats support", subject: row.subject, message: row.message,
  status: row.status, waitingFor: row.status === "resolved" ? "none" : row.waiting_for || "team",
  createdAt: row.created_at, updatedAt: row.updated_at
});
function participants(db, row) {
  const team = row.requester_role === "customer" && row.restaurant_id
    ? db.prepare(`SELECT u.id FROM restaurant_memberships m JOIN users u ON u.id=m.user_id WHERE m.restaurant_id=? AND u.account_enabled=1 AND u.role='restaurant'`).all(row.restaurant_id)
    : [];
  return team.length ? team : db.prepare("SELECT id FROM users WHERE role='admin' AND account_enabled=1").all();
}
function notify(db, row, recipients, kind, title, message, event, stamp) {
  for (const recipient of recipients) {
    const inserted=db.prepare(`INSERT OR IGNORE INTO user_notifications(id,user_id,type,title,message,order_id,restaurant_id,event_key,created_at,support_case_id) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),recipient.id,kind,title,message,row.order_id,row.restaurant_id,event,stamp,row.id);
    if(inserted.changes)queueCustomerEmailForNotification(db,recipient.id,event);
  }
}
function access(db, session, caseId) {
  const user = requireUser(session), row = db.prepare(`${query} WHERE s.id=?`).get(caseId);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Support request not found");
  const isTeam = user.role === "admin" || (row.requester_role === "customer" && user.role === "restaurant" && row.restaurant_id && db.prepare("SELECT 1 FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?").get(row.restaurant_id, user.id));
  if (row.user_id !== user.id && !isTeam) throw new HttpError(404, "NOT_FOUND", "Support request not found");
  return { user, row, isTeam: Boolean(isTeam) && row.user_id !== user.id };
}
function rate(db, userId, config) {
  const now = config.now().getTime(), entry = db.prepare("SELECT * FROM support_message_rate_limits WHERE user_id=?").get(userId);
  if (!entry || now - entry.window_start_ms >= 60_000) db.prepare("INSERT INTO support_message_rate_limits VALUES(?,?,1) ON CONFLICT(user_id) DO UPDATE SET window_start_ms=excluded.window_start_ms,request_count=1").run(userId, now);
  else {
    if (entry.request_count >= 12) throw new HttpError(429, "SUPPORT_RATE_LIMITED", "Please wait before sending another help message");
    db.prepare("UPDATE support_message_rate_limits SET request_count=request_count+1 WHERE user_id=?").run(userId);
  }
}
function pagination(url) {
  const page = Number(url.searchParams.get("page") || 1), pageSize = Number(url.searchParams.get("pageSize") || 30);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new HttpError(400, "VALIDATION_ERROR", "Support page is invalid");
  return { page, pageSize, offset: (page - 1) * pageSize };
}
function list(db, url, where, args) {
  const { page, pageSize, offset } = pagination(url), status = url.searchParams.get("status"), search = (url.searchParams.get("q") || "").trim();
  if (status && !["open", "resolved"].includes(status)) throw new HttpError(400, "VALIDATION_ERROR", "Support status is invalid");
  if (search.length > 100) throw new HttpError(400, "VALIDATION_ERROR", "Search is too long");
  if (status) { where += " AND s.status=?"; args.push(status); }
  const assignedTo=url.searchParams.get("assignedTo"),waitingFor=url.searchParams.get("waitingFor");
  if(assignedTo && !["platform","restaurant"].includes(assignedTo))throw new HttpError(400,"VALIDATION_ERROR","Support recipient is invalid");
  if(assignedTo)where+=assignedTo==="platform"?" AND (s.restaurant_id IS NULL OR u.role<>'customer')":" AND s.restaurant_id IS NOT NULL AND u.role='customer'";
  if(waitingFor && !["team","customer","none"].includes(waitingFor))throw new HttpError(400,"VALIDATION_ERROR","Support waiting status is invalid");
  if(waitingFor){where+=" AND s.waiting_for=?";args.push(waitingFor);}
  if (search) { where += " AND (instr(lower(s.subject),lower(?))>0 OR instr(lower(u.name),lower(?))>0 OR instr(lower(s.id),lower(?))>0)"; args.push(search, search, search); }
  const total = db.prepare(`SELECT COUNT(*) AS n FROM support_cases s JOIN users u ON u.id=s.user_id WHERE ${where}`).get(...args).n;
  const items = db.prepare(`${query} WHERE ${where} ORDER BY s.updated_at DESC,s.id DESC LIMIT ? OFFSET ?`).all(...args, pageSize, offset).map(supportSummary);
  return { items, page, pageSize, total, hasMore: offset + items.length < total };
}
async function messageDto(config, row) {
  return { id: row.id, senderUserId: row.sender_user_id, senderRole: row.sender_role,
    message: await decryptMessage(config, { ...row, order_id: `support:${row.case_id}`, expires_at: "" }), createdAt: row.created_at };
}
async function detail(db, config, session, caseId, url) {
  const { row, user, isTeam } = access(db, session, caseId);
  const limit = Number(url.searchParams.get("limit") || 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, "VALIDATION_ERROR", "Message limit is invalid");
  const before = url.searchParams.get("before"), beforeId = url.searchParams.get("beforeId") || "~";
  const rows = before ? db.prepare("SELECT * FROM support_case_messages WHERE case_id=? AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?").all(row.id, before, before, beforeId, limit + 1)
    : db.prepare("SELECT * FROM support_case_messages WHERE case_id=? ORDER BY created_at DESC,id DESC LIMIT ?").all(row.id, limit + 1);
  const hasMore = rows.length > limit, selected = rows.slice(0, limit), oldest = selected.at(-1);
  const encryption=messageEncryptionReadiness(config);
  return { ...supportSummary(row), isTeam, canReply: encryption.configured, replyUnavailableReason:encryption.configured?null:"Replies are temporarily unavailable. Your original request is saved; please try again when messaging is restored.", currentUserId: user.id, messages: encryption.configured?await Promise.all(selected.reverse().map(item => messageDto(config, item))):[], nextCursor: hasMore ? { before: oldest.created_at, beforeId: oldest.id } : null };
}
export async function routeSupportCases({ req, res, url, db, config, session }) {
  const ownList = url.pathname === "/api/support", adminList = url.pathname === "/api/admin/support";
  const restaurantList = url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/support$/);
  if ((ownList || adminList || restaurantList) && req.method === "GET") {
    const user = requireUser(session); let where = "s.user_id=?", args = [user.id];
    if (adminList) { requireRole(session, "admin"); where = "1=1"; args = []; }
    if (restaurantList) { requireRestaurantMembership(db, session, restaurantList[1]); where = "s.restaurant_id=? AND u.role='customer'"; args = [restaurantList[1]]; }
    const result = list(db, url, where, args);
    return sendJson(res, 200, { data: url.searchParams.has("page") || url.searchParams.has("pageSize") ? result : result.items, pagination: { ...result, items: undefined } });
  }
  if (ownList && req.method === "POST") {
    const user = requireUser(session), body = await readJson(req, config.bodyLimit); exactObject(body, ["subject", "message", "orderId", "restaurantId"]);
    const subject = text(body.subject, 1, 150, "Subject"), message = text(body.message, 1, 2000, "Message"), requestKey = req.headers["idempotency-key"] ? text(req.headers["idempotency-key"], 8, 150, "Retry key") : null;
    let orderId = null, restaurantId = null, requesterRestaurantId = null;
    if(body.restaurantId){if(user.role!=="restaurant")throw new HttpError(400,"VALIDATION_ERROR","Restaurant context is for business support");requesterRestaurantId=text(body.restaurantId,1,100,"Restaurant");requireRestaurantMembership(db,session,requesterRestaurantId);}
    if (body.orderId) {
      orderId = text(body.orderId, 1, 100, "Order"); const order = db.prepare("SELECT * FROM orders WHERE id=?").get(orderId);
      const member = order && user.role === "restaurant" && db.prepare("SELECT 1 FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?").get(order.restaurant_id, user.id);
      if (!order || (user.role !== "admin" && order.customer_id !== user.id && !member)) throw new HttpError(404, "NOT_FOUND", "Order not found");
      if (user.role === "customer") restaurantId = order.restaurant_id;
      if (user.role === "restaurant") requesterRestaurantId = order.restaurant_id;
    }
    const hash = createHash("sha256").update(JSON.stringify({ subject, message, orderId, ...(requesterRestaurantId?{requesterRestaurantId}:{}) })).digest("hex");
    const prior = requestKey && db.prepare("SELECT * FROM support_cases WHERE user_id=? AND idempotency_key=?").get(user.id, requestKey);
    if (prior) {
      if (prior.request_hash !== hash) throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "This retry key belongs to another request");
      return sendJson(res, 200, { data: supportSummary(db.prepare(`${query} WHERE s.id=?`).get(prior.id)) });
    }
    const stamp = config.now().toISOString(), id = randomUUID();
    withTransaction(db, () => {
      rate(db, user.id, config);
      db.prepare(`INSERT INTO support_cases(id,user_id,order_id,subject,message,status,created_at,updated_at,restaurant_id,waiting_for,idempotency_key,request_hash,requester_restaurant_id) VALUES(?,?,?,?,?,'open',?,?,?,'team',?,?,?)`).run(id, user.id, orderId, subject, message, stamp, stamp, restaurantId, requestKey, hash, requesterRestaurantId);
      const row = db.prepare(`${query} WHERE s.id=?`).get(id);
      notify(db, row, participants(db, row).filter(x => x.id !== user.id), "support_request", "New help request", `Request ${id.slice(0, 8).toUpperCase()}: ${subject}`, `support:${id}:created`, stamp);
      notify(db, row, [{ id: user.id }], "support_receipt", "Your request was sent", `${supportSummary(row).recipient} has received request ${id.slice(0, 8).toUpperCase()}. You can follow replies in this support conversation.`, `support:${id}:receipt`, stamp);
    });
    return sendJson(res, 201, { data: supportSummary(db.prepare(`${query} WHERE s.id=?`).get(id)) });
  }
  const match = url.pathname.match(/^\/api\/(?:admin\/)?support\/([^/]+)(?:\/(messages|read))?$/);
  if (!match) return false;
  const { user, row, isTeam } = access(db, session, match[1]);
  if (url.pathname.startsWith("/api/admin/")) requireRole(session, "admin");
  if (req.method === "GET" && !match[2]) return sendJson(res, 200, { data: await detail(db, config, session, row.id, url) });
  if (req.method === "POST" && match[2] === "read") {
    const body = await readJson(req, config.bodyLimit); exactObject(body, []);
    db.prepare("UPDATE user_notifications SET read_at=? WHERE user_id=? AND support_case_id=? AND read_at IS NULL").run(config.now().toISOString(), user.id, row.id);
    return sendJson(res, 200, { data: { read: true } });
  }
  if (req.method === "POST" && match[2] === "messages") {
    const body = await readJson(req, config.bodyLimit); exactObject(body, ["message"]);
    const message = text(body.message, 1, 2000, "Reply"), requestKey = text(req.headers["idempotency-key"], 8, 150, "Retry key"), context = `support:${row.id}`, requestHash = messageFingerprint(config, context, message);
    const prior = db.prepare("SELECT * FROM support_case_messages WHERE case_id=? AND sender_user_id=? AND idempotency_key=?").get(row.id, user.id, requestKey);
    if (prior) {
      if (prior.request_hash !== requestHash) throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "This retry key belongs to another reply");
      return sendJson(res, 200, { data: await messageDto(config, prior) });
    }
    const id = randomUUID(), stamp = config.now().toISOString();
    // Case correspondence is retained as a support record, separately from expiring order chats.
    const encrypted = await encryptMessage(config, message, { id, orderId: context, senderUserId: user.id, createdAt: stamp, expiresAt: "" });
    const saved = withTransaction(db, () => {
      access(db, session, row.id);
      const replay = db.prepare("SELECT * FROM support_case_messages WHERE case_id=? AND sender_user_id=? AND idempotency_key=?").get(row.id, user.id, requestKey);
      if (replay) {
        if (replay.request_hash !== requestHash) throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "This retry key belongs to another reply");
        return { row: replay, created: false };
      }
      rate(db, user.id, config);
      db.prepare("INSERT INTO support_case_messages VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id, row.id, user.id, user.role, requestKey, requestHash, encrypted.ciphertext, encrypted.nonce, encrypted.authTag, encrypted.keyVersion, stamp);
      db.prepare("UPDATE support_cases SET status='open',waiting_for=?,updated_at=? WHERE id=?").run(isTeam ? "customer" : "team", stamp, row.id);
      notify(db, row, isTeam ? [{ id: row.user_id }] : participants(db, row).filter(x => x.id !== user.id), "support_reply", "New reply to your help request", `Request ${row.id.slice(0, 8).toUpperCase()} has a new reply.`, `support:${row.id}:message:${id}`, stamp);
      db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(), user.id, "support", row.id, "support_replied", JSON.stringify({ messageId: id, recipient: isTeam ? "customer" : "team" }), stamp);
      return { row: db.prepare("SELECT * FROM support_case_messages WHERE id=?").get(id), created: true };
    });
    return sendJson(res, saved.created ? 201 : 200, { data: await messageDto(config, saved.row) });
  }
  if (req.method === "PATCH" && !match[2]) {
    const body = await readJson(req, config.bodyLimit); exactObject(body, ["status"]);
    if (!["open", "resolved"].includes(body.status)) throw new HttpError(400, "VALIDATION_ERROR", "Support status is invalid");
    const stamp = config.now().toISOString();
    withTransaction(db, () => {
      db.prepare("UPDATE support_cases SET status=?,waiting_for=?,updated_at=? WHERE id=?").run(body.status, body.status === "resolved" ? "none" : "team", stamp, row.id);
      db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(), user.id, "support", row.id, "support_status_changed", JSON.stringify({ from: row.status, to: body.status }), stamp);
      if (row.status !== body.status) notify(db, row, isTeam ? [{ id: row.user_id }] : participants(db, row).filter(x => x.id !== user.id), "support_status", "Help request updated", `Request ${row.id.slice(0, 8).toUpperCase()} is ${body.status}.`, `support:${row.id}:${body.status}:${stamp}`, stamp);
    });
    return sendJson(res, 200, { data: supportSummary(db.prepare(`${query} WHERE s.id=?`).get(row.id)) });
  }
  return false;
}
