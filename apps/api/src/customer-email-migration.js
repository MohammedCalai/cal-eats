export const customerEmailMigration27 = {
  version: 27,
  name: "durable_transactional_customer_email_and_graph_alert_mode",
  sql: `
CREATE TABLE order_confirmation_email_outbox_v27 (
  id TEXT PRIMARY KEY,order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  recipient TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,message_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK(mode IN ('local','smtp','graph','off')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','local_saved','sent','failed','unknown','cancelled')),
  lease_owner TEXT,lease_expires_at TEXT,dispatch_started_at TEXT,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,
  queued_at TEXT NOT NULL,sent_at TEXT,updated_at TEXT NOT NULL
);
INSERT INTO order_confirmation_email_outbox_v27 SELECT * FROM order_confirmation_email_outbox;
DROP TABLE order_confirmation_email_outbox;
ALTER TABLE order_confirmation_email_outbox_v27 RENAME TO order_confirmation_email_outbox;
CREATE INDEX order_confirmation_email_dispatch_idx ON order_confirmation_email_outbox(status,queued_at,lease_expires_at);
CREATE TABLE customer_email_delivery_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  mode TEXT NOT NULL CHECK(mode IN ('local','smtp','graph','off')),
  payment_provider_mode TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO customer_email_delivery_settings VALUES(1,'local','local_simulator','1970-01-01T00:00:00.000Z');
CREATE TABLE customer_transactional_email_outbox (
  id TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_id TEXT REFERENCES user_notifications(id) ON DELETE SET NULL,
  source_key TEXT NOT NULL,event_kind TEXT NOT NULL CHECK(event_kind IN ('order_update','order_message','customer_message','support_reply','case_update')),
  source_message_id TEXT,order_id TEXT REFERENCES orders(id),restaurant_id TEXT REFERENCES restaurants(id),
  conversation_id TEXT REFERENCES restaurant_customer_threads(id) ON DELETE SET NULL,
  support_case_id TEXT REFERENCES support_cases(id) ON DELETE SET NULL,refund_case_id TEXT REFERENCES refund_cases(id) ON DELETE SET NULL,
  recipient TEXT NOT NULL,payload TEXT NOT NULL,message_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK(mode IN ('local','smtp','graph','off')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','local_saved','sent','failed','unknown','cancelled')),
  lease_owner TEXT,lease_expires_at TEXT,dispatch_started_at TEXT,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,
  queued_at TEXT NOT NULL,sent_at TEXT,updated_at TEXT NOT NULL,
  UNIQUE(customer_id,source_key)
);
CREATE INDEX customer_transactional_email_dispatch_idx ON customer_transactional_email_outbox(status,queued_at,lease_expires_at);
CREATE INDEX customer_transactional_email_customer_idx ON customer_transactional_email_outbox(customer_id,queued_at DESC,id);
`
};
