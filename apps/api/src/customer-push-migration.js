export const customerPushMigration44={version:44,name:"customer_native_push",sql:`
CREATE TABLE customer_push_devices (
 id TEXT PRIMARY KEY,installation_id TEXT UNIQUE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,session_id TEXT NOT NULL REFERENCES native_sessions(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,ciphertext TEXT,nonce TEXT,auth_tag TEXT,key_version TEXT NOT NULL,platform TEXT NOT NULL CHECK(platform IN ('ios','android')),project_id TEXT NOT NULL,generation INTEGER NOT NULL,sound_enabled INTEGER NOT NULL DEFAULT 1 CHECK(sound_enabled IN (0,1)),expires_at TEXT NOT NULL,revoked_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE INDEX customer_push_device_user_idx ON customer_push_devices(user_id,revoked_at,expires_at);
CREATE TABLE customer_push_outbox (
 id TEXT PRIMARY KEY,notification_id TEXT NOT NULL REFERENCES user_notifications(id) ON DELETE CASCADE,device_id TEXT NOT NULL REFERENCES customer_push_devices(id) ON DELETE CASCADE,generation INTEGER NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('pending','claimed','accepted','receipt_confirmed','failed','unknown','cancelled')),attempts INTEGER NOT NULL DEFAULT 0,available_at TEXT,lease_owner TEXT,lease_expires_at TEXT,dispatch_started_at TEXT,ticket_id TEXT UNIQUE,receipt_due_at TEXT,receipt_attempts INTEGER NOT NULL DEFAULT 0,accepted_at TEXT,last_error TEXT,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(notification_id,device_id,generation)
);
CREATE INDEX customer_push_outbox_due_idx ON customer_push_outbox(status,available_at);
CREATE INDEX customer_push_receipts_due_idx ON customer_push_outbox(status,receipt_due_at);
CREATE TRIGGER customer_push_notification_insert AFTER INSERT ON user_notifications
 WHEN NEW.read_at IS NULL AND NEW.type IN ('order_status','order_eta','order_expired','order_refund','order_message','customer_message','support_request','support_receipt','support_reply','support_status','offer','platform_voucher','shop_rating')
 BEGIN
 INSERT OR IGNORE INTO customer_push_outbox(id,notification_id,device_id,generation,user_id,status,available_at,expires_at,created_at,updated_at)
 SELECT lower(hex(randomblob(16))),NEW.id,d.id,d.generation,NEW.user_id,'pending',
 CASE WHEN NEW.type='offer' THEN MAX(NEW.created_at,COALESCE(c.starts_at,c.created_at,NEW.created_at)) ELSE NEW.created_at END,
 CASE WHEN NEW.type='offer' THEN MIN(COALESCE(c.expires_at,strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at,'+24 hours')),strftime('%Y-%m-%dT%H:%M:%fZ',MAX(NEW.created_at,COALESCE(c.starts_at,c.created_at,NEW.created_at)),'+24 hours')) ELSE strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at,'+24 hours') END,NEW.created_at,NEW.created_at
 FROM customer_push_devices d JOIN native_sessions s ON s.id=d.session_id JOIN users u ON u.id=d.user_id
 LEFT JOIN offer_grants g ON g.id=NEW.offer_id AND g.customer_id=NEW.user_id LEFT JOIN offer_campaigns c ON c.id=g.campaign_id
 WHERE d.user_id=NEW.user_id AND d.revoked_at IS NULL AND d.expires_at>NEW.created_at AND s.revoked_at IS NULL AND s.expires_at>NEW.created_at AND u.role='customer' AND u.account_enabled=1;
 END;
CREATE TRIGGER customer_push_device_retired AFTER UPDATE OF generation,revoked_at ON customer_push_devices
 WHEN NEW.generation<>OLD.generation OR NEW.revoked_at IS NOT NULL
 BEGIN
 UPDATE customer_push_outbox SET status='cancelled',available_at=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error='PUSH_DEVICE_RETIRED',updated_at=NEW.updated_at
 WHERE device_id=NEW.id AND (generation<>NEW.generation OR NEW.revoked_at IS NOT NULL) AND (status IN ('pending','failed') OR (status='claimed' AND dispatch_started_at IS NULL));
 END;
CREATE TRIGGER customer_push_native_logout AFTER UPDATE OF revoked_at ON native_sessions WHEN NEW.revoked_at IS NOT NULL
 BEGIN UPDATE customer_push_devices SET revoked_at=NEW.revoked_at,ciphertext=NULL,nonce=NULL,auth_tag=NULL,updated_at=NEW.revoked_at WHERE session_id=NEW.id AND revoked_at IS NULL; END;
CREATE TRIGGER customer_push_offer_rescheduled AFTER UPDATE OF starts_at,expires_at ON offer_campaigns
 BEGIN
 UPDATE customer_push_outbox SET
 available_at=(SELECT MAX(n.created_at,COALESCE(NEW.starts_at,NEW.created_at)) FROM user_notifications n WHERE n.id=customer_push_outbox.notification_id),
 expires_at=MIN(NEW.expires_at,(SELECT strftime('%Y-%m-%dT%H:%M:%fZ',MAX(n.created_at,COALESCE(NEW.starts_at,NEW.created_at)),'+24 hours') FROM user_notifications n WHERE n.id=customer_push_outbox.notification_id))
 WHERE (status='pending' OR (status='failed' AND available_at IS NOT NULL)) AND notification_id IN (SELECT n.id FROM user_notifications n JOIN offer_grants g ON g.id=n.offer_id WHERE n.type='offer' AND g.campaign_id=NEW.id);
 END;
`};
