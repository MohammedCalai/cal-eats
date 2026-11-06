import { randomUUID } from "node:crypto";
import { requireRole } from "./auth/authorization.js";
import { revokeUserSessions } from "./auth/session-management.js";
import { withTransaction } from "./db/index.js";
import { exactObject, HttpError, readJson, sendJson } from "./http.js";

const ACTION = "account_login_closed_verified";

export function verifiedLoginClosure(db, requestId) {
  const row = db.prepare("SELECT details FROM audit_events WHERE entity_type='deletion_request' AND entity_id=? AND action=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(requestId, ACTION);
  return row ? JSON.parse(row.details) : null;
}

function assertCustomerWorkComplete(db, userId) {
  const active = db.prepare("SELECT 1 FROM orders WHERE customer_id=? AND status IN ('placed','accepted','preparing','ready','out_for_delivery') LIMIT 1").get(userId);
  const payment = db.prepare("SELECT 1 FROM stripe_order_payments p JOIN orders o ON o.id=p.order_id WHERE o.customer_id=? AND p.status IN ('pending','authorized','unknown') LIMIT 1").get(userId);
  const operation = db.prepare("SELECT 1 FROM marketplace_operations m JOIN orders o ON o.id=m.order_id WHERE o.customer_id=? AND m.kind IN ('payment_capture','payment_cancel','payment_cancellation','order_refund') AND (m.status IN ('pending','delayed','held','unknown') OR (m.kind='order_refund' AND m.status='failed')) LIMIT 1").get(userId);
  const remedy = db.prepare("SELECT 1 FROM refund_cases WHERE customer_id=? AND resolved_at IS NULL AND status NOT IN ('rejected','refunded') LIMIT 1").get(userId);
  const refundJob = db.prepare("SELECT 1 FROM marketplace_worker_jobs j JOIN refund_cases c ON c.id=j.entity_id WHERE c.customer_id=? AND j.kind IN ('refund_execution','stripe_refund') AND j.status IN ('queued','delayed','claimed','failed') LIMIT 1").get(userId);
  if (active || payment || operation || remedy || refundJob) throw new HttpError(409, "ACCOUNT_CLOSURE_BLOCKED", "Complete this customer's active orders, unsettled payments and open order support before closing their login.");
}

export async function handleVerifiedAccountClosure({ req, res, url, db, config, session }) {
  const match = url.pathname.match(/^\/api\/admin\/deletion-requests\/([^/]+)\/close-account$/);
  if (!match || req.method !== "POST") return false;
  const admin = requireRole(session, "admin"), body = await readJson(req, config.bodyLimit);
  exactObject(body, ["note"]);
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length < 20 || note.length > 1000) throw new HttpError(400, "VALIDATION_ERROR", "Enter a verification note of 20 to 1000 characters explaining how support verified the customer's closure request.");
  const data = withTransaction(db, () => {
    const target = db.prepare("SELECT d.*,u.role,u.account_enabled FROM deletion_requests d JOIN users u ON u.id=d.user_id WHERE d.id=?").get(match[1]);
    if (!target) throw new HttpError(404, "NOT_FOUND", "Deletion request not found");
    if (target.role !== "customer" || db.prepare("SELECT 1 FROM restaurant_memberships WHERE user_id=? LIMIT 1").get(target.user_id)) throw new HttpError(409, "CUSTOMER_CLOSURE_ONLY", "This verified closure action is for customer accounts only. Business and administrator access requires a separate review.");
    const completed = verifiedLoginClosure(db, target.id);
    if (completed) {
      if (target.account_enabled) throw new HttpError(409, "ACCOUNT_REOPENED", "This login was deliberately reopened after closure. Support must verify a new closure request; retrying the old request will not close it again.");
      return completed;
    }
    if (target.status === "resolved") throw new HttpError(409, "DELETION_REVIEW_RESOLVED", "Reopen this deletion review before verifying customer login closure.");
    assertCustomerWorkComplete(db, target.user_id);
    const now = config.now().toISOString();
    db.prepare("UPDATE users SET account_enabled=0,merchant_offers=0 WHERE id=?").run(target.user_id);
    revokeUserSessions(db, target.user_id, now);
    db.prepare("UPDATE account_access_tokens SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL").run(now, target.user_id);
    db.prepare("UPDATE account_access_email_outbox SET status='cancelled',last_error='ACCOUNT_LOGIN_CLOSED',next_attempt_at=NULL,ciphertext=NULL,nonce=NULL,auth_tag=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE user_id=? AND (status IN ('pending','failed') OR (status='claimed' AND dispatch_started_at IS NULL))").run(now, target.user_id);
    db.prepare("UPDATE marketing_preferences SET in_app_promotions=0,push_promotions=0,consent_source='support-verified-login-closure',consented_at=NULL,updated_at=? WHERE user_id=?").run(now, target.user_id);
    db.prepare("UPDATE deletion_requests SET status='under_review',note=?,updated_at=? WHERE id=?").run(note, now, target.id);
    const closure = { requestId: target.id, userId: target.user_id, status: "login_closed", accountEnabled: false, dataReviewStatus: "under_review", closedAt: now, note, retainedRecords: true };
    db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(), admin.id, "deletion_request", target.id, ACTION, JSON.stringify(closure), now);
    return closure;
  });
  return sendJson(res, 200, { data });
}
