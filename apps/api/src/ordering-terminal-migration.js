export const orderingTerminalMigration64={version:64,name:"enrolled_ordering_terminal_authority",sql:`
CREATE TABLE ordering_terminals (
 id TEXT PRIMARY KEY,restaurant_id TEXT NOT NULL REFERENCES restaurants(id),name TEXT NOT NULL,public_key_spki TEXT NOT NULL,public_key_sha256 TEXT NOT NULL,
 registered_by TEXT NOT NULL REFERENCES users(id),registered_at TEXT NOT NULL,revoked_at TEXT,revoked_by TEXT REFERENCES users(id),
 last_contact_at TEXT,screen_last_seen_at TEXT,screen_id TEXT,screen_session_id TEXT REFERENCES sessions(id)
);
CREATE UNIQUE INDEX ordering_terminal_active_restaurant ON ordering_terminals(restaurant_id) WHERE revoked_at IS NULL;
CREATE TABLE ordering_terminal_pair_codes (
 terminal_id TEXT PRIMARY KEY,restaurant_id TEXT NOT NULL REFERENCES restaurants(id),code_hash TEXT NOT NULL UNIQUE,challenge TEXT NOT NULL,
 issued_by TEXT NOT NULL REFERENCES users(id),expected_terminal_id TEXT,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,consumed_at TEXT
);
CREATE TABLE ordering_terminal_nonces (
 terminal_id TEXT NOT NULL REFERENCES ordering_terminals(id),nonce TEXT NOT NULL,expires_at TEXT NOT NULL,PRIMARY KEY(terminal_id,nonce)
);
CREATE INDEX ordering_terminal_nonce_expiry ON ordering_terminal_nonces(expires_at);
CREATE TABLE ordering_terminal_handoffs (
 token_hash TEXT PRIMARY KEY,terminal_id TEXT NOT NULL REFERENCES ordering_terminals(id),restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),screen_id TEXT NOT NULL,
 created_at TEXT NOT NULL,expires_at TEXT NOT NULL,consumed_at TEXT
);
CREATE TABLE ordering_terminal_sessions (
 token_hash TEXT PRIMARY KEY,terminal_id TEXT NOT NULL REFERENCES ordering_terminals(id),restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),screen_id TEXT NOT NULL,
 created_at TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT
);
CREATE INDEX ordering_terminal_session_owner ON ordering_terminal_sessions(terminal_id,user_id);
CREATE TABLE ordering_terminal_screen_challenges (
 token_hash TEXT PRIMARY KEY,terminal_id TEXT NOT NULL REFERENCES ordering_terminals(id),restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),screen_id TEXT NOT NULL,
 created_at TEXT NOT NULL,expires_at TEXT NOT NULL,consumed_at TEXT
);
ALTER TABLE printer_devices ADD COLUMN ordering_terminal_id TEXT REFERENCES ordering_terminals(id);
ALTER TABLE restaurant_memberships ADD COLUMN can_process_orders INTEGER NOT NULL DEFAULT 1 CHECK(can_process_orders IN(0,1));
ALTER TABLE restaurant_memberships ADD COLUMN can_view_finance INTEGER NOT NULL DEFAULT 0 CHECK(can_view_finance IN(0,1));
ALTER TABLE restaurant_memberships ADD COLUMN can_view_devices INTEGER NOT NULL DEFAULT 0 CHECK(can_view_devices IN(0,1));
ALTER TABLE restaurant_memberships ADD COLUMN can_manage_menu INTEGER NOT NULL DEFAULT 0 CHECK(can_manage_menu IN(0,1));
ALTER TABLE restaurant_memberships ADD COLUMN can_manage_marketing INTEGER NOT NULL DEFAULT 0 CHECK(can_manage_marketing IN(0,1));
ALTER TABLE restaurant_memberships ADD COLUMN can_manage_customers INTEGER NOT NULL DEFAULT 0 CHECK(can_manage_customers IN(0,1));
ALTER TABLE restaurant_memberships ADD COLUMN can_manage_settings INTEGER NOT NULL DEFAULT 0 CHECK(can_manage_settings IN(0,1));
ALTER TABLE restaurant_memberships ADD COLUMN can_manage_staff INTEGER NOT NULL DEFAULT 0 CHECK(can_manage_staff IN(0,1));
`};
