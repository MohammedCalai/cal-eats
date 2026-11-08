export const merchantCommercialTermMigration54 = {
  version: 54,
  name: "locked_24_month_merchant_terms",
  sql: `
CREATE TABLE merchant_commercial_terms (
  acceptance_id TEXT PRIMARY KEY REFERENCES merchant_commercial_acceptances(id),
  starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
  duration_months INTEGER NOT NULL CHECK(duration_months=24),
  CHECK(ends_at>starts_at)
);
CREATE INDEX merchant_commercial_term_dates ON merchant_commercial_terms(starts_at,ends_at);
CREATE TRIGGER merchant_commercial_terms_immutable_update BEFORE UPDATE ON merchant_commercial_terms BEGIN SELECT RAISE(ABORT,'Merchant contract dates are immutable'); END;
CREATE TRIGGER merchant_commercial_terms_immutable_delete BEFORE DELETE ON merchant_commercial_terms BEGIN SELECT RAISE(ABORT,'Merchant contract dates are immutable'); END;
`
};
