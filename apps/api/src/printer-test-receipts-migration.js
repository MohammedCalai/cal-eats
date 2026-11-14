export const printerConnectionMigration60={version:60,name:"automatic_printer_setup_and_diagnostics",sql:`
ALTER TABLE printer_devices ADD COLUMN printer_reachable INTEGER CHECK(printer_reachable IS NULL OR printer_reachable IN(0,1));
ALTER TABLE printer_devices ADD COLUMN printer_checked_at TEXT;
ALTER TABLE printer_devices ADD COLUMN printer_transport TEXT;
CREATE INDEX printer_device_restaurant_health ON printer_devices(restaurant_id,revoked_at,printer_id,last_seen_at);
CREATE INDEX printer_device_printer_health ON printer_devices(printer_id,revoked_at,last_seen_at);
CREATE TABLE printer_test_jobs (
 id TEXT PRIMARY KEY,printer_id TEXT NOT NULL REFERENCES restaurant_printers(id),restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
 request_id TEXT NOT NULL,requested_by_user_id TEXT NOT NULL REFERENCES users(id),receipt TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','claimed','printed','failed','uncertain')),
 attempt INTEGER NOT NULL DEFAULT 0,claim_token_hash TEXT,lease_expires_at TEXT,claimed_by_device_id TEXT REFERENCES printer_devices(id),
 detail TEXT,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(printer_id,request_id)
);
CREATE UNIQUE INDEX printer_test_one_pending ON printer_test_jobs(printer_id) WHERE status IN ('queued','claimed');
CREATE INDEX printer_test_claim ON printer_test_jobs(printer_id,status,created_at,id);
CREATE INDEX printer_test_latest ON printer_test_jobs(printer_id,created_at DESC,id DESC);
CREATE TABLE printer_test_job_claim_tokens (
 job_id TEXT NOT NULL REFERENCES printer_test_jobs(id) ON DELETE CASCADE,device_id TEXT NOT NULL REFERENCES printer_devices(id),
 token_hash TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,PRIMARY KEY(job_id,token_hash)
);
CREATE TRIGGER printer_test_immutable_sample BEFORE UPDATE OF receipt,printer_id,restaurant_id,request_id,requested_by_user_id,created_at ON printer_test_jobs
 BEGIN SELECT RAISE(ABORT,'Printer test payload and ownership are immutable'); END;
`};
