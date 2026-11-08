export const customerPrivacyMigration49 = {
  version: 49,
  name: "customer_privacy_retention_and_order_health_consent",
  sql: `
CREATE TABLE order_health_consents (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  policy_version TEXT NOT NULL,
  notice_version TEXT NOT NULL,
  notice_sha256 TEXT NOT NULL,
  consented_at TEXT NOT NULL,
  withdrawn_at TEXT,
  source TEXT NOT NULL CHECK(source IN ('web','native'))
);
CREATE INDEX order_health_consents_user_idx ON order_health_consents(user_id,consented_at);
CREATE TABLE privacy_retention_runs (
  id TEXT PRIMARY KEY,
  policy_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  counts_json TEXT NOT NULL
);
CREATE INDEX privacy_retention_runs_time_idx ON privacy_retention_runs(completed_at);
CREATE TABLE privacy_retention_cursors (
  scope TEXT PRIMARY KEY CHECK(scope IN ('orders','support')),
  after_id TEXT NOT NULL
);
INSERT INTO privacy_retention_cursors VALUES('orders',''),('support','');
`
};
