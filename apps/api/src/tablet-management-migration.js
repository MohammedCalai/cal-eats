export const tabletManagementMigration72={version:72,name:'trusted_tablet_management_evidence_and_central_enrolment',sql:`
CREATE TABLE tablet_management_refresh_jobs(
 id TEXT PRIMARY KEY,tablet_id TEXT NOT NULL REFERENCES admin_tablets(id),record_revision INTEGER NOT NULL,
 requested_by TEXT NOT NULL REFERENCES users(id),requested_at TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('queued','running','completed','failed','cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0,available_at TEXT,lease_owner TEXT,lease_expires_at TEXT,
 finished_at TEXT,error_code TEXT,updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX tablet_management_one_active ON tablet_management_refresh_jobs(tablet_id) WHERE status IN('queued','running');
CREATE INDEX tablet_management_due ON tablet_management_refresh_jobs(status,available_at,id);
CREATE TABLE tablet_management_observations(
 id TEXT PRIMARY KEY,tablet_id TEXT NOT NULL REFERENCES admin_tablets(id),record_revision INTEGER NOT NULL,
 refresh_job_id TEXT NOT NULL UNIQUE REFERENCES tablet_management_refresh_jobs(id),
 source TEXT NOT NULL CHECK(source='microsoft_graph'),collected_at TEXT NOT NULL,contact_at TEXT,
 intune_device_id TEXT NOT NULL,entra_device_id TEXT NOT NULL,serial_number TEXT NOT NULL,
 script_id TEXT,script_sha256 TEXT,run_state_id TEXT,execution_at TEXT,execution_status TEXT,execution_changed INTEGER CHECK(execution_changed IN(0,1)),
 evidence_json TEXT NOT NULL
);
CREATE INDEX tablet_management_evidence_latest ON tablet_management_observations(tablet_id,collected_at DESC);
CREATE TABLE tablet_fleet_pairing_requests(
 terminal_id TEXT PRIMARY KEY REFERENCES business_terminal_pairings(terminal_id),tablet_id TEXT NOT NULL REFERENCES admin_tablets(id),
 record_revision INTEGER NOT NULL,business_id TEXT NOT NULL REFERENCES business_accounts(id),issued_by TEXT NOT NULL REFERENCES users(id),
 issued_at TEXT NOT NULL,expires_at TEXT NOT NULL
);
CREATE INDEX tablet_fleet_pairing_latest ON tablet_fleet_pairing_requests(tablet_id,issued_at DESC);
`};
