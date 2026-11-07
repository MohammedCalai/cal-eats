export const orderLiveActivityMigration45 = { version: 45, name: "customer_order_live_activities", sql: `
CREATE TABLE order_live_activity_revisions (order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,revision INTEGER NOT NULL DEFAULT 1);
INSERT INTO order_live_activity_revisions(order_id) SELECT id FROM orders;
CREATE TRIGGER order_live_activity_order_created AFTER INSERT ON orders BEGIN INSERT INTO order_live_activity_revisions(order_id) VALUES(NEW.id); END;
CREATE TABLE customer_order_live_activities (
 id TEXT PRIMARY KEY,activity_id TEXT NOT NULL UNIQUE,installation_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_id TEXT NOT NULL REFERENCES native_sessions(id) ON DELETE CASCADE,order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,project_id TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE,ciphertext TEXT,nonce TEXT,auth_tag TEXT,key_version TEXT NOT NULL,generation INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','ending','ended','invalid')),end_reason TEXT,expires_at TEXT NOT NULL,cleanup_until TEXT,
 last_timestamp INTEGER NOT NULL DEFAULT 0,sent_revision INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE INDEX customer_live_activity_order_idx ON customer_order_live_activities(order_id,state);
CREATE INDEX customer_live_activity_installation_idx ON customer_order_live_activities(installation_id,state);
CREATE INDEX customer_live_activity_session_idx ON customer_order_live_activities(session_id,state);
CREATE INDEX customer_live_activity_expiry_idx ON customer_order_live_activities(state,expires_at);
CREATE INDEX customer_live_activity_cleanup_idx ON customer_order_live_activities(state,cleanup_until);
CREATE TABLE order_live_activity_outbox (
 activity_id TEXT PRIMARY KEY REFERENCES customer_order_live_activities(id) ON DELETE CASCADE,generation INTEGER NOT NULL,revision INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','claimed','accepted','failed','cancelled')),attempts INTEGER NOT NULL DEFAULT 0,
 available_at TEXT,lease_owner TEXT,lease_expires_at TEXT,dispatch_started_at TEXT,last_error TEXT,apns_id TEXT,updated_at TEXT NOT NULL
);
CREATE INDEX order_live_activity_due_idx ON order_live_activity_outbox(status,available_at);
CREATE TRIGGER order_live_activity_order_changed AFTER UPDATE OF status,payment_status,estimated_ready_at,confirmed_at,scheduled_for ON orders
 WHEN NEW.status IS NOT OLD.status OR NEW.payment_status IS NOT OLD.payment_status OR NEW.estimated_ready_at IS NOT OLD.estimated_ready_at OR NEW.confirmed_at IS NOT OLD.confirmed_at OR NEW.scheduled_for IS NOT OLD.scheduled_for
 BEGIN
 UPDATE order_live_activity_revisions SET revision=revision+1 WHERE order_id=NEW.id;
 INSERT INTO order_live_activity_outbox(activity_id,generation,revision,status,available_at,updated_at)
 SELECT a.id,a.generation,r.revision,'pending',NEW.updated_at,NEW.updated_at FROM customer_order_live_activities a JOIN order_live_activity_revisions r ON r.order_id=a.order_id WHERE a.order_id=NEW.id AND a.state='active'
 ON CONFLICT(activity_id) DO UPDATE SET generation=excluded.generation,revision=excluded.revision,status='pending',attempts=0,available_at=excluded.available_at,lease_owner=NULL,lease_expires_at=NULL,dispatch_started_at=NULL,last_error=NULL,apns_id=NULL,updated_at=excluded.updated_at;
 END;
CREATE TRIGGER order_live_activity_ending AFTER UPDATE OF state ON customer_order_live_activities WHEN NEW.state='ending' AND OLD.state<>'ending'
 BEGIN
 INSERT INTO order_live_activity_outbox(activity_id,generation,revision,status,available_at,updated_at) VALUES(NEW.id,NEW.generation,COALESCE((SELECT revision FROM order_live_activity_revisions WHERE order_id=NEW.order_id),1),'pending',NEW.updated_at,NEW.updated_at)
 ON CONFLICT(activity_id) DO UPDATE SET generation=excluded.generation,revision=excluded.revision,status='pending',attempts=0,available_at=excluded.available_at,lease_owner=NULL,lease_expires_at=NULL,dispatch_started_at=NULL,last_error=NULL,apns_id=NULL,updated_at=excluded.updated_at;
 END;
CREATE TRIGGER order_live_activity_retired AFTER UPDATE OF state ON customer_order_live_activities WHEN NEW.state IN ('ended','invalid')
 BEGIN UPDATE order_live_activity_outbox SET status='cancelled',available_at=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=NEW.updated_at WHERE activity_id=NEW.id AND status IN ('pending','claimed','failed'); END;
CREATE TRIGGER order_live_activity_logout AFTER UPDATE OF revoked_at ON native_sessions WHEN NEW.revoked_at IS NOT NULL
 BEGIN UPDATE customer_order_live_activities SET state='ending',end_reason='session_ended',cleanup_until=strftime('%Y-%m-%dT%H:%M:%fZ',NEW.revoked_at,'+5 minutes'),updated_at=NEW.revoked_at WHERE session_id=NEW.id AND state='active'; END;
` };
