export const accountSetupAttemptMigration57 = {
  version:57,name:"durable_connected_account_setup_attempts",sql:`
CREATE TABLE provider_account_setup_attempts (
 restaurant_id TEXT NOT NULL REFERENCES restaurants(id),provider_mode TEXT NOT NULL CHECK(provider_mode IN ('stripe_test','stripe_live')),
 attempt_no INTEGER NOT NULL CHECK(attempt_no>=0),idempotency_key TEXT NOT NULL UNIQUE,owner_email TEXT NOT NULL,platform_account_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('in_flight','profile_rejected','unconfirmed','succeeded')),
 lease_owner TEXT,lease_expires_at TEXT,outcome_code TEXT,provider_reference TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 PRIMARY KEY(restaurant_id,provider_mode,attempt_no),
 CHECK(status<>'profile_rejected' OR (outcome_code='STRIPE_CONNECT_PLATFORM_PROFILE_REQUIRED' AND provider_reference IS NULL)),
 CHECK(status<>'succeeded' OR provider_reference IS NOT NULL)
);
CREATE TRIGGER account_setup_attempt_identity_immutable BEFORE UPDATE OF restaurant_id,provider_mode,attempt_no,idempotency_key,owner_email,platform_account_id,created_at ON provider_account_setup_attempts BEGIN SELECT RAISE(ABORT,'Connected account attempt identity is immutable'); END;
CREATE TRIGGER account_setup_attempt_delete_protected BEFORE DELETE ON provider_account_setup_attempts BEGIN SELECT RAISE(ABORT,'Connected account attempts cannot be removed'); END;
`};
