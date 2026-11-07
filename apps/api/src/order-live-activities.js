import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, randomBytes, randomUUID } from "node:crypto";
import { requireRole } from "./auth/authorization.js";
import { withTransaction } from "./db/index.js";
import { HttpError, exactObject, readJson, sendJson } from "./http.js";
import { messageEncryptionKey } from "./message-encryption.js";

export const LIVE_ACTIVITY_NAME = "CalEatsOrderActivity";
export const LIVE_ACTIVITY_PROJECT = "5bf59184-c670-44f4-be78-5229cbd02300";
export const LIVE_ACTIVITY_TOPIC = "uk.co.calai.caleats.push-type.liveactivity";
export const LIVE_ACTIVITY_MAX_MS = 8 * 3600000;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i, activityIdPattern = /^[A-Za-z0-9_-]{1,200}$/, tokenPattern = /^(?:[0-9a-f]{2}){8,512}$/i;
const activeStatuses = new Set(["placed", "accepted", "preparing", "ready", "out_for_delivery"]);
const hash = value => createHash("sha256").update(value).digest("hex");
const clean = value => String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 100);
const keyFor = config => { const { key, version } = messageEncryptionKey(config); return { key: createHmac("sha256", key).update("cal-eats:order-live-activity:v1").digest(), version }; };
const aad = row => Buffer.from(["cal-eats-live-activity-v1", row.id, row.activity_id, row.installation_id, row.user_id, row.session_id, row.order_id, row.project_id, row.token_hash, row.generation, row.key_version].join("|"));

