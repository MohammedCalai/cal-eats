export const businessWeeklyStatementsMigration28 = {
  version: 28,
  name: "weekly_owner_statements_and_durable_delivery",
  sql: `
CREATE TABLE business_statement_preferences (
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),user_id TEXT NOT NULL REFERENCES users(id),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),activated_at TEXT NOT NULL,next_due_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  PRIMARY KEY(restaurant_id,user_id)
);
CREATE INDEX business_statement_due_idx ON business_statement_preferences(enabled,next_due_at);
CREATE TABLE business_weekly_statement_outbox (
  id TEXT PRIMARY KEY,restaurant_id TEXT NOT NULL REFERENCES restaurants(id),user_id TEXT NOT NULL REFERENCES users(id),
  recipient TEXT NOT NULL,week_from TEXT NOT NULL,week_to TEXT NOT NULL,summary TEXT NOT NULL,csv TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,mode TEXT NOT NULL CHECK(mode IN ('local','smtp','graph','off')),
  status TEXT NOT NULL CHECK(status IN ('pending','claimed','local_saved','sent','failed','unknown','cancelled')),
  lease_owner TEXT,lease_expires_at TEXT,dispatch_started_at TEXT,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,
  queued_at TEXT NOT NULL,sent_at TEXT,updated_at TEXT NOT NULL,
  UNIQUE(restaurant_id,user_id,week_from)
);
CREATE INDEX business_statement_dispatch_idx ON business_weekly_statement_outbox(status,queued_at,lease_expires_at);
CREATE INDEX business_statement_owner_idx ON business_weekly_statement_outbox(restaurant_id,user_id,week_from DESC);
`
};
