export const supportRoutingMigration29 = {
  version: 29,
  name: "platform_business_support_and_service_email_recipients",
  sql: `
ALTER TABLE support_cases ADD COLUMN requester_restaurant_id TEXT REFERENCES restaurants(id);
UPDATE support_cases SET requester_restaurant_id=restaurant_id,restaurant_id=NULL
WHERE EXISTS(SELECT 1 FROM users WHERE id=support_cases.user_id AND role<>'customer');
INSERT OR IGNORE INTO user_notifications(id,user_id,type,title,message,order_id,restaurant_id,event_key,created_at,support_case_id)
SELECT 'support-routing-'||s.id||'-'||a.id,a.id,'support_request','Business support request needs a reply',
'Business request '||upper(substr(s.id,1,8))||' is awaiting Cal-Eats support.',s.order_id,NULL,'support:'||s.id||':created',s.created_at,s.id
FROM support_cases s JOIN users requester ON requester.id=s.user_id JOIN users a ON a.role='admin' AND a.account_enabled=1
WHERE requester.role='restaurant' AND s.status='open';
CREATE TABLE customer_transactional_email_outbox_v29 (
  id TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_id TEXT REFERENCES user_notifications(id) ON DELETE SET NULL,
  source_key TEXT NOT NULL,event_kind TEXT NOT NULL CHECK(event_kind IN ('order_update','order_message','customer_message','support_reply','support_update','case_update')),
  source_message_id TEXT,order_id TEXT REFERENCES orders(id),restaurant_id TEXT REFERENCES restaurants(id),
  conversation_id TEXT REFERENCES restaurant_customer_threads(id) ON DELETE SET NULL,
  support_case_id TEXT REFERENCES support_cases(id) ON DELETE SET NULL,refund_case_id TEXT REFERENCES refund_cases(id) ON DELETE SET NULL,
  recipient TEXT NOT NULL,payload TEXT NOT NULL,message_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK(mode IN ('local','smtp','graph','off')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','local_saved','sent','failed','unknown','cancelled')),
  lease_owner TEXT,lease_expires_at TEXT,dispatch_started_at TEXT,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,
  queued_at TEXT NOT NULL,sent_at TEXT,updated_at TEXT NOT NULL,UNIQUE(customer_id,source_key)
);
INSERT INTO customer_transactional_email_outbox_v29 SELECT * FROM customer_transactional_email_outbox;
DROP TABLE customer_transactional_email_outbox;
ALTER TABLE customer_transactional_email_outbox_v29 RENAME TO customer_transactional_email_outbox;
CREATE INDEX customer_transactional_email_dispatch_idx ON customer_transactional_email_outbox(status,queued_at,lease_expires_at);
CREATE INDEX customer_transactional_email_customer_idx ON customer_transactional_email_outbox(customer_id,queued_at DESC,id);
`
};