export function loadOrderLiveActivityConfig(env = process.env) {
  const enabled = env.CALAI_ORDER_LIVE_ACTIVITIES_ENABLED === "true";
  if (env.CALAI_ORDER_LIVE_ACTIVITIES_ENABLED && !["true", "false"].includes(env.CALAI_ORDER_LIVE_ACTIVITIES_ENABLED)) throw new Error("CALAI_ORDER_LIVE_ACTIVITIES_ENABLED must be true or false");
  const teamId = env.CALAI_APNS_TEAM_ID || "", keyId = env.CALAI_APNS_KEY_ID || "", privateKey = (env.CALAI_APNS_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (teamId && !/^[A-Z0-9]{10}$/.test(teamId) || keyId && !/^[A-Z0-9]{10}$/.test(keyId)) throw new Error("Live Activity sender identifiers are invalid");
  if (privateKey) {
    try { const key = createPrivateKey(privateKey); if (privateKey.length > 16000 || key.asymmetricKeyType !== "ec" || !["prime256v1", "P-256"].includes(key.asymmetricKeyDetails?.namedCurve)) throw new Error(); }
    catch { throw new Error("Live Activity sender key must be a private P-256 key"); }
  }
  if (enabled && (!teamId || !keyId || !privateKey)) throw new Error("Live Activities require the separately connected private Apple sender");
  return { enabled, teamId, keyId, privateKey };
}

export function liveOrderPayable(order) {
  return order && (order.payment_method === "cash" ? order.payment_status === "cash_due" : order.payment_method === "mock_card" ? ["mock_authorized", "mock_captured"].includes(order.payment_status) : order.payment_method === "card" ? ["stripe_authorized", "stripe_captured"].includes(order.payment_status) : order.payment_method === "voucher" && ["voucher_reserved", "voucher_redeemed"].includes(order.payment_status));
}
export function liveOrderActive(order) { return Boolean(order && activeStatuses.has(order.status) && order.merchant_visible_at && liveOrderPayable(order)); }
export function liveOrderCanStart(order, now) { return liveOrderActive(order) && Date.parse(order.created_at) > +now - LIVE_ACTIVITY_MAX_MS && (!order.scheduled_for || Date.parse(order.scheduled_for) <= +now + 2 * 3600000); }
export function liveOrderContent(order, now, privacyEnd = false) {
  const terminal = !liveOrderActive(order), labels = { placed: "Waiting for confirmation", accepted: "Order confirmed", preparing: "Preparing your food", ready: order?.fulfillment === "delivery" ? "Preparing your food" : "Ready to collect", out_for_delivery: "Your food is on its way", completed: order?.fulfillment === "delivery" ? "Delivered" : "Collected", rejected: "Order cancelled" };
  const eta = !privacyEnd && !terminal && order.confirmed_at && order.estimated_ready_at ? Date.parse(order.estimated_ready_at) : NaN;
  const etaLabel = Number.isFinite(eta) ? `${order.fulfillment === "delivery" ? "Delivery" : "Collection"} ${new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" }).format(new Date(eta))}` : !privacyEnd && !terminal ? "ETA after confirmation" : "";
  return { orderId: order.id, restaurantName: privacyEnd ? "Cal-Eats" : clean(order.restaurant_name), statusLabel: privacyEnd ? "Tracking ended" : labels[order.status] || "Order update", etaLabel, etaUnix: Number.isFinite(eta) ? Math.floor(eta / 1000) : null, fulfillment: order.fulfillment, updatedAtUnix: Math.floor((privacyEnd ? +now : Date.parse(order.updated_at)) / 1000) };
}

function access(db, session, config) {
  const user = requireRole(session, "customer");
  if (!session.native || session.nativeAudience !== "customer") throw new HttpError(403, "NATIVE_CUSTOMER_REQUIRED", "Use the signed-in customer app for live order tracking");
  const row = db.prepare("SELECT expires_at FROM native_sessions WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>? AND EXISTS(SELECT 1 FROM users WHERE id=? AND role='customer' AND account_enabled=1)").get(session.sessionId, user.id, config.now().toISOString(), user.id);
  if (!row) throw new HttpError(401, "AUTH_REQUIRED", "Sign in again to track your order");
  return { user, expiresAt: row.expires_at };
}
export function queueLiveActivity(db, row, revision, stamp) {
  db.prepare("INSERT INTO order_live_activity_outbox(activity_id,generation,revision,status,available_at,updated_at) VALUES(?,?,?,'pending',?,?) ON CONFLICT(activity_id) DO UPDATE SET generation=excluded.generation,revision=excluded.revision,status='pending',attempts=0,available_at=excluded.available_at,lease_owner=NULL,lease_expires_at=NULL,dispatch_started_at=NULL,last_error=NULL,apns_id=NULL,updated_at=excluded.updated_at").run(row.id, row.generation, revision, stamp, stamp);
}
export function endLiveActivityBinding(db, id, reason, stamp) {
  db.prepare("UPDATE customer_order_live_activities SET state='ending',end_reason=?,cleanup_until=?,updated_at=? WHERE id=? AND state='active'").run(reason, new Date(Date.parse(stamp) + 5 * 60000).toISOString(), stamp, id);
}
export function retireLiveActivityBinding(db, id, stamp, invalid = false) {
  db.prepare("UPDATE customer_order_live_activities SET state=?,ciphertext=NULL,nonce=NULL,auth_tag=NULL,updated_at=? WHERE id=?").run(invalid ? "invalid" : "ended", stamp, id);
}
export function decryptLiveActivityToken(config, row) {
  const key = keyFor(config); if (key.version !== row.key_version) throw new Error("Live Activity encryption key unavailable");
  const decipher = createDecipheriv("aes-256-gcm", key.key, Buffer.from(row.nonce, "base64")); decipher.setAAD(aad(row)); decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
  const token = Buffer.concat([decipher.update(Buffer.from(row.ciphertext, "base64")), decipher.final()]).toString("utf8");
  if (!tokenPattern.test(token) || hash(token) !== row.token_hash) throw new Error("Live Activity token binding is invalid"); return token;
}
export function orderLiveActivityReadiness(db, config) {
  const settings = config.orderLiveActivities ?? {};
  return { enabled: Boolean(settings.enabled), senderConfigured: Boolean(settings.teamId && settings.keyId && settings.privateKey), environment: "production", topic: LIVE_ACTIVITY_TOPIC, activityName: LIVE_ACTIVITY_NAME, maxHours: 8,
    activities: db.prepare("SELECT state,COUNT(*) count FROM customer_order_live_activities GROUP BY state").all(), queue: db.prepare("SELECT status,COUNT(*) count FROM order_live_activity_outbox GROUP BY status").all(), errors: db.prepare("SELECT last_error code,COUNT(*) count FROM order_live_activity_outbox WHERE last_error IS NOT NULL GROUP BY last_error LIMIT 10").all() };
}

export async function routeOrderLiveActivities({ req, res, url, db, config, session, checkRate }) {
  if (url.pathname === "/api/admin/live-activities/readiness" && req.method === "GET") { requireRole(session, "admin"); return sendJson(res, 200, { data: orderLiveActivityReadiness(db, config) }); }
  const match = url.pathname.match(/^\/api\/native\/live-activities(?:\/([^/]+))?$/); if (!match) return false;
  const granted = access(db, session, config); checkRate?.(req, `order-live-activities:${granted.user.id}`);
  const now = config.now(), stamp = now.toISOString(), settings = config.orderLiveActivities ?? {};
  if (req.method === "GET" && !match[1]) {
    const candidates = db.prepare("SELECT o.*,r.revision FROM orders o JOIN order_live_activity_revisions r ON r.order_id=o.id WHERE o.customer_id=? AND o.status IN ('placed','accepted','preparing','ready','out_for_delivery') AND o.created_at>? AND (o.scheduled_for IS NULL OR o.scheduled_for<=?) ORDER BY o.created_at DESC,o.id DESC LIMIT 30").all(granted.user.id, new Date(+now - LIVE_ACTIVITY_MAX_MS).toISOString(), new Date(+now + 2 * 3600000).toISOString());
    return sendJson(res, 200, { data: { updatesEnabled: Boolean(settings.enabled), items: candidates.filter(order => liveOrderCanStart(order, now)).slice(0, 10).map(order => ({ orderId: order.id, createdAt: order.created_at, scheduledFor: order.scheduled_for, serverRevision: order.revision, content: liveOrderContent(order, now) })) } });
  }
  if (req.method === "DELETE" && match[1]) {
    if (!activityIdPattern.test(match[1])) throw new HttpError(400, "VALIDATION_ERROR", "Live Activity ID is invalid");
    withTransaction(db, () => { access(db, session, config); const row = db.prepare("SELECT id FROM customer_order_live_activities WHERE activity_id=? AND user_id=? AND session_id=?").get(match[1], granted.user.id, session.sessionId); if (row) endLiveActivityBinding(db, row.id, "customer_ended", stamp); });
    return sendJson(res, 200, { data: { registered: false, activityId: match[1] } });
  }
  if (req.method !== "POST" || match[1]) throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET, POST or DELETE for live order tracking");
  const body = await readJson(req, config.bodyLimit); exactObject(body, ["installationId", "activityId", "orderId", "pushToken", "platform", "projectId"]);
  if (!["installationId", "activityId", "orderId", "pushToken", "platform", "projectId"].every(field => typeof body[field] === "string") || !uuid.test(body.installationId) || !uuid.test(body.orderId) || !activityIdPattern.test(body.activityId) || !tokenPattern.test(body.pushToken) || body.platform !== "ios" || body.projectId !== LIVE_ACTIVITY_PROJECT) throw new HttpError(400, "VALIDATION_ERROR", "Live order tracking registration is invalid");
  let key; try { key = keyFor(config); } catch { throw new HttpError(503, "LIVE_ACTIVITIES_UNAVAILABLE", "Live order tracking is temporarily unavailable"); }
  const result = withTransaction(db, () => {
    const current = access(db, session, config), instant = config.now(), at = instant.toISOString();
    const order = db.prepare("SELECT o.*,r.revision FROM orders o JOIN order_live_activity_revisions r ON r.order_id=o.id WHERE o.id=? AND o.customer_id=?").get(body.orderId.toLowerCase(), current.user.id);
    if (!order) throw new HttpError(404, "NOT_FOUND", "Order not found");
    const existing = db.prepare("SELECT * FROM customer_order_live_activities WHERE activity_id=?").get(body.activityId), tokenHash = hash(body.pushToken.toLowerCase()), installationId = body.installationId.toLowerCase();
    if (existing && (existing.user_id !== current.user.id || existing.order_id !== order.id || existing.installation_id !== installationId)) throw new HttpError(409, "LIVE_ACTIVITY_BINDING_MISMATCH", "Start a new Live Activity for this account and order");
    const content = liveOrderContent(order, instant);
    if (!liveOrderActive(order) || !existing && !liveOrderCanStart(order, instant) || existing && (existing.state !== "active" || existing.expires_at <= at)) return { registered: false, activityId: body.activityId, expiresAt: null, content, serverRevision: order.revision, updatesEnabled: Boolean(settings.enabled), action: "end" };
    if (db.prepare("SELECT 1 FROM customer_order_live_activities a JOIN native_sessions s ON s.id=a.session_id JOIN users u ON u.id=a.user_id WHERE a.installation_id=? AND a.user_id<>? AND a.state='active' AND s.revoked_at IS NULL AND s.expires_at>? AND u.account_enabled=1 AND u.role='customer' LIMIT 1").get(installationId, current.user.id, at)) throw new HttpError(409, "LIVE_ACTIVITY_INSTALLATION_IN_USE", "End tracking on the previous account before switching accounts");
    const tokenOwner = db.prepare("SELECT id FROM customer_order_live_activities WHERE token_hash=?").get(tokenHash);
    if (tokenOwner && tokenOwner.id !== existing?.id) throw new HttpError(409, "LIVE_ACTIVITY_TOKEN_IN_USE", "Start a new Live Activity for this order");
    if (!existing && db.prepare("SELECT COUNT(*) count FROM customer_order_live_activities WHERE user_id=? AND state='active' AND expires_at>?").get(current.user.id, at).count >= 10) throw new HttpError(429, "LIVE_ACTIVITY_LIMIT", "Too many orders are already being tracked");
    for (const old of db.prepare("SELECT id FROM customer_order_live_activities WHERE installation_id=? AND session_id<>? AND id<>? AND state='active'").all(installationId, session.sessionId, existing?.id ?? "")) endLiveActivityBinding(db, old.id, "session_changed", at);
    const unchanged = existing && existing.session_id === session.sessionId && existing.token_hash === tokenHash;
    const row = { id: existing?.id ?? randomUUID(), activity_id: body.activityId, installation_id: installationId, user_id: current.user.id, session_id: session.sessionId, order_id: order.id, project_id: LIVE_ACTIVITY_PROJECT, token_hash: tokenHash, generation: unchanged ? existing.generation : (existing?.generation ?? 0) + 1, key_version: key.version };
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key.key, nonce); cipher.setAAD(aad(row)); const ciphertext = Buffer.concat([cipher.update(body.pushToken.toLowerCase(), "utf8"), cipher.final()]);
    const expiresAt = existing?.expires_at ?? new Date(Math.min(Date.parse(current.expiresAt), +instant + LIVE_ACTIVITY_MAX_MS)).toISOString();
    db.prepare("INSERT INTO customer_order_live_activities(id,activity_id,installation_id,user_id,session_id,order_id,project_id,token_hash,ciphertext,nonce,auth_tag,key_version,generation,state,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,token_hash=excluded.token_hash,ciphertext=excluded.ciphertext,nonce=excluded.nonce,auth_tag=excluded.auth_tag,key_version=excluded.key_version,generation=excluded.generation,updated_at=excluded.updated_at").run(row.id, row.activity_id, row.installation_id, row.user_id, row.session_id, row.order_id, row.project_id, row.token_hash, ciphertext.toString("base64"), nonce.toString("base64"), cipher.getAuthTag().toString("base64"), key.version, row.generation, expiresAt, existing?.created_at ?? at, at);
    if (!unchanged || existing.sent_revision < order.revision) queueLiveActivity(db, row, order.revision, at);
    return { registered: true, activityId: body.activityId, expiresAt, content, serverRevision: order.revision, updatesEnabled: Boolean(settings.enabled), action: "update" };
  });
  return sendJson(res, 200, { data: result });
}

export async function runOrderLiveActivities(db, config, options) { return (await import("./order-live-activity-worker.js")).runOrderLiveActivityWorker(db, config, options); }
