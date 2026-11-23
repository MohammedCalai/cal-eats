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
