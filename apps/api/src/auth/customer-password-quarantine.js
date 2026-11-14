import { randomUUID } from "node:crypto";
import { requireRole } from "./authorization.js";
import { verifyPassword } from "./passwords.js";
import { revokeUserSessions } from "./session-management.js";
import { withTransaction } from "../db/index.js";
import { HttpError } from "../http.js";
import { VALIDATION } from "../../../../packages/contracts/src/index.js";

const policy = "legacy-customer-password-reset-v1";
const failure = (code, message, status = 409) => new HttpError(status, code, message);
export function assertCustomerPasswordReady(user) {
  if (user?.role === "customer" && user.password_reset_required === 1) {
    throw failure("PASSWORD_RESET_REQUIRED", "For your security, use Forgot password to reset your password before signing in.", 403);
  }
}

/** Explicit, bounded administrative maintenance. It never discovers targets,
 * changes passwords, sends mail or removes customer/order/financial records. */
export async function quarantineLegacyCustomerPasswords(db, config, session, { userIds, knownWeakPassword, reason, requestKey } = {}) {
  const admin = requireRole(session, "admin");
  if (!db.prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND account_enabled=1").get(admin.id)) throw failure("FORBIDDEN", "An active administrator is required.", 403);
  if (!Array.isArray(userIds) || !userIds.length || userIds.length > 25 || new Set(userIds).size !== userIds.length || userIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(id))) throw failure("VALIDATION_ERROR", "Choose an explicit list of up to 25 customer accounts.", 400);
  if (typeof knownWeakPassword !== "string" || !knownWeakPassword.length || knownWeakPassword.length >= VALIDATION.passwordMin || typeof reason !== "string" || reason.trim().length < 10 || reason.trim().length > 500 || /[\u0000-\u001f\u007f]/.test(reason) || typeof requestKey !== "string" || !/^[A-Za-z0-9:_-]{8,150}$/.test(requestKey)) throw failure("VALIDATION_ERROR", "A scoped request reference and security reason are required.", 400);
  const targets = [...userIds].sort(), details = { policy, userIds: targets, reason: reason.trim() };
  const replay = () => {
    const previous = db.prepare("SELECT details FROM audit_events WHERE actor_user_id=? AND entity_type='customer_security' AND entity_id=? AND action='legacy_customer_password_quarantined' LIMIT 1").get(admin.id, requestKey);
    if (!previous) return null;
    if (JSON.stringify(JSON.parse(previous.details).request) !== JSON.stringify(details)) throw failure("IDEMPOTENCY_CONFLICT", "This security request reference was already used for different accounts.");
    return { alreadyApplied: true, userIds: targets, accountsChanged: 0, revokedSessions: 0 };
  };
  const existing = replay(); if (existing) return existing;
  const verified = [];
  for (const id of targets) {
    const row = db.prepare("SELECT id,role,account_enabled,password_hash FROM users WHERE id=?").get(id);
    if (!row || row.role !== "customer" || !row.account_enabled || !await verifyPassword(knownWeakPassword, row.password_hash)) throw failure("CUSTOMER_SECURITY_SCOPE_MISMATCH", "Every selected account must be an active customer matching the reviewed legacy credential.");
    verified.push(row);
  }
  return withTransaction(db, () => {
    if (!db.prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND account_enabled=1").get(admin.id)) throw failure("FORBIDDEN", "An active administrator is required.", 403);
    const existing = replay(); if (existing) return existing;
    // Password verification is outside the transaction. Recheck its exact
    // binding before applying any flag, so a simultaneous reset wins safely.
    for (const row of verified) {
      const fresh = db.prepare("SELECT role,account_enabled,password_hash FROM users WHERE id=?").get(row.id);
      if (!fresh || fresh.role !== "customer" || !fresh.account_enabled || fresh.password_hash !== row.password_hash) throw failure("CUSTOMER_SECURITY_SCOPE_CHANGED", "An account changed during the security check. Review the selected accounts again.");
    }
    const stamp = config.now().toISOString(); let accountsChanged = 0, revokedSessions = 0;
    for (const row of verified) {
      accountsChanged += db.prepare("UPDATE users SET password_reset_required=1 WHERE id=? AND password_reset_required=0").run(row.id).changes;
      revokedSessions += revokeUserSessions(db, row.id, stamp);
    }
    db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(), admin.id, "customer_security", requestKey, "legacy_customer_password_quarantined", JSON.stringify({ request: details, accountsChanged, revokedSessions }), stamp);
    return { alreadyApplied: false, userIds: targets, accountsChanged, revokedSessions };
  });
}

export function validateQuarantinedCustomerReset(user, password) {
  if (user?.role !== "customer" || user.password_reset_required !== 1) return;
  if (password.length < VALIDATION.passwordMin || password.length > VALIDATION.passwordMax || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password) || /[\u0000-\u001f\u007f]/.test(password) || /^(?:password|qwerty|letmein|welcome|123456)/i.test(password)) throw failure("VALIDATION_ERROR", "Choose a new password of 12–200 characters with letters and numbers; avoid common passwords.", 400);
}

export function recordCustomerPasswordResetCompletion(db, user, stamp) {
  if (user?.role !== "customer" || user.password_reset_required !== 1) return;
  db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(), user.user_id, "user", user.user_id, "customer_password_reset_completed", JSON.stringify({ policy, resetRequiredCleared: true }), stamp);
}
