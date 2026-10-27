export const STRIPE_TRANSITION_SQL = `
CREATE TABLE IF NOT EXISTS stripe_order_decisions (
  order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  desired_status TEXT NOT NULL CHECK(desired_status IN ('accepted','rejected')),
  state TEXT NOT NULL CHECK(state IN ('claimed','unknown','confirmed')),
  lease_owner TEXT,
  lease_expires_at TEXT,
  provider_mode TEXT NOT NULL CHECK(provider_mode IN ('stripe_test','stripe_live')),
  provider_result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;
