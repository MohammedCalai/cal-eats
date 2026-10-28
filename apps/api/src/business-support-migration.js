export const businessSupportMigration24 = {
  version: 24,
  name: "business_native_sessions_and_routed_support",
  sql: `
CREATE TABLE native_business_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
);
CREATE INDEX native_business_sessions_user_idx ON native_business_sessions(user_id,expires_at);
ALTER TABLE support_cases ADD COLUMN restaurant_id TEXT REFERENCES restaurants(id);
ALTER TABLE support_cases ADD COLUMN waiting_for TEXT NOT NULL DEFAULT 'team' CHECK(waiting_for IN ('team','customer','none'));
ALTER TABLE support_cases ADD COLUMN idempotency_key TEXT;
ALTER TABLE support_cases ADD COLUMN request_hash TEXT;
UPDATE support_cases SET waiting_for='none' WHERE status='resolved';
UPDATE support_cases SET restaurant_id=(SELECT restaurant_id FROM orders WHERE id=support_cases.order_id)
WHERE order_id IS NOT NULL AND EXISTS(SELECT 1 FROM users WHERE id=support_cases.user_id AND role='customer');
CREATE UNIQUE INDEX support_request_retry_idx ON support_cases(user_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX support_user_updated_idx ON support_cases(user_id,updated_at DESC,id DESC);
CREATE INDEX support_restaurant_updated_idx ON support_cases(restaurant_id,status,updated_at DESC,id DESC);
CREATE TABLE support_case_messages (
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  sender_user_id TEXT NOT NULL REFERENCES users(id), sender_role TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  ciphertext TEXT NOT NULL, nonce TEXT NOT NULL, auth_tag TEXT NOT NULL, key_version TEXT NOT NULL,
  created_at TEXT NOT NULL, UNIQUE(case_id,sender_user_id,idempotency_key)
);
CREATE INDEX support_case_messages_idx ON support_case_messages(case_id,created_at,id);
CREATE TABLE support_message_rate_limits (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, window_start_ms INTEGER NOT NULL, request_count INTEGER NOT NULL);
ALTER TABLE user_notifications ADD COLUMN support_case_id TEXT REFERENCES support_cases(id);
CREATE INDEX support_notification_idx ON user_notifications(user_id,support_case_id,read_at);
INSERT OR IGNORE INTO user_notifications(id,user_id,type,title,message,order_id,restaurant_id,event_key,created_at,support_case_id)
SELECT 'support-backfill-'||s.id||'-'||u.id,u.id,'support_request','Support request needs a reply',s.subject,s.order_id,s.restaurant_id,'support:'||s.id||':created',s.created_at,s.id
FROM support_cases s JOIN users u ON u.role='admin' AND u.account_enabled=1 WHERE s.status='open';
`
};
