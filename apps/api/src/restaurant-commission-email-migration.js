export const restaurantCommissionEmailMigration40 = {
  version: 40,
  name: "restaurant_commission_confirmation_emails",
  sql: `
CREATE TABLE restaurant_commission_email_events (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  settings_revision INTEGER NOT NULL CHECK(settings_revision > 0),
  kind TEXT NOT NULL CHECK(kind IN ('scheduled','updated','cancelled','disabled')),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  created_at TEXT NOT NULL,
  UNIQUE(restaurant_id,settings_revision)
);
CREATE TABLE restaurant_commission_email_outbox (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES restaurant_commission_email_events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  recipient TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK(mode IN ('local','smtp','graph','off')),
  status TEXT NOT NULL CHECK(status IN ('pending','claimed','local_saved','sent','failed','unknown','cancelled')),
  lease_owner TEXT,
  lease_expires_at TEXT,
  dispatch_started_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at TEXT,
  last_error TEXT,
  queued_at TEXT NOT NULL,
  sent_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(event_id,user_id)
);
CREATE INDEX restaurant_commission_email_dispatch_idx ON restaurant_commission_email_outbox(status,next_attempt_at,queued_at);
`
};
