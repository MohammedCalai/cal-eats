export const platformAdminMigration66 = {
  version:66,name:'unified_platform_administrator',sql:`
CREATE TABLE platform_admin_links(
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),provider_origin TEXT NOT NULL CHECK(provider_origin='https://api.calai.info'),upstream_user_id TEXT NOT NULL,
 upstream_email TEXT NOT NULL,upstream_name TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,revoked_at TEXT);
CREATE UNIQUE INDEX platform_admin_local_active_idx ON platform_admin_links(user_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX platform_admin_upstream_active_idx ON platform_admin_links(provider_origin,upstream_user_id) WHERE revoked_at IS NULL;
CREATE TABLE platform_admin_sessions(
 session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,link_id TEXT NOT NULL REFERENCES platform_admin_links(id),
 user_id TEXT NOT NULL REFERENCES users(id),encrypted_tokens TEXT,absolute_expires_at TEXT NOT NULL,created_at TEXT NOT NULL,revoked_at TEXT);
CREATE INDEX platform_admin_sessions_link_idx ON platform_admin_sessions(link_id,revoked_at);
CREATE TRIGGER platform_admin_revoke_session AFTER UPDATE OF revoked_at ON sessions WHEN NEW.revoked_at IS NOT NULL
 BEGIN UPDATE platform_admin_sessions SET encrypted_tokens=NULL,revoked_at=COALESCE(revoked_at,NEW.revoked_at) WHERE session_id=NEW.id; END;
CREATE TABLE platform_admin_mutations(
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),link_id TEXT NOT NULL REFERENCES platform_admin_links(id),request_key TEXT NOT NULL,request_hash TEXT NOT NULL,
 method TEXT NOT NULL,path TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('dispatching','confirmed','rejected','unknown','operator_reported_applied','operator_reported_not_applied')),
 response_status INTEGER,response_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 review_result TEXT CHECK(review_result IS NULL OR review_result IN('applied','not_applied')),review_note TEXT,reviewed_at TEXT,reviewed_by TEXT REFERENCES users(id),UNIQUE(user_id,request_key));
CREATE INDEX platform_admin_mutation_status_idx ON platform_admin_mutations(status,updated_at);
CREATE UNIQUE INDEX platform_admin_mutation_owner_idx ON platform_admin_mutations(id,user_id);
CREATE TABLE platform_admin_request_keys(
 user_id TEXT NOT NULL REFERENCES users(id),request_key TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(user_id,request_key),FOREIGN KEY(request_id,user_id) REFERENCES platform_admin_mutations(id,user_id));
`
};
