export const tabletFleetMigration71 = {version:71,name:'administrator_tablet_inventory_and_requested_configuration',sql:`
CREATE TABLE admin_tablets(
 id TEXT PRIMARY KEY,display_name TEXT NOT NULL,serial_number TEXT COLLATE NOCASE UNIQUE,
 business_id TEXT REFERENCES business_accounts(id),requested_business_id TEXT REFERENCES business_accounts(id),
 terminal_id TEXT UNIQUE REFERENCES business_terminals(id),requested_startup_product TEXT CHECK(requested_startup_product IN('calai','cal-eats')),
 intune_managed_device_id TEXT UNIQUE,entra_device_id TEXT UNIQUE,startup_group_id TEXT,startup_profile_id TEXT,
 lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN('unassigned','assigned','disabled','pending_handoff')),
 inventory_source TEXT NOT NULL DEFAULT 'administrator_metadata' CHECK(inventory_source IN('administrator_metadata','application_registration')),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),created_by TEXT REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 disabled_at TEXT,handoff_requested_at TEXT,authority_blocked_at TEXT,archived_at TEXT,superseded_by TEXT REFERENCES admin_tablets(id)
);
CREATE INDEX admin_tablets_location ON admin_tablets(business_id,lifecycle_state,id);
CREATE INDEX admin_tablets_requested_location ON admin_tablets(requested_business_id,lifecycle_state,id);
CREATE INDEX admin_tablets_name ON admin_tablets(display_name COLLATE NOCASE,id);
CREATE TABLE tablet_configuration_requests(
 id TEXT PRIMARY KEY,tablet_id TEXT NOT NULL REFERENCES admin_tablets(id),record_revision INTEGER NOT NULL,
 business_id TEXT REFERENCES business_accounts(id),startup_product TEXT CHECK(startup_product IN('calai','cal-eats')),
 mapping_snapshot TEXT NOT NULL,requested_by TEXT NOT NULL REFERENCES users(id),requested_at TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('requested','assigned','offered','received','applied','physically_verified','failed','cancelled')),
 assigned_at TEXT,offered_at TEXT,received_at TEXT,applied_at TEXT,physically_verified_at TEXT,trusted_evidence_source TEXT,trusted_evidence_reference TEXT,
 CHECK((assigned_at IS NULL AND offered_at IS NULL AND received_at IS NULL AND applied_at IS NULL AND physically_verified_at IS NULL)
 OR (trusted_evidence_source IS NOT NULL AND trusted_evidence_reference IS NOT NULL)),
 CHECK(state NOT IN('assigned','offered','received','applied','physically_verified') OR
 (trusted_evidence_source IS NOT NULL AND trusted_evidence_reference IS NOT NULL AND
 CASE state WHEN 'assigned' THEN assigned_at WHEN 'offered' THEN offered_at WHEN 'received' THEN received_at
 WHEN 'applied' THEN applied_at WHEN 'physically_verified' THEN physically_verified_at END IS NOT NULL)),
 UNIQUE(tablet_id,record_revision)
);
CREATE INDEX tablet_configuration_latest ON tablet_configuration_requests(tablet_id,record_revision DESC);
INSERT INTO admin_tablets(id,display_name,business_id,terminal_id,lifecycle_state,inventory_source,created_by,created_at,updated_at,disabled_at)
 SELECT id,name,business_id,id,CASE WHEN revoked_at IS NULL THEN 'assigned' ELSE 'disabled' END,'application_registration',registered_by,registered_at,COALESCE(revoked_at,registered_at),revoked_at FROM business_terminals;
`};
