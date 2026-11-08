import { createHash, randomUUID } from "node:crypto";
import { decryptMessage, encryptMessage, messageFingerprint } from "./message-encryption.js";
import { requireRole } from "./auth/authorization.js";
import { withTransaction } from "./db/index.js";
import { exactObject, HttpError, readJson, sendJson } from "./http.js";
import { queueCustomerEmailForNotification } from "./customer-emails.js";
import { blockedRestaurantNotification, restaurantContactBlocked } from "./customer-safety-policy.js";

const reasons = new Set(["inappropriate_message", "harassment", "misleading_menu", "unsafe_content", "other"]);
const clean = (value, min, max, label) => {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) throw new HttpError(400, "VALIDATION_ERROR", `${label} is invalid`);
  return value.trim();
};
const missing = () => new HttpError(404, "NOT_FOUND", "Restaurant or report context is unavailable");
function restaurant(db, customerId, id) {
  const row = db.prepare("SELECT id,name FROM restaurants r WHERE id=? AND (archived_at IS NULL OR EXISTS(SELECT 1 FROM orders o WHERE o.restaurant_id=r.id AND o.customer_id=?))").get(id, customerId);
  if (!row) throw missing();
  return row;
}
function context(db, userId, body) {
  const restaurantId = clean(body.restaurantId, 1, 100, "Restaurant"), shop = restaurant(db, userId, restaurantId);
  const orderId = body.orderId == null ? null : clean(body.orderId, 1, 100, "Order");
  const conversationId = body.conversationId == null ? null : clean(body.conversationId, 1, 100, "Conversation");
  const messageId = body.messageId == null ? null : clean(body.messageId, 1, 100, "Message");
  if (orderId && !db.prepare("SELECT 1 FROM orders WHERE id=? AND restaurant_id=? AND customer_id=?").get(orderId, restaurantId, userId)) throw missing();
  if (conversationId && !db.prepare("SELECT 1 FROM restaurant_customer_threads WHERE id=? AND restaurant_id=? AND customer_id=?").get(conversationId, restaurantId, userId)) throw missing();
  let messageSource = null, messageContext = null;
  if (messageId) {
    if (!orderId && !conversationId) throw new HttpError(400, "VALIDATION_ERROR", "A reported message needs its conversation");
    messageSource = conversationId && db.prepare("SELECT * FROM restaurant_customer_messages WHERE id=? AND thread_id=? AND sender_role='restaurant'").get(messageId, conversationId);
    if(messageSource)messageContext=`customer-thread:${conversationId}`;
    else if(orderId){messageSource=db.prepare("SELECT * FROM order_messages WHERE id=? AND order_id=? AND sender_role='restaurant'").get(messageId,orderId);messageContext=orderId;}
    if (!messageSource) throw missing();
  }
  return { restaurantId, shop, orderId, conversationId, messageId, messageSource, messageContext };
}
function notify(db, userId, caseId, kind, event, stamp) {
  const inserted = db.prepare("INSERT OR IGNORE INTO user_notifications(id,user_id,type,title,message,event_key,created_at,support_case_id) VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(), userId, kind, kind === "support_request" ? "Restaurant safety report" : "Your report was sent", kind === "support_request" ? "A customer report needs Cal-Eats review. Open the private support conversation." : "Cal-Eats support has received your report. Follow replies in your help requests.", event, stamp, caseId);
  if (inserted.changes) queueCustomerEmailForNotification(db, userId, event);
}
function suppressPendingContact(db, userId, stamp) {
  for (const n of db.prepare("SELECT * FROM user_notifications WHERE user_id=? AND read_at IS NULL").all(userId)) {
    if (!blockedRestaurantNotification(db, n)) continue;
    db.prepare("UPDATE user_notifications SET read_at=? WHERE id=? AND user_id=?").run(stamp, n.id, userId);
    db.prepare("UPDATE customer_push_outbox SET status='cancelled',last_error='RESTAURANT_CONTACT_BLOCKED',updated_at=? WHERE notification_id=? AND (status='pending' OR (status='claimed' AND dispatch_started_at IS NULL))").run(stamp, n.id);
    db.prepare("UPDATE customer_transactional_email_outbox SET status='cancelled',last_error='RESTAURANT_CONTACT_BLOCKED',updated_at=? WHERE notification_id=? AND (status='pending' OR (status='claimed' AND dispatch_started_at IS NULL))").run(stamp, n.id);
  }
}
export async function routeCustomerSafety({ req, res, url, db, config, session }) {
  const match = url.pathname.match(/^\/api\/customer-safety\/restaurants\/([^/]+)$/), reports = url.pathname === "/api/customer-safety/reports";
  if (!match && !reports) return false;
  const user = requireRole(session, "customer");
  if (match && ["GET", "PUT"].includes(req.method)) {
    const shop = restaurant(db, user.id, clean(match[1], 1, 100, "Restaurant"));
    if (req.method === "PUT") {
      const body = await readJson(req, config.bodyLimit); exactObject(body, ["blocked"]);
      if (typeof body.blocked !== "boolean") throw new HttpError(400, "VALIDATION_ERROR", "Blocked must be true or false");
      const stamp = config.now().toISOString();
      withTransaction(db, () => {
        db.prepare("INSERT INTO customer_restaurant_safety(customer_id,restaurant_id,blocked,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(customer_id,restaurant_id) DO UPDATE SET blocked=excluded.blocked,updated_at=excluded.updated_at").run(user.id, shop.id, body.blocked ? 1 : 0, stamp, stamp);
        if (body.blocked) suppressPendingContact(db, user.id, stamp);
      });
    }
    return sendJson(res, 200, { data: { restaurantId: shop.id, blocked: restaurantContactBlocked(db, user.id, shop.id) } });
  }
  if (reports && req.method === "POST") {
    const body = await readJson(req, config.bodyLimit); exactObject(body, ["restaurantId", "orderId", "conversationId", "messageId", "reason", "details"]);
    const scoped = context(db, user.id, body), reason = clean(body.reason, 1, 50, "Reason"), details = clean(body.details ?? "", 0, 1200, "Details");
    if (!reasons.has(reason)) throw new HttpError(400, "VALIDATION_ERROR", "Report reason is invalid");
    const key = clean(req.headers["idempotency-key"], 8, 150, "Retry key"), hash = createHash("sha256").update(JSON.stringify({ restaurantId:scoped.restaurantId, orderId:scoped.orderId, conversationId:scoped.conversationId, messageId:scoped.messageId, reason, details })).digest("hex");
    const prior = db.prepare("SELECT s.id,s.request_hash,r.case_id safety_case FROM support_cases s LEFT JOIN customer_safety_reports r ON r.case_id=s.id WHERE s.user_id=? AND s.idempotency_key=?").get(user.id, key);
    if (prior) {
      if (!prior.safety_case || prior.request_hash !== hash) throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "This retry key belongs to another report");
      return sendJson(res, 200, { data: { supportCaseId: prior.id, reference: prior.id.slice(0, 8).toUpperCase(), recipient: "Cal-Eats support" } });
    }
    const id = randomUUID(), stamp = config.now().toISOString();
    let evidence=null;
    if(scoped.messageSource){
      const content=`Reported restaurant message\n${await decryptMessage(config,{...scoped.messageSource,order_id:scoped.messageContext})}`,evidenceId=randomUUID(),orderId=`support:${id}`;
      evidence={id:evidenceId,hash:messageFingerprint(config,orderId,content),encrypted:await encryptMessage(config,content,{id:evidenceId,orderId,senderUserId:user.id,createdAt:stamp,expiresAt:""})};
    }
    withTransaction(db, () => {
      context(db,user.id,body);
      const count = db.prepare("SELECT COUNT(*) n FROM customer_safety_reports WHERE customer_id=? AND created_at>?").get(user.id, new Date(Date.parse(stamp) - 3600000).toISOString()).n;
      if (count >= 10) throw new HttpError(429, "REPORT_RATE_LIMITED", "Please wait before sending another report");
      const message = `Restaurant: ${scoped.shop.name}\nReason: ${reason.replaceAll("_", " ")}\n${details}${scoped.messageId ? `\nReported message: ${scoped.messageId}` : ""}${scoped.conversationId ? `\nConversation: ${scoped.conversationId}` : ""}`;
      // NULL restaurant assignment is deliberate: a reported merchant must never
      // receive the report or gain access through normal restaurant support APIs.
      db.prepare("INSERT INTO support_cases(id,user_id,order_id,subject,message,status,created_at,updated_at,restaurant_id,waiting_for,idempotency_key,request_hash,requester_restaurant_id) VALUES(?,?,?,?,?,'open',?,?,NULL,'team',?,?,NULL)").run(id, user.id, scoped.orderId, `Restaurant report · ${scoped.shop.name}`.slice(0, 150), message, stamp, stamp, key, hash);
      db.prepare("INSERT INTO customer_safety_reports(case_id,customer_id,restaurant_id,order_id,conversation_id,message_id,reason,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, user.id, scoped.restaurantId, scoped.orderId, scoped.conversationId, scoped.messageId, reason, stamp);
      if(evidence){const e=evidence.encrypted;db.prepare("INSERT INTO support_case_messages(id,case_id,sender_user_id,sender_role,idempotency_key,request_hash,ciphertext,nonce,auth_tag,key_version,created_at) VALUES(?,?,?,'customer',?,?,?,?,?,?,?)").run(evidence.id,id,user.id,`customer-safety-evidence:${id}`,evidence.hash,e.ciphertext,e.nonce,e.authTag,e.keyVersion,stamp);}
      for (const admin of db.prepare("SELECT id FROM users WHERE role='admin' AND account_enabled=1").all()) notify(db, admin.id, id, "support_request", `support:${id}:created`, stamp);
      notify(db, user.id, id, "support_receipt", `support:${id}:receipt`, stamp);
    });
    return sendJson(res, 201, { data: { supportCaseId: id, reference: id.slice(0, 8).toUpperCase(), recipient: "Cal-Eats support" } });
  }
  return false;
}
