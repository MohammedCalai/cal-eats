export const tabletManagedSetupMigration76 = {
  version: 76,
  name: 'intune_managed_tablet_first_connection',
  sql: `CREATE TABLE tablet_managed_setups (
    id TEXT PRIMARY KEY,
    tablet_id TEXT NOT NULL REFERENCES admin_tablets(id),
    record_revision INTEGER NOT NULL CHECK(record_revision>0),
    business_id TEXT NOT NULL REFERENCES business_accounts(id),
    requested_by TEXT NOT NULL REFERENCES users(id),
    calai_owner_binding TEXT CHECK(calai_owner_binding IS NULL OR json_valid(calai_owner_binding)),
    managed_device_id TEXT NOT NULL,
    entra_device_id TEXT NOT NULL,
    serial_number TEXT NOT NULL,
    group_id TEXT NOT NULL,
    directory_object_id TEXT NOT NULL,
    script_content TEXT NOT NULL,
    script_id TEXT,
    create_started_at TEXT,
    requested_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    next_check_at TEXT NOT NULL,
    lease_id TEXT,
    lease_until TEXT,
    state TEXT NOT NULL CHECK(state IN('pending','assigned','verified','registered','attention')),
    verified_key_hash TEXT,
    verified_at TEXT,
    challenge TEXT,
    challenge_until TEXT,
    registered_at TEXT,
    failure_code TEXT
  );
  CREATE UNIQUE INDEX tablet_managed_setups_one_device ON tablet_managed_setups(tablet_id);
  CREATE UNIQUE INDEX tablet_managed_setups_one_pending_business ON tablet_managed_setups(business_id)
    WHERE state IN('pending','assigned','verified');
  CREATE INDEX tablet_managed_setups_work ON tablet_managed_setups(state,next_check_at,lease_until);`
};

export const tabletManagedSetupRetryMigration77 = {
  version: 77,
  name: 'intune_managed_tablet_delivery_retries',
  sql: `ALTER TABLE tablet_managed_setups ADD COLUMN delivery_revision INTEGER NOT NULL DEFAULT 1 CHECK(delivery_revision BETWEEN 1 AND 10000);
  ALTER TABLE tablet_managed_setups ADD COLUMN delivery_started_at TEXT;
  ALTER TABLE tablet_managed_setups ADD COLUMN failed_run_at TEXT;
  ALTER TABLE tablet_managed_setups ADD COLUMN retry_script_content TEXT;
  ALTER TABLE tablet_managed_setups ADD COLUMN retry_update_started_at TEXT;`
};
