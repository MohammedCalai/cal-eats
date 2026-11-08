export const merchantCommercialMigration = {
  version: 52,
  name: "immutable_merchant_commercial_acceptance",
  sql: `
CREATE TABLE merchant_commercial_documents (
  version TEXT PRIMARY KEY, content_sha256 TEXT NOT NULL, text_content TEXT NOT NULL,
  approved_at TEXT NOT NULL, approval_reference TEXT NOT NULL, effective_at TEXT NOT NULL,
  commission_rate_bps INTEGER NOT NULL CHECK(commission_rate_bps=700),
  commission_base TEXT NOT NULL CHECK(commission_base='food_plus_delivery'),
  processing_fees_paid_by TEXT NOT NULL CHECK(processing_fees_paid_by='platform'),
  payout_interval TEXT NOT NULL CHECK(payout_interval='weekly'),
  payout_anchor TEXT NOT NULL CHECK(payout_anchor='monday'), created_at TEXT NOT NULL,
  UNIQUE(version,content_sha256)
);
CREATE TABLE merchant_commercial_acceptances (
  id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id), document_version TEXT NOT NULL,
  document_sha256 TEXT NOT NULL, accepted_at TEXT NOT NULL,
  FOREIGN KEY(document_version,document_sha256) REFERENCES merchant_commercial_documents(version,content_sha256),
  UNIQUE(restaurant_id,owner_user_id,document_version,document_sha256)
);
CREATE INDEX merchant_commercial_restaurant_version ON merchant_commercial_acceptances(restaurant_id,document_version,document_sha256);
CREATE TABLE order_merchant_commercial_snapshots (
  order_id TEXT PRIMARY KEY REFERENCES orders(id), acceptance_id TEXT NOT NULL REFERENCES merchant_commercial_acceptances(id),
  document_version TEXT NOT NULL, document_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY(document_version,document_sha256) REFERENCES merchant_commercial_documents(version,content_sha256)
);
CREATE TRIGGER merchant_commercial_documents_immutable_update BEFORE UPDATE ON merchant_commercial_documents BEGIN SELECT RAISE(ABORT,'Merchant agreement documents are immutable'); END;
CREATE TRIGGER merchant_commercial_documents_immutable_delete BEFORE DELETE ON merchant_commercial_documents BEGIN SELECT RAISE(ABORT,'Merchant agreement documents are immutable'); END;
CREATE TRIGGER merchant_commercial_acceptances_immutable_update BEFORE UPDATE ON merchant_commercial_acceptances BEGIN SELECT RAISE(ABORT,'Merchant agreement acceptance is immutable'); END;
CREATE TRIGGER merchant_commercial_acceptances_immutable_delete BEFORE DELETE ON merchant_commercial_acceptances BEGIN SELECT RAISE(ABORT,'Merchant agreement acceptance is immutable'); END;
CREATE TRIGGER order_merchant_commercial_immutable_update BEFORE UPDATE ON order_merchant_commercial_snapshots BEGIN SELECT RAISE(ABORT,'Order merchant agreement is immutable'); END;
CREATE TRIGGER order_merchant_commercial_immutable_delete BEFORE DELETE ON order_merchant_commercial_snapshots BEGIN SELECT RAISE(ABORT,'Order merchant agreement is immutable'); END;
`
};
