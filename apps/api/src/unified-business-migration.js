export const unifiedBusinessMigration67 = {
  version: 67,
  name: 'unified_business_accounts',
  sql: `
CREATE TABLE business_accounts(
 id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,archived_at TEXT);
CREATE TABLE business_product_links(
 id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES business_accounts(id),
 product TEXT NOT NULL CHECK(product IN('calai','cal-eats')),source_account_id TEXT NOT NULL,
 restaurant_id TEXT REFERENCES restaurants(id),status TEXT NOT NULL CHECK(status IN('active','inactive')),
 provider_origin TEXT CHECK(provider_origin IS NULL OR provider_origin='https://api.calai.info'),
 upstream_user_id TEXT,upstream_email TEXT,encrypted_credentials TEXT,credential_expires_at TEXT,
 credential_checked_at TEXT,last_error_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 UNIQUE(business_id,product),UNIQUE(product,source_account_id),
 CHECK((product='cal-eats' AND restaurant_id=source_account_id AND provider_origin IS NULL AND upstream_user_id IS NULL AND encrypted_credentials IS NULL)
 OR(product='calai' AND restaurant_id IS NULL AND provider_origin='https://api.calai.info' AND upstream_user_id IS NOT NULL)));
CREATE INDEX business_product_account_idx ON business_product_links(business_id,status);
CREATE TABLE business_account_memberships(
 business_id TEXT NOT NULL REFERENCES business_accounts(id),user_id TEXT NOT NULL REFERENCES users(id),
 permission TEXT NOT NULL CHECK(permission IN('owner','staff')),created_at TEXT NOT NULL,
 membership_source TEXT NOT NULL DEFAULT 'master' CHECK(membership_source IN('master','cal-eats')),
 can_view_calai INTEGER NOT NULL DEFAULT 0 CHECK(can_view_calai IN(0,1)),
 PRIMARY KEY(business_id,user_id));
CREATE TABLE business_account_preferences(
 user_id TEXT PRIMARY KEY REFERENCES users(id),business_id TEXT NOT NULL REFERENCES business_accounts(id),updated_at TEXT NOT NULL);
CREATE TABLE business_source_identities(
 provider_origin TEXT NOT NULL CHECK(provider_origin='https://api.calai.info'),source_user_id TEXT NOT NULL,
 source_business_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),business_id TEXT NOT NULL REFERENCES business_accounts(id),
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 PRIMARY KEY(provider_origin,source_user_id),UNIQUE(provider_origin,source_business_id));
CREATE TABLE business_account_aliases(
 old_id TEXT PRIMARY KEY REFERENCES business_accounts(id),business_id TEXT NOT NULL REFERENCES business_accounts(id),
 linked_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,CHECK(old_id<>business_id));
INSERT INTO business_accounts(id,name,created_at,updated_at,archived_at)
 SELECT id,name,created_at,created_at,archived_at FROM restaurants;
INSERT INTO business_product_links(id,business_id,product,source_account_id,restaurant_id,status,created_at,updated_at)
 SELECT id,id,'cal-eats',id,id,CASE WHEN archived_at IS NULL THEN 'active' ELSE 'inactive' END,created_at,created_at FROM restaurants;
INSERT INTO business_account_memberships(business_id,user_id,permission,created_at,membership_source)
 SELECT restaurant_id,user_id,permission,created_at,'cal-eats' FROM restaurant_memberships;
`
};
