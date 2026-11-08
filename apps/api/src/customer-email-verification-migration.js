export const customerEmailVerificationMigration50 = {
  version: 50,
  name: "new_customer_signup_email_verification",
  sql: `
ALTER TABLE users ADD COLUMN email_verification_required INTEGER NOT NULL DEFAULT 0 CHECK(email_verification_required IN (0,1));
CREATE INDEX account_access_verification_cooldown_idx ON account_access_tokens(user_id,purpose,issued_email,created_at);
CREATE TRIGGER account_email_change_invalidates_verification AFTER UPDATE OF email ON users
 WHEN lower(NEW.email)<>lower(OLD.email)
 BEGIN
   UPDATE users SET email_verified_at=NULL WHERE id=NEW.id;
   UPDATE account_access_tokens SET consumed_at=COALESCE(consumed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE user_id=NEW.id;
   UPDATE account_access_email_outbox SET status='cancelled',ciphertext=NULL,nonce=NULL,auth_tag=NULL,next_attempt_at=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error='ACCOUNT_EMAIL_CHANGED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE user_id=NEW.id AND (status IN ('pending','failed') OR (status='claimed' AND dispatch_started_at IS NULL));
 END;
`
};
