export const businessApplicationMigration37 = {
  version: 37,
  name: "business_application_contacts_and_durable_acknowledgements",
  sql: `
CREATE TABLE business_application_submissions (
  idempotency_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  restaurant_id TEXT NOT NULL UNIQUE REFERENCES restaurants(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE TABLE customer_transactional_email_outbox_v37 (
  id TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_id TEXT REFERENCES user_notifications(id) ON DELETE SET NULL,
  source_key TEXT NOT NULL,event_kind TEXT NOT NULL CHECK(event_kind IN ('order_update','order_message','customer_message','support_reply','support_update','case_update','business_application')),
  source_message_id TEXT,order_id TEXT REFERENCES orders(id),restaurant_id TEXT REFERENCES restaurants(id),
  conversation_id TEXT REFERENCES restaurant_customer_threads(id) ON DELETE SET NULL,
  support_case_id TEXT REFERENCES support_cases(id) ON DELETE SET NULL,refund_case_id TEXT REFERENCES refund_cases(id) ON DELETE SET NULL,
  recipient TEXT NOT NULL,payload TEXT NOT NULL,message_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK(mode IN ('local','smtp','graph','off')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','local_saved','sent','failed','unknown','cancelled')),
  lease_owner TEXT,lease_expires_at TEXT,dispatch_started_at TEXT,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,
  queued_at TEXT NOT NULL,sent_at TEXT,updated_at TEXT NOT NULL,UNIQUE(customer_id,source_key)
);
INSERT INTO customer_transactional_email_outbox_v37 SELECT * FROM customer_transactional_email_outbox;
DROP TABLE customer_transactional_email_outbox;
ALTER TABLE customer_transactional_email_outbox_v37 RENAME TO customer_transactional_email_outbox;
CREATE INDEX customer_transactional_email_dispatch_idx ON customer_transactional_email_outbox(status,queued_at,lease_expires_at);
CREATE INDEX customer_transactional_email_customer_idx ON customer_transactional_email_outbox(customer_id,queued_at DESC,id);
`
};
