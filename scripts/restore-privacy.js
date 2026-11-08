import { createHash } from "node:crypto";
import fs from "node:fs";

const present = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
const columns = (db, name) => new Set(db.prepare(`PRAGMA table_info(${name})`).all().map(row => row.name));
const canonicalDate = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const identifier = value => typeof value === "string" && value.length > 0 && value.length <= 200;

// Export from the CURRENT authoritative environment, not from the backup being
// restored. Keep this minimal ledger separate from old provider/managed backups.
// No names, emails, addresses, messages, access tokens or allergy notes belong here.
export function exportPrivacySuppressionLedger(db, now = new Date()) {
  if (!present(db, "customer_erasure_tombstones") || !present(db, "customer_erasure_holds")) throw new Error("Current privacy suppression schema is required");
  return {
    format: "cal-eats-privacy-suppression-v1", generatedAt: now.toISOString(),
    tombstones: db.prepare("SELECT user_id AS userId,request_id AS requestId,completed_at AS completedAt,policy_version AS policyVersion FROM customer_erasure_tombstones ORDER BY user_id").all(),
    holds: db.prepare("SELECT id,user_id AS userId,reason_code AS reasonCode,created_by AS createdBy,created_at AS createdAt,expires_at AS expiresAt FROM customer_erasure_holds WHERE released_at IS NULL ORDER BY id").all()
  };
}
export function validatePrivacySuppressionLedger(ledger) {
  if (!ledger || ledger.format !== "cal-eats-privacy-suppression-v1" || !canonicalDate(ledger.generatedAt) || !Array.isArray(ledger.tombstones) || !Array.isArray(ledger.holds) || ledger.tombstones.length > 1000000 || ledger.holds.length > 1000000) throw new Error("Privacy suppression ledger is invalid");
  const users = new Set(), holds = new Set();
  for (const row of ledger.tombstones) {
    if (!identifier(row.userId) || !identifier(row.requestId) || !identifier(row.policyVersion) || !canonicalDate(row.completedAt) || row.completedAt > ledger.generatedAt || users.has(row.userId)) throw new Error("Privacy suppression tombstone is invalid");
    users.add(row.userId);
  }
  for (const row of ledger.holds) {
    if (!identifier(row.id) || !identifier(row.userId) || !identifier(row.reasonCode) || !identifier(row.createdBy) || !canonicalDate(row.createdAt) || row.createdAt > ledger.generatedAt || row.expiresAt !== null && !canonicalDate(row.expiresAt) || holds.has(row.id)) throw new Error("Privacy suppression hold is invalid");
    holds.add(row.id);
  }
  return ledger;
}
export function loadPinnedPrivacySuppressionLedger(filename, expectedSha256) {
  if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("Provide the independently verified SHA-256 for the current suppression ledger");
  const bytes = fs.readFileSync(filename);
  if (bytes.length > 64 * 1024 * 1024) throw new Error("Privacy suppression ledger is too large");
  if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) throw new Error("Privacy suppression ledger does not match its verified SHA-256");
  return validatePrivacySuppressionLedger(JSON.parse(bytes.toString("utf8")));
}

