export const PROVIDER_EVENTS_MIGRATION_VERSION = 17;

export const PROVIDER_EVENTS_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS provider_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider = 'stripe_test'),
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  provider_account_reference TEXT,
  restaurant_id TEXT REFERENCES restaurants(id),
  payload_fingerprint TEXT NOT NULL,
  normalized_payload TEXT NOT NULL DEFAULT '{}',
  provider_created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','claimed','delayed','completed','ignored','unmatched','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, provider_event_id)
);
CREATE INDEX IF NOT EXISTS provider_events_work_idx ON provider_events(status, available_at, created_at);
CREATE INDEX IF NOT EXISTS provider_events_object_idx ON provider_events(provider, object_id, provider_created_at);
CREATE INDEX IF NOT EXISTS provider_events_restaurant_idx ON provider_events(restaurant_id, created_at);

CREATE TABLE IF NOT EXISTS provider_event_object_state (
  provider TEXT NOT NULL CHECK(provider = 'stripe_test'),
  object_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  last_event_created_at TEXT NOT NULL,
  last_event_id TEXT NOT NULL,
  last_result TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(provider, object_id)
);
CREATE INDEX IF NOT EXISTS provider_event_object_state_restaurant_idx ON provider_event_object_state(restaurant_id, updated_at);
`;

export const PROVIDER_EVENTS_MIGRATION = Object.freeze({
  version: PROVIDER_EVENTS_MIGRATION_VERSION,
  name: "provider_test_events_reconciliation",
  sql: PROVIDER_EVENTS_MIGRATION_SQL
});

// Registration in the central migration list is intentionally owned by the
// foundation migration sequence. This helper is useful for isolated tests and
// remains idempotent because every DDL statement is guarded.
export function applyProviderEventsMigration(db) {
  db.exec(PROVIDER_EVENTS_MIGRATION_SQL);
  return PROVIDER_EVENTS_MIGRATION_VERSION;
}
