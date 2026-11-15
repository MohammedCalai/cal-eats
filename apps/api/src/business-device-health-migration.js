const jobColumns = `id TEXT PRIMARY KEY,printer_id TEXT NOT NULL REFERENCES restaurant_printers(id),order_id TEXT NOT NULL REFERENCES orders(id),operation_key TEXT NOT NULL UNIQUE,receipt TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','claimed','dispatched','submitted','printed','failed','uncertain','cancelled')),manual_reprint INTEGER NOT NULL DEFAULT 0 CHECK(manual_reprint IN (0,1)),attempt INTEGER NOT NULL DEFAULT 0,claim_token_hash TEXT,lease_expires_at TEXT,detail TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,claimed_by_device_id TEXT REFERENCES printer_devices(id)`;
const testColumns = `id TEXT PRIMARY KEY,printer_id TEXT NOT NULL REFERENCES restaurant_printers(id),restaurant_id TEXT NOT NULL REFERENCES restaurants(id),request_id TEXT NOT NULL,requested_by_user_id TEXT NOT NULL REFERENCES users(id),receipt TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','claimed','dispatched','submitted','printed','failed','uncertain','cancelled')),attempt INTEGER NOT NULL DEFAULT 0,claim_token_hash TEXT,lease_expires_at TEXT,claimed_by_device_id TEXT REFERENCES printer_devices(id),detail TEXT,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL`;
const extraColumns = `submission_started_at TEXT,spooler_job_id TEXT,terminal_device_id TEXT,available_at TEXT,receipt_revision INTEGER NOT NULL DEFAULT 1`;
export const businessDeviceHealthMigration65 = {version:65,name:"business_device_health_incidents_and_truthful_print_outcomes",foreignKeysOff:true,sql:`
ALTER TABLE restaurants ADD COLUMN tablet_offline_blocked_at TEXT;
ALTER TABLE restaurants ADD COLUMN device_health_due_at TEXT;
CREATE INDEX restaurant_device_health_due ON restaurants(device_health_due_at,id) WHERE status='approved' AND archived_at IS NULL;
CREATE TABLE device_print_jobs_v65(${jobColumns},${extraColumns});
INSERT INTO device_print_jobs_v65(id,printer_id,order_id,operation_key,receipt,status,manual_reprint,attempt,claim_token_hash,lease_expires_at,detail,created_at,updated_at,claimed_by_device_id) SELECT id,printer_id,order_id,operation_key,receipt,status,manual_reprint,attempt,claim_token_hash,lease_expires_at,detail,created_at,updated_at,claimed_by_device_id FROM device_print_jobs;
DROP TABLE device_print_jobs; ALTER TABLE device_print_jobs_v65 RENAME TO device_print_jobs;
CREATE INDEX device_print_jobs_claim_idx ON device_print_jobs(printer_id,status,created_at);
CREATE INDEX device_print_jobs_history ON device_print_jobs(printer_id,updated_at DESC,id DESC);
CREATE TABLE printer_test_jobs_v65(${testColumns},${extraColumns},UNIQUE(printer_id,request_id));
INSERT INTO printer_test_jobs_v65(id,printer_id,restaurant_id,request_id,requested_by_user_id,receipt,status,attempt,claim_token_hash,lease_expires_at,claimed_by_device_id,detail,expires_at,created_at,updated_at) SELECT id,printer_id,restaurant_id,request_id,requested_by_user_id,receipt,status,attempt,claim_token_hash,lease_expires_at,claimed_by_device_id,detail,expires_at,created_at,updated_at FROM printer_test_jobs;
DROP TABLE printer_test_jobs; ALTER TABLE printer_test_jobs_v65 RENAME TO printer_test_jobs;
CREATE UNIQUE INDEX printer_test_one_pending ON printer_test_jobs(printer_id) WHERE status IN ('queued','claimed','dispatched');
CREATE INDEX printer_test_claim ON printer_test_jobs(printer_id,status,created_at,id);
CREATE INDEX printer_test_latest ON printer_test_jobs(printer_id,created_at DESC,id DESC);
CREATE INDEX printer_test_jobs_history ON printer_test_jobs(printer_id,updated_at DESC,id DESC);
CREATE TRIGGER printer_test_immutable_sample BEFORE UPDATE OF receipt,printer_id,restaurant_id,request_id,requested_by_user_id,created_at ON printer_test_jobs BEGIN SELECT RAISE(ABORT,'Printer test payload and ownership are immutable'); END;
CREATE TABLE business_device_health (
 terminal_id TEXT PRIMARY KEY,restaurant_id TEXT NOT NULL REFERENCES restaurants(id),printer_id TEXT REFERENCES restaurant_printers(id),
 bridge_version TEXT NOT NULL,printer_state TEXT NOT NULL,observation_source TEXT NOT NULL,faults TEXT NOT NULL DEFAULT '[]',physical_readiness_known INTEGER NOT NULL DEFAULT 0,
 reported_observed_at TEXT,received_at TEXT NOT NULL,sequence INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX business_device_health_restaurant ON business_device_health(restaurant_id,received_at);
CREATE TABLE business_device_incidents (
 id TEXT PRIMARY KEY,restaurant_id TEXT NOT NULL REFERENCES restaurants(id),terminal_id TEXT NOT NULL,printer_id TEXT,order_id TEXT REFERENCES orders(id),job_id TEXT,
 fault_code TEXT NOT NULL,severity TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('candidate','active','resolved')),
 title TEXT NOT NULL,message TEXT NOT NULL,first_observed_at TEXT NOT NULL,opened_at TEXT,resolved_at TEXT,last_observed_at TEXT NOT NULL,
 bad_observations INTEGER NOT NULL DEFAULT 1,healthy_checks INTEGER NOT NULL DEFAULT 0,last_evidence TEXT,push_suppressed INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX business_device_incident_episode ON business_device_incidents(restaurant_id,terminal_id,fault_code,COALESCE(job_id,'')) WHERE status IN ('candidate','active');
CREATE INDEX business_device_incident_history ON business_device_incidents(restaurant_id,last_observed_at DESC,id);
CREATE TABLE business_device_incident_reads(incident_id TEXT NOT NULL REFERENCES business_device_incidents(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),read_at TEXT NOT NULL,PRIMARY KEY(incident_id,user_id));
CREATE TRIGGER business_incident_notice_read AFTER UPDATE OF read_at ON user_notifications WHEN NEW.type='device_incident' AND NEW.read_at IS NOT NULL BEGIN
 INSERT INTO business_device_incident_reads(incident_id,user_id,read_at)
 SELECT i.id,NEW.user_id,NEW.read_at FROM business_device_incidents i
 WHERE i.id=substr(NEW.event_key,17,36) AND i.restaurant_id=NEW.restaurant_id
 AND NEW.event_key IN ('device-incident:'||i.id||':opened','device-incident:'||i.id||':resolved')
 AND EXISTS(SELECT 1 FROM restaurant_memberships m JOIN users u ON u.id=m.user_id WHERE m.restaurant_id=i.restaurant_id AND m.user_id=NEW.user_id AND u.role='restaurant' AND u.account_enabled=1 AND (m.permission='owner' OR m.can_view_devices=1))
 ON CONFLICT(incident_id,user_id) DO UPDATE SET read_at=MAX(business_device_incident_reads.read_at,excluded.read_at);
END;
CREATE TABLE business_push_devices (
 id TEXT PRIMARY KEY,installation_id TEXT UNIQUE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,session_id TEXT NOT NULL REFERENCES native_business_sessions(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,ciphertext TEXT,nonce TEXT,auth_tag TEXT,key_version TEXT NOT NULL,platform TEXT NOT NULL CHECK(platform IN ('ios','android')),project_id TEXT NOT NULL,generation INTEGER NOT NULL,
 expires_at TEXT NOT NULL,revoked_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE INDEX business_push_devices_owner ON business_push_devices(user_id,revoked_at,expires_at);
CREATE TABLE business_incident_push_outbox (
 id TEXT PRIMARY KEY,incident_id TEXT NOT NULL REFERENCES business_device_incidents(id),notification_id TEXT NOT NULL REFERENCES user_notifications(id),phase TEXT NOT NULL CHECK(phase IN ('opened','resolved')),
 device_id TEXT NOT NULL REFERENCES business_push_devices(id) ON DELETE CASCADE,generation INTEGER NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),
 status TEXT NOT NULL CHECK(status IN ('pending','claimed','accepted','receipt_confirmed','failed','unknown','cancelled')),attempts INTEGER NOT NULL DEFAULT 0,available_at TEXT,lease_owner TEXT,lease_expires_at TEXT,dispatch_started_at TEXT,
 ticket_id TEXT,accepted_at TEXT,receipt_due_at TEXT,receipt_attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 UNIQUE(incident_id,phase,device_id,generation)
);
CREATE INDEX business_incident_push_dispatch ON business_incident_push_outbox(status,available_at);
CREATE INDEX business_incident_push_receipts ON business_incident_push_outbox(status,receipt_due_at);
CREATE TRIGGER business_push_logout AFTER UPDATE OF revoked_at ON native_business_sessions WHEN NEW.revoked_at IS NOT NULL BEGIN
 UPDATE business_push_devices SET revoked_at=NEW.revoked_at,ciphertext=NULL,nonce=NULL,auth_tag=NULL,updated_at=NEW.revoked_at WHERE session_id=NEW.id AND revoked_at IS NULL;
 UPDATE business_incident_push_outbox SET status='cancelled',available_at=NULL,last_error='BUSINESS_SESSION_REVOKED',updated_at=NEW.revoked_at WHERE device_id IN (SELECT id FROM business_push_devices WHERE session_id=NEW.id) AND status IN ('pending','failed'); END;
`};
