// Intentionally inert until the separately reviewed privacy policy is enabled.
const guardedTables = [
  ["saved_addresses", "NEW.user_id"], ["sessions", "NEW.user_id"],
  ["native_sessions", "NEW.user_id"], ["native_business_sessions", "NEW.user_id"],
  ["account_access_tokens", "NEW.user_id"], ["account_access_email_outbox", "NEW.user_id"],
  ["marketing_preferences", "NEW.user_id"], ["customer_push_devices", "NEW.user_id"],
  ["customer_push_outbox", "NEW.user_id"], ["customer_order_live_activities", "NEW.user_id"],
  ["customer_transactional_email_outbox", "NEW.customer_id"],
  ["restaurant_customer_workflows", "NEW.customer_id"], ["restaurant_customer_threads", "NEW.customer_id"],
  ["restaurant_order_ratings", "NEW.customer_id"], ["orders", "NEW.customer_id"],
  ["order_messages", "(SELECT customer_id FROM orders WHERE id=NEW.order_id)"],
  ["support_case_messages", "(SELECT user_id FROM support_cases WHERE id=NEW.case_id)"],
  ["restaurant_customer_messages", "(SELECT customer_id FROM restaurant_customer_threads WHERE id=NEW.thread_id)"],
  ["support_cases", "NEW.user_id"], ["offer_grants", "NEW.customer_id"],
  ["platform_vouchers", "NEW.customer_id"]
];

export const customerErasureMigration47 = {
  version: 47,
  name: "reviewed_customer_erasure_and_restore_suppression",
  sql: `
CREATE TABLE customer_erasure_requests (
  request_id TEXT PRIMARY KEY REFERENCES deletion_requests(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  verified_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('requested','completed')),
  completed_at TEXT
);
CREATE UNIQUE INDEX customer_erasure_one_pending_idx ON customer_erasure_requests(user_id) WHERE status='requested';
CREATE TABLE customer_erasure_holds (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  reason_code TEXT NOT NULL CHECK(reason_code IN ('legal_claim','fraud_investigation','dispute','statutory_requirement')),
  created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  expires_at TEXT, released_at TEXT
);
CREATE INDEX customer_erasure_holds_customer_idx ON customer_erasure_holds(user_id,released_at,expires_at);
CREATE TABLE customer_erasure_tombstones (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  request_id TEXT NOT NULL UNIQUE REFERENCES customer_erasure_requests(request_id),
  completed_at TEXT NOT NULL, policy_version TEXT NOT NULL,
  retained_classes TEXT NOT NULL, counts_json TEXT NOT NULL,
  reviewed_by TEXT NOT NULL REFERENCES users(id), review_note TEXT NOT NULL
);
CREATE TABLE customer_erasure_confirmation_outbox (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES customer_erasure_requests(request_id),
  ciphertext TEXT, nonce TEXT, auth_tag TEXT, key_version TEXT NOT NULL,
  mode TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','claimed','sent','local_saved','failed','unknown','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_expires_at TEXT, dispatch_started_at TEXT,
  last_error TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, sent_at TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX customer_erasure_confirmation_pending_idx ON customer_erasure_confirmation_outbox(status,created_at);
CREATE TRIGGER customer_erasure_tombstone_immutable BEFORE UPDATE ON customer_erasure_tombstones BEGIN
 SELECT RAISE(ABORT,'Customer erasure tombstones are immutable');
END;
CREATE TRIGGER customer_erasure_tombstone_no_delete BEFORE DELETE ON customer_erasure_tombstones BEGIN
 SELECT RAISE(ABORT,'Customer erasure suppression evidence must be preserved');
END;
CREATE TRIGGER customer_erased_profile_no_restore BEFORE UPDATE ON users
 WHEN EXISTS(SELECT 1 FROM customer_erasure_tombstones WHERE user_id=OLD.id)
 AND (NEW.name<>OLD.name OR NEW.email<>OLD.email OR NEW.password_hash<>OLD.password_hash
      OR NEW.phone<>OLD.phone OR NEW.account_enabled<>0 OR NEW.merchant_offers<>0
      OR NEW.email_verified_at IS NOT NULL OR NEW.role<>OLD.role)
 BEGIN SELECT RAISE(ABORT,'Erased customer profiles cannot be restored'); END;
${guardedTables.map(([table, expression]) => `CREATE TRIGGER customer_erased_${table}_no_insert BEFORE INSERT ON ${table}
 WHEN EXISTS(SELECT 1 FROM customer_erasure_tombstones WHERE user_id=${expression})
 BEGIN SELECT RAISE(ABORT,'Customer account has been erased'); END;`).join("\n")}
CREATE TRIGGER customer_erased_order_no_contact_restore BEFORE UPDATE ON orders
 WHEN EXISTS(SELECT 1 FROM customer_erasure_tombstones WHERE user_id=NEW.customer_id)
 AND (NEW.customer_name<>'' OR NEW.customer_email<>'' OR NEW.customer_phone<>''
      OR COALESCE(NEW.delivery_address,'')<>'' OR NEW.delivery_instructions<>'' OR NEW.allergy_notes<>'')
 BEGIN SELECT RAISE(ABORT,'Erased order contact information cannot be restored'); END;
CREATE TRIGGER customer_erased_support_no_content_restore BEFORE UPDATE ON support_cases
 WHEN EXISTS(SELECT 1 FROM customer_erasure_tombstones WHERE user_id=NEW.user_id OR user_id IN (SELECT customer_id FROM orders WHERE id=NEW.order_id))
 AND (NEW.message<>'' OR NEW.subject<>'Account data removed')
 BEGIN SELECT RAISE(ABORT,'Erased support content cannot be restored'); END;
CREATE TRIGGER customer_erased_notification_no_insert BEFORE INSERT ON user_notifications
 WHEN EXISTS(SELECT 1 FROM customer_erasure_tombstones WHERE user_id=NEW.user_id OR user_id=NEW.customer_id OR user_id IN (SELECT customer_id FROM orders WHERE id=NEW.order_id))
 BEGIN SELECT RAISE(ABORT,'Customer account has been erased'); END;
CREATE TRIGGER customer_erased_order_support_no_insert BEFORE INSERT ON support_cases
 WHEN EXISTS(SELECT 1 FROM customer_erasure_tombstones WHERE user_id IN (SELECT customer_id FROM orders WHERE id=NEW.order_id))
 BEGIN SELECT RAISE(ABORT,'Customer account has been erased'); END;
CREATE TRIGGER customer_erased_order_support_message_no_insert BEFORE INSERT ON support_case_messages
 WHEN EXISTS(SELECT 1 FROM customer_erasure_tombstones WHERE user_id IN (SELECT o.customer_id FROM orders o JOIN support_cases c ON c.order_id=o.id WHERE c.id=NEW.case_id))
 BEGIN SELECT RAISE(ABORT,'Customer account has been erased'); END;
`
};
