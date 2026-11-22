export const businessProductPolicyMigration69={version:69,name:'independent_business_product_permissions',sql:`
CREATE TABLE business_product_permissions(
 business_id TEXT NOT NULL REFERENCES business_accounts(id),product TEXT NOT NULL CHECK(product IN('calai','cal-eats')),
 allowed INTEGER NOT NULL DEFAULT 0 CHECK(allowed IN(0,1)),changed_by TEXT REFERENCES users(id),changed_at TEXT NOT NULL,
 PRIMARY KEY(business_id,product));
INSERT INTO business_product_permissions(business_id,product,allowed,changed_at)
 SELECT id,'calai',0,updated_at FROM business_accounts;
INSERT INTO business_product_permissions(business_id,product,allowed,changed_at)
 SELECT a.id,'cal-eats',CASE WHEN EXISTS(SELECT 1 FROM business_product_links p WHERE p.business_id=a.id AND p.product='cal-eats' AND p.status='active') THEN 1 ELSE 0 END,a.updated_at FROM business_accounts a;
CREATE TABLE business_product_authorities(
 business_id TEXT NOT NULL REFERENCES business_accounts(id),product TEXT NOT NULL CHECK(product IN('calai','cal-eats')),
 user_id TEXT NOT NULL REFERENCES users(id),source_user_id TEXT NOT NULL,source_account_id TEXT NOT NULL,
 verified_at TEXT NOT NULL,PRIMARY KEY(business_id,product,user_id));
CREATE TABLE business_connection_proofs(
 token_hash TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES business_accounts(id),product TEXT NOT NULL CHECK(product IN('calai','cal-eats')),
 user_id TEXT NOT NULL REFERENCES users(id),session_id TEXT NOT NULL,source_user_id TEXT NOT NULL,source_account_id TEXT NOT NULL,
 source_name TEXT NOT NULL,encrypted_proof TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,consumed_at TEXT);
CREATE INDEX business_connection_proof_expiry ON business_connection_proofs(expires_at);
CREATE TABLE business_native_references(business_id TEXT NOT NULL REFERENCES business_accounts(id),product TEXT NOT NULL CHECK(product IN('calai','cal-eats')),source_account_id TEXT NOT NULL,name TEXT NOT NULL,native_status TEXT,verified_at TEXT NOT NULL,PRIMARY KEY(business_id,product),UNIQUE(product,source_account_id));
INSERT INTO business_native_references SELECT p.business_id,p.product,p.source_account_id,a.name,NULL,p.updated_at FROM business_product_links p JOIN business_accounts a ON a.id=p.business_id;
CREATE TABLE native_platform_sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),token_hash TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT);
`};
