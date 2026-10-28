export const customerRelationshipsMigration23 = {
  version: 23,
  name: "restaurant_customer_directory_and_conversations",
  sql: `
CREATE TABLE restaurant_customer_workflows (
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workflow_status TEXT NOT NULL DEFAULT 'active' CHECK(workflow_status IN ('active','follow_up','vip','resolved')),
  note TEXT NOT NULL DEFAULT '',
  updated_by_user_id TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(restaurant_id,customer_id)
);
CREATE INDEX restaurant_customer_workflow_status_idx ON restaurant_customer_workflows(restaurant_id,workflow_status,customer_id);
CREATE INDEX customer_directory_history_idx ON orders(restaurant_id,customer_id,created_at,id);
CREATE INDEX customer_directory_refund_status_idx ON refund_cases(restaurant_id,customer_id,status);
CREATE TABLE restaurant_customer_threads (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','awaiting_customer','awaiting_restaurant','resolved')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_message_at TEXT NOT NULL,
  UNIQUE(restaurant_id,customer_id)
);
CREATE INDEX restaurant_customer_inbox_idx ON restaurant_customer_threads(restaurant_id,status,last_message_at,id);
CREATE INDEX customer_conversations_idx ON restaurant_customer_threads(customer_id,last_message_at,id);
CREATE TABLE restaurant_customer_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES restaurant_customer_threads(id) ON DELETE CASCADE,
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
  UNIQUE(sender_user_id,thread_id,idempotency_key)
);
CREATE INDEX restaurant_customer_messages_cursor_idx ON restaurant_customer_messages(thread_id,created_at,id);
CREATE INDEX restaurant_customer_messages_expiry_idx ON restaurant_customer_messages(expires_at);
CREATE TABLE restaurant_customer_message_reads (
  thread_id TEXT NOT NULL REFERENCES restaurant_customer_threads(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_created_at TEXT NOT NULL,
  last_read_message_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(thread_id,user_id)
);
CREATE TABLE restaurant_customer_message_rate_limits (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES restaurant_customer_threads(id) ON DELETE CASCADE,
  window_start_ms INTEGER NOT NULL,
  message_count INTEGER NOT NULL CHECK(message_count>0),
  PRIMARY KEY(user_id,thread_id)
);
ALTER TABLE user_notifications ADD COLUMN conversation_id TEXT REFERENCES restaurant_customer_threads(id) ON DELETE CASCADE;
ALTER TABLE user_notifications ADD COLUMN customer_id TEXT REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX customer_message_notification_idx ON user_notifications(user_id,conversation_id,type,read_at);
`
};
