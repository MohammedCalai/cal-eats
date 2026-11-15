export const businessReportEmailsMigration63={version:63,name:"requested_owner_report_email_attachments",sql:`
CREATE TABLE business_report_email_outbox (
 id TEXT PRIMARY KEY,restaurant_id TEXT NOT NULL REFERENCES restaurants(id),user_id TEXT NOT NULL REFERENCES users(id),recipient TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,report_path TEXT NOT NULL,report_kind TEXT NOT NULL,financial_scope TEXT NOT NULL CHECK(financial_scope IN ('live','testing')),
 provider_mode TEXT NOT NULL,platform_account_id TEXT,filename TEXT NOT NULL,csv TEXT,content_sha256 TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('local','graph','smtp')),message_id TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL CHECK(status IN ('pending','claimed','sent','local_saved','failed','unknown','cancelled')),attempts INTEGER NOT NULL DEFAULT 0,
 lease_owner TEXT,lease_expires_at TEXT,dispatch_started_at TEXT,last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,sent_at TEXT,expires_at TEXT NOT NULL,
 UNIQUE(user_id,idempotency_key)
);
CREATE INDEX business_report_email_due_idx ON business_report_email_outbox(status,created_at);
CREATE INDEX business_report_email_user_idx ON business_report_email_outbox(user_id,created_at);
`};
