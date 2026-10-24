import { randomUUID } from "node:crypto";
import { VALIDATION } from "../../../packages/contracts/src/index.js";
import { requireRestaurantMembership, requireRestaurantOwner, requireRole, requireUser } from "./auth/authorization.js";
import { hashPassword } from "./auth/passwords.js";
import { withTransaction } from "./db/index.js";
import { HttpError, exactObject, readJson, sendJson } from "./http.js";
import { orderDto } from "./journey.js";
import { isDemoEmail } from "./seed.js";

const clean = (value, min, max, label) => { const result = typeof value === "string" ? value.trim() : ""; if (result.length < min || result.length > max) throw new HttpError(400, "VALIDATION_ERROR", `${label} is invalid`); return result; };
const accountDto = (row) => ({ id: row.id, name: row.name, email: row.email, role: row.role, phone: row.phone, emailVerified: Boolean(row.email_verified_at), emailVerifiedAt: row.email_verified_at });
const supportDto = (row) => ({ id: row.id, userId: row.user_id, orderId: row.order_id, subject: row.subject, message: row.message, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at });
const deletionDto = (row) => ({ id: row.id, userId: row.user_id, reason: row.reason, status: row.status, note: row.note, createdAt: row.created_at, updatedAt: row.updated_at });

export async function routeProduct({ req, res, url, db, config, session }) {
  let match = url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/staff$/);
  if (match && req.method === "GET") {
    requireRestaurantOwner(db, session, match[1]);
    const rows = db.prepare("SELECT u.id,u.name,u.email,m.permission FROM users u JOIN restaurant_memberships m ON m.user_id=u.id WHERE m.restaurant_id=? ORDER BY m.created_at").all(match[1]);
    return sendJson(res, 200, { data: rows });
  }
  if (match && req.method === "POST") {
    requireRestaurantOwner(db, session, match[1]);
    const body = await readJson(req, config.bodyLimit); exactObject(body, ["name", "email", "password"]);
    const name = clean(body.name, 1, VALIDATION.nameMax, "Name"); const email = clean(body.email, 3, VALIDATION.emailMax, "Email").toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof body.password !== "string" || body.password.length < VALIDATION.passwordMin || body.password.length > VALIDATION.passwordMax) throw new HttpError(400, "VALIDATION_ERROR", "Staff details are invalid");
    if (db.prepare("SELECT 1 FROM users WHERE email=?").get(email)) throw new HttpError(409, "EMAIL_EXISTS", "An account with this email already exists");
    if (config.runMode === "hosted-preview" && isDemoEmail(email)) throw new HttpError(400, "RESERVED_EMAIL", "Email is reserved");
    const passwordHash = await hashPassword(body.password); const now = config.now().toISOString(); const id = randomUUID();
    try { withTransaction(db, () => { db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)").run(id, name, email, passwordHash, "restaurant", now); db.prepare("INSERT INTO restaurant_memberships(restaurant_id,user_id,created_at,permission) VALUES(?,?,?,'staff')").run(match[1], id, now); }); }
    catch (error) { if (String(error.message).includes("UNIQUE")) throw new HttpError(409, "EMAIL_EXISTS", "An account with this email already exists"); throw error; }
    return sendJson(res, 201, { data: { id, name, email, permission: "staff" } });
  }
  if (req.method === "GET" && url.pathname === "/api/account") {
    const user = requireUser(session); return sendJson(res, 200, { data: accountDto(db.prepare("SELECT * FROM users WHERE id=?").get(user.id)) });
  }
  if (req.method === "PATCH" && url.pathname === "/api/account") {
    const user = requireUser(session); const body = await readJson(req, config.bodyLimit); exactObject(body, ["name", "phone"]);
    if (!Object.keys(body).length) throw new HttpError(400, "VALIDATION_ERROR", "At least one field is required");
    const current = db.prepare("SELECT * FROM users WHERE id=?").get(user.id);
    const name = body.name === undefined ? current.name : clean(body.name, 1, VALIDATION.nameMax, "Name");
    const phone = body.phone === undefined ? current.phone : clean(body.phone, 0, 30, "Phone");
    db.prepare("UPDATE users SET name=?,phone=? WHERE id=?").run(name, phone, user.id);
    return sendJson(res, 200, { data: accountDto(db.prepare("SELECT * FROM users WHERE id=?").get(user.id)) });
  }
  if (req.method === "GET" && url.pathname === "/api/account/export") {
    const user = requireUser(session); const account = accountDto(db.prepare("SELECT * FROM users WHERE id=?").get(user.id));
    const orders = user.role === "customer" ? db.prepare("SELECT * FROM orders WHERE customer_id=? ORDER BY created_at").all(user.id).map((row) => { const dto = orderDto(db, row, false, false); return dto; }) : [];
    const notifications = db.prepare("SELECT id,type,title,message,order_id AS orderId,offer_id AS offerId,restaurant_id AS restaurantId,created_at AS createdAt,read_at AS readAt FROM user_notifications WHERE user_id=? ORDER BY created_at").all(user.id);
    const offers = user.role === "customer" ? db.prepare("SELECT g.id,g.campaign_id AS campaignId,g.restaurant_id AS restaurantId,c.title,c.message,c.item_name AS itemName,c.item_value_minor AS itemValueMinor,c.min_subtotal_minor AS minSubtotalMinor,c.expires_at AS expiresAt,g.status,g.viewed_at AS viewedAt FROM offer_grants g JOIN offer_campaigns c ON c.id=g.campaign_id WHERE g.customer_id=? ORDER BY g.created_at").all(user.id) : [];
    const data = { account, orders, notifications, offers, support: db.prepare("SELECT * FROM support_cases WHERE user_id=? ORDER BY created_at").all(user.id).map(supportDto), deletionRequests: db.prepare("SELECT * FROM deletion_requests WHERE user_id=? ORDER BY created_at").all(user.id).map(deletionDto) };
    return sendJson(res, 200, { data }, { "Content-Disposition": "attachment; filename=calai-eats-account.json" });
  }
  if (req.method === "GET" && url.pathname === "/api/account/deletion-requests") { const user = requireUser(session); return sendJson(res, 200, { data: db.prepare("SELECT * FROM deletion_requests WHERE user_id=? ORDER BY created_at DESC").all(user.id).map(deletionDto) }); }
  if (req.method === "POST" && url.pathname === "/api/account/deletion-requests") {
    const user = requireUser(session); const body = await readJson(req, config.bodyLimit); exactObject(body, ["reason"]); const reason = clean(body.reason, 1, 1000, "Reason"); const now = config.now().toISOString(); const id = randomUUID();
    withTransaction(db, () => { db.prepare("INSERT INTO deletion_requests VALUES(?,?,?,?,?,?,?)").run(id, user.id, reason, "requested", "", now, now); db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(), user.id, "deletion_request", id, "deletion_requested", JSON.stringify({ status: "requested" }), now); });
    return sendJson(res, 201, { data: deletionDto(db.prepare("SELECT * FROM deletion_requests WHERE id=?").get(id)) });
  }
  if (req.method === "GET" && url.pathname === "/api/support") { const user = requireUser(session); return sendJson(res, 200, { data: db.prepare("SELECT * FROM support_cases WHERE user_id=? ORDER BY created_at DESC").all(user.id).map(supportDto) }); }
  if (req.method === "POST" && url.pathname === "/api/support") {
    const user = requireUser(session); const body = await readJson(req, config.bodyLimit); exactObject(body, ["subject", "message", "orderId"]);
    const subject = clean(body.subject, 1, 150, "Subject"); const message = clean(body.message, 1, 2000, "Message"); let orderId = null;
    if (body.orderId !== undefined) { orderId = clean(body.orderId, 1, 100, "Order"); const order = db.prepare("SELECT * FROM orders WHERE id=?").get(orderId); const member = order && user.role === "restaurant" && db.prepare("SELECT 1 FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?").get(order.restaurant_id, user.id); if (!order || (user.role !== "admin" && order.customer_id !== user.id && !member)) throw new HttpError(404, "NOT_FOUND", "Resource not found"); }
    const now = config.now().toISOString(); const id = randomUUID(); db.prepare("INSERT INTO support_cases VALUES(?,?,?,?,?,?,?,?)").run(id, user.id, orderId, subject, message, "open", now, now);
    return sendJson(res, 201, { data: supportDto(db.prepare("SELECT * FROM support_cases WHERE id=?").get(id)) });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/support") { requireRole(session, "admin"); return sendJson(res, 200, { data: db.prepare("SELECT * FROM support_cases ORDER BY created_at DESC").all().map(supportDto) }); }
  match = url.pathname.match(/^\/api\/admin\/support\/([^/]+)$/);
  if (match && req.method === "PATCH") {
    const user = requireRole(session, "admin"); const body = await readJson(req, config.bodyLimit); exactObject(body, ["status"]); if (!["open", "resolved"].includes(body.status)) throw new HttpError(400, "VALIDATION_ERROR", "Support status is invalid"); const row = db.prepare("SELECT * FROM support_cases WHERE id=?").get(match[1]); if (!row) throw new HttpError(404, "NOT_FOUND", "Resource not found"); const now = config.now().toISOString();
    withTransaction(db, () => { db.prepare("UPDATE support_cases SET status=?,updated_at=? WHERE id=?").run(body.status, now, row.id); db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(), user.id, "support", row.id, "support_status_changed", JSON.stringify({ from: row.status, to: body.status }), now); });
    return sendJson(res, 200, { data: supportDto(db.prepare("SELECT * FROM support_cases WHERE id=?").get(row.id)) });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/deletion-requests") { requireRole(session, "admin"); return sendJson(res, 200, { data: db.prepare("SELECT * FROM deletion_requests ORDER BY created_at DESC").all().map(deletionDto) }); }
  match = url.pathname.match(/^\/api\/admin\/deletion-requests\/([^/]+)$/);
  if (match && req.method === "PATCH") {
    const user = requireRole(session, "admin"); const body = await readJson(req, config.bodyLimit); exactObject(body, ["status", "note"]); if (!["under_review", "resolved"].includes(body.status)) throw new HttpError(400, "VALIDATION_ERROR", "Review status is invalid"); const note = clean(body.note, 0, 1000, "Note"); const row = db.prepare("SELECT * FROM deletion_requests WHERE id=?").get(match[1]); if (!row) throw new HttpError(404, "NOT_FOUND", "Resource not found"); const now = config.now().toISOString();
    withTransaction(db, () => { db.prepare("UPDATE deletion_requests SET status=?,note=?,updated_at=? WHERE id=?").run(body.status, note, now, row.id); db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(), user.id, "deletion_request", row.id, "deletion_review_changed", JSON.stringify({ from: row.status, to: body.status }), now); });
    return sendJson(res, 200, { data: deletionDto(db.prepare("SELECT * FROM deletion_requests WHERE id=?").get(row.id)) });
  }
  return false;
}