// This is a read-only quarantine gate. It never re-erases, repairs, restores or
// starts services. A restored old snapshot may need approved suppression replay
// using the erasure engine plus re-applied current holds, followed by this check.
// The caller must confirm this ledger came from the current environment; a hash
// proves file integrity, not freshness or operator/source authenticity.
export function assertPrivacySuppressionSafe(db, input, { now = new Date(), maxLedgerAgeHours = 24 } = {}) {
  const ledger = validatePrivacySuppressionLedger(input);
  if (!Number.isFinite(maxLedgerAgeHours) || maxLedgerAgeHours <= 0 || Date.parse(ledger.generatedAt) > now.getTime() || now.getTime() - Date.parse(ledger.generatedAt) > maxLedgerAgeHours * 3600000) throw new Error("A current independently verified privacy suppression ledger is required");
  const findings = new Map(), add = (kind, amount = 1) => { if (amount) findings.set(kind, (findings.get(kind) ?? 0) + amount); };
  for (const item of ledger.tombstones) {
    const user = db.prepare("SELECT * FROM users WHERE id=?").get(item.userId);
    if (user && (user.role !== "customer" || user.account_enabled !== 0 || user.name !== "Deleted customer" || user.email !== `deleted-${item.userId}@account.invalid` || user.password_hash !== "!deleted" || user.phone || user.email_verified_at || user.merchant_offers)) add("account_identifiers");
    const tombstone = present(db, "customer_erasure_tombstones") && db.prepare("SELECT * FROM customer_erasure_tombstones WHERE user_id=?").get(item.userId);
    if (user && (!tombstone || tombstone.request_id !== item.requestId || tombstone.completed_at !== item.completedAt || tombstone.policy_version !== item.policyVersion)) add("suppression_tombstones_missing");
    if (present(db, "orders")) add("order_contact_or_allergy_copies", db.prepare("SELECT count(*) AS n FROM orders WHERE customer_id=? AND (customer_name<>'' OR customer_email<>'' OR customer_phone<>'' OR delivery_instructions<>'' OR allergy_notes<>'' OR COALESCE(delivery_address,'')<>'')").get(item.userId).n);
    if (present(db, "support_cases")) {
      add("support_original_bodies", db.prepare("SELECT count(*) AS n FROM support_cases WHERE user_id=? AND (subject<>'Account data removed' OR message<>'')").get(item.userId).n);
      if (present(db, "support_case_messages")) add("support_reply_bodies", db.prepare("SELECT count(*) AS n FROM support_case_messages WHERE case_id IN (SELECT id FROM support_cases WHERE user_id=?)").get(item.userId).n);
    }
    for (const [table, key] of [["customer_restaurant_safety","customer_id"],["customer_safety_reports","customer_id"],["sessions","user_id"],["native_sessions","user_id"],["customer_push_devices","user_id"],["customer_push_outbox","user_id"],["account_addresses","user_id"],["customer_addresses","user_id"],["saved_addresses","user_id"],["marketing_preferences","user_id"],["user_notifications","user_id"],["customer_transactional_email_outbox","customer_id"],["restaurant_customer_messages","sender_user_id"],["order_messages","sender_user_id"]]) {
      if (present(db, table) && columns(db, table).has(key)) add(`restored_${table}`, db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${key}=?`).get(item.userId).n);
    }
    if (present(db, "order_messages")) add("restored_order_thread_bodies", db.prepare("SELECT count(*) AS n FROM order_messages WHERE order_id IN (SELECT id FROM orders WHERE customer_id=?)").get(item.userId).n);
    if (present(db, "restaurant_customer_messages")) add("restored_customer_thread_bodies", db.prepare("SELECT count(*) AS n FROM restaurant_customer_messages WHERE thread_id IN (SELECT id FROM restaurant_customer_threads WHERE customer_id=?)").get(item.userId).n);
    if (present(db, "device_print_jobs")) add("restored_print_copies", db.prepare("SELECT count(*) AS n FROM device_print_jobs WHERE order_id IN (SELECT id FROM orders WHERE customer_id=?)").get(item.userId).n);
    if (present(db, "customer_erasure_confirmation_outbox")) add("restored_completion_recipient", db.prepare("SELECT count(*) AS n FROM customer_erasure_confirmation_outbox WHERE request_id=? AND ciphertext IS NOT NULL").get(item.requestId).n);
  }
  for (const hold of ledger.holds) {
    if (hold.expiresAt && hold.expiresAt <= now.toISOString()) continue;
    const restored = present(db, "customer_erasure_holds") && db.prepare("SELECT * FROM customer_erasure_holds WHERE id=?").get(hold.id);
    if (!restored || restored.user_id !== hold.userId || restored.reason_code !== hold.reasonCode || restored.created_by !== hold.createdBy || restored.created_at !== hold.createdAt || restored.expires_at !== hold.expiresAt || restored.released_at !== null) add("current_holds_missing");
  }
  if (findings.size) {
    const error = new Error(`Restore remains quarantined: privacy suppression is incomplete (${[...findings].map(([kind, count]) => `${kind}: ${count}`).join(", ")}). Apply the independently verified current suppression/hold records under the approved recovery procedure and check again.`);
    error.code = "PRIVACY_RESTORE_SUPPRESSION_REQUIRED"; error.findings = Object.fromEntries(findings); throw error;
  }
  return { status: "cleared", ledgerGeneratedAt: ledger.generatedAt, tombstonesChecked: ledger.tombstones.length, holdsChecked: ledger.holds.length };
}
