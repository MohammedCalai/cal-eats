export const businessTerminalMigration68 = {
  version: 68,
  name: "persistent_scoped_business_terminals",
  sql: [
    "ALTER TABLE users ADD COLUMN principal_kind TEXT NOT NULL DEFAULT 'human' CHECK(principal_kind IN ('human','terminal'));",
    "CREATE TABLE business_terminals (id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES business_accounts(id),operator_user_id TEXT NOT NULL UNIQUE REFERENCES users(id),name TEXT NOT NULL,public_key_spki TEXT NOT NULL,public_key_sha256 TEXT NOT NULL,registered_by TEXT NOT NULL REFERENCES users(id),registered_at TEXT NOT NULL,revoked_at TEXT,revoked_by TEXT REFERENCES users(id),last_contact_at TEXT,last_screen_at TEXT,screen_id TEXT);",
    "CREATE UNIQUE INDEX business_terminal_active_business ON business_terminals(business_id) WHERE revoked_at IS NULL;",
    "CREATE TABLE business_terminal_pairings (terminal_id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES business_accounts(id),code_hash TEXT NOT NULL UNIQUE,challenge TEXT NOT NULL,issued_by TEXT NOT NULL REFERENCES users(id),expected_terminal_id TEXT,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,consumed_at TEXT);",
    "CREATE TABLE business_terminal_nonces (terminal_id TEXT NOT NULL REFERENCES business_terminals(id),nonce TEXT NOT NULL,expires_at TEXT NOT NULL,PRIMARY KEY(terminal_id,nonce));",
    "CREATE INDEX business_terminal_nonce_expiry ON business_terminal_nonces(expires_at);",
    "CREATE TABLE business_terminal_grants (token_hash TEXT PRIMARY KEY,terminal_id TEXT NOT NULL REFERENCES business_terminals(id),operator_user_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT);",
    "CREATE INDEX business_terminal_grant_expiry ON business_terminal_grants(terminal_id,revoked_at,expires_at);"
  ].join("\n")
};
