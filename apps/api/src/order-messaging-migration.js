export const orderMessagingMigration19 = {
  version: 19,
  name: "encrypted_order_messaging",
  sql: `
CREATE TABLE order_message_settings (
  restaurant_id TEXT PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  quick_responses TEXT NOT NULL,
  support_window_minutes INTEGER NOT NULL DEFAULT 120 CHECK(support_window_minutes BETWEEN 0 AND 1440),
  updated_by_user_id TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);
CREATE TABLE order_messages (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sender_user_id TEXT NOT NULL REFERENCES users(id),
  sender_role TEXT NOT NULL CHECK(sender_role IN ('customer','restaurant')),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  key_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(sender_user_id,order_id,idempotency_key)
);
CREATE INDEX order_messages_order_created_idx ON order_messages(order_id,created_at,id);
CREATE INDEX order_messages_expiry_idx ON order_messages(expires_at);
CREATE TABLE order_message_reads (
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_created_at TEXT NOT NULL,
  last_read_message_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(order_id,user_id)
);
CREATE TABLE order_message_rate_limits (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  window_start_ms INTEGER NOT NULL,
  message_count INTEGER NOT NULL CHECK(message_count > 0),
  PRIMARY KEY(user_id,order_id)
);
CREATE TABLE order_message_incidents (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  reporter_user_id TEXT NOT NULL REFERENCES users(id),
  reporter_role TEXT NOT NULL CHECK(reporter_role IN ('customer','restaurant')),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reported' CHECK(status IN ('reported','under_review','resolved')),
  admin_note TEXT NOT NULL DEFAULT '',
  reviewed_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX order_message_incidents_status_idx ON order_message_incidents(status,created_at);
CREATE INDEX order_message_incidents_order_idx ON order_message_incidents(order_id,created_at);
`
};
