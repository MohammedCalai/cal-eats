export const payoutApiProvenanceMigration55 = {
  version: 55,
  name: "immutable_verified_payout_api_read_provenance",
  sql: `
CREATE TABLE stripe_payout_api_provenance (
  payout_id TEXT PRIMARY KEY REFERENCES stripe_connected_payouts(id),
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  provider_mode TEXT NOT NULL CHECK(provider_mode IN ('stripe_test','stripe_live')),
  provider_account_id TEXT NOT NULL,
  platform_account_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(amount_minor>=0),
  currency TEXT NOT NULL CHECK(currency='GBP'),
  source TEXT NOT NULL CHECK(source='stripe_payouts_api_read'),
  verified_at TEXT NOT NULL
);
CREATE INDEX stripe_payout_api_provenance_scope ON stripe_payout_api_provenance(provider_mode,restaurant_id,payout_id);
CREATE TRIGGER stripe_payout_api_provenance_no_update BEFORE UPDATE ON stripe_payout_api_provenance
BEGIN SELECT RAISE(ABORT,'Verified payout API provenance is immutable'); END;
CREATE TRIGGER stripe_payout_api_provenance_no_delete BEFORE DELETE ON stripe_payout_api_provenance
BEGIN SELECT RAISE(ABORT,'Verified payout API provenance is immutable'); END;
`
};
