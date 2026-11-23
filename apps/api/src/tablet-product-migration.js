export const tabletProductMigration73 = {
  version: 73,
  name: 'device_scoped_application_product_access',
  sql: `ALTER TABLE admin_tablets ADD COLUMN application_products TEXT
    CHECK(application_products IS NULL OR application_products IN('calai','cal-eats','both'));
    CREATE TABLE tablet_application_receipts(
      tablet_id TEXT NOT NULL REFERENCES admin_tablets(id),
      record_revision INTEGER NOT NULL CHECK(record_revision>0),
      terminal_id TEXT NOT NULL REFERENCES business_terminals(id),
      business_id TEXT NOT NULL REFERENCES business_accounts(id),
      received_at TEXT NOT NULL,
      PRIMARY KEY(tablet_id,record_revision,terminal_id)
    );`
};

export const terminalCalaiApprovalMigration74 = {
  version: 74,
  name: 'owner_approved_terminal_calai_access',
  sql: `CREATE TABLE business_terminal_calai_approvals(
    terminal_id TEXT PRIMARY KEY REFERENCES business_terminals(id) ON DELETE CASCADE,
    tablet_id TEXT NOT NULL REFERENCES admin_tablets(id) ON DELETE CASCADE,
    business_id TEXT NOT NULL REFERENCES business_accounts(id),
    native_link_id TEXT NOT NULL REFERENCES business_product_links(id) ON DELETE CASCADE,
    source_account_id TEXT NOT NULL,
    source_user_id TEXT NOT NULL,
    approved_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    approved_at TEXT NOT NULL
  );`
};
