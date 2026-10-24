export const migrations = [
  {
    version: 1,
    name: "initial_schema",
    sql: `
CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('customer','restaurant','admin')), created_at TEXT NOT NULL);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX sessions_token_hash_idx ON sessions(token_hash);
CREATE TABLE restaurants (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')), created_at TEXT NOT NULL);
CREATE TABLE restaurant_memberships (restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY (restaurant_id,user_id));
CREATE TABLE menu_items (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', price_minor INTEGER NOT NULL CHECK(price_minor >= 0), available INTEGER NOT NULL DEFAULT 1 CHECK(available IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE orders (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL REFERENCES restaurants(id), restaurant_name TEXT NOT NULL, customer_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL CHECK(status IN ('placed','accepted','preparing','ready','completed','rejected')), currency TEXT NOT NULL DEFAULT 'GBP', subtotal_minor INTEGER NOT NULL CHECK(subtotal_minor >= 0), commission_minor INTEGER NOT NULL CHECK(commission_minor >= 0), payment_method TEXT NOT NULL CHECK(payment_method IN ('mock_card','cash')), payment_status TEXT NOT NULL, fulfillment TEXT NOT NULL CHECK(fulfillment = 'collection'), idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(customer_id,idempotency_key));
CREATE TABLE order_items (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE, menu_item_id TEXT NOT NULL REFERENCES menu_items(id), name TEXT NOT NULL, unit_price_minor INTEGER NOT NULL CHECK(unit_price_minor >= 0), quantity INTEGER NOT NULL CHECK(quantity > 0));
CREATE TABLE order_events (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE, actor_user_id TEXT REFERENCES users(id), kind TEXT NOT NULL, from_status TEXT, to_status TEXT, created_at TEXT NOT NULL);
CREATE TABLE ledger_entries (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), restaurant_id TEXT NOT NULL REFERENCES restaurants(id), kind TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'GBP', created_at TEXT NOT NULL, UNIQUE(order_id,kind));
`
  },
  {
    version: 2,
    name: "delivery_journey",
    foreignKeysOff: true,
    sql: `
ALTER TABLE restaurants ADD COLUMN delivery_enabled INTEGER NOT NULL DEFAULT 0 CHECK(delivery_enabled IN (0,1));
ALTER TABLE restaurants ADD COLUMN delivery_outcodes TEXT NOT NULL DEFAULT '[]';
ALTER TABLE restaurants ADD COLUMN delivery_fee_minor INTEGER NOT NULL DEFAULT 0 CHECK(delivery_fee_minor >= 0);
ALTER TABLE restaurants ADD COLUMN min_delivery_subtotal_minor INTEGER NOT NULL DEFAULT 0 CHECK(min_delivery_subtotal_minor >= 0);
CREATE TABLE orders_new (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL REFERENCES restaurants(id), restaurant_name TEXT NOT NULL, customer_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL CHECK(status IN ('placed','accepted','preparing','ready','out_for_delivery','completed','rejected')), currency TEXT NOT NULL DEFAULT 'GBP', subtotal_minor INTEGER NOT NULL CHECK(subtotal_minor >= 0), delivery_fee_minor INTEGER NOT NULL DEFAULT 0 CHECK(delivery_fee_minor >= 0), total_minor INTEGER NOT NULL DEFAULT 0 CHECK(total_minor >= 0), delivery_address TEXT, commission_minor INTEGER NOT NULL CHECK(commission_minor >= 0), payment_method TEXT NOT NULL CHECK(payment_method IN ('mock_card','cash')), payment_status TEXT NOT NULL, fulfillment TEXT NOT NULL CHECK(fulfillment IN ('collection','delivery')), idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(customer_id,idempotency_key));
INSERT INTO orders_new(id,restaurant_id,restaurant_name,customer_id,status,currency,subtotal_minor,delivery_fee_minor,total_minor,delivery_address,commission_minor,payment_method,payment_status,fulfillment,idempotency_key,request_hash,created_at,updated_at)
SELECT id,restaurant_id,restaurant_name,customer_id,status,currency,subtotal_minor,0,subtotal_minor,NULL,commission_minor,payment_method,payment_status,fulfillment,idempotency_key,request_hash,created_at,updated_at FROM orders;
DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;
CREATE TABLE audit_events (id TEXT PRIMARY KEY, actor_user_id TEXT NOT NULL REFERENCES users(id), entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL);
`
  },
  {
    version: 3,
    name: "finance_operations",
    foreignKeysOff: true,
    sql: `
ALTER TABLE orders ADD COLUMN contract_rate_bps INTEGER NOT NULL DEFAULT 700;
ALTER TABLE orders ADD COLUMN contract_policy_version TEXT NOT NULL DEFAULT 'demo-v1';
ALTER TABLE orders ADD COLUMN contract_demo_only INTEGER NOT NULL DEFAULT 1;
CREATE TABLE contracts (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL UNIQUE REFERENCES restaurants(id) ON DELETE CASCADE, rate_bps INTEGER NOT NULL, duration_months INTEGER NOT NULL, policy_version TEXT NOT NULL, demo_only INTEGER NOT NULL CHECK(demo_only IN (0,1)), accepted_at TEXT, accepted_by_user_id TEXT REFERENCES users(id), created_at TEXT NOT NULL);
CREATE TABLE refunds (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), actor_user_id TEXT NOT NULL REFERENCES users(id), idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, food_amount_minor INTEGER NOT NULL CHECK(food_amount_minor >= 0), delivery_amount_minor INTEGER NOT NULL CHECK(delivery_amount_minor >= 0), reason TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('simulated_card','manual_cash_return')), commission_reversal_minor INTEGER NOT NULL CHECK(commission_reversal_minor >= 0), created_at TEXT NOT NULL, UNIQUE(actor_user_id,idempotency_key));
CREATE TABLE ledger_entries_new (id TEXT PRIMARY KEY, order_id TEXT REFERENCES orders(id), restaurant_id TEXT NOT NULL REFERENCES restaurants(id), kind TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'GBP', reference_type TEXT NOT NULL DEFAULT 'order', reference_id TEXT, created_at TEXT NOT NULL);
INSERT INTO ledger_entries_new(id,order_id,restaurant_id,kind,amount_minor,currency,reference_type,reference_id,created_at) SELECT id,order_id,restaurant_id,kind,amount_minor,currency,'order',order_id,created_at FROM ledger_entries;
DROP TABLE ledger_entries;
ALTER TABLE ledger_entries_new RENAME TO ledger_entries;
CREATE UNIQUE INDEX ledger_reference_unique ON ledger_entries(kind,reference_type,reference_id);
CREATE TABLE cash_settlements (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL REFERENCES restaurants(id), actor_user_id TEXT NOT NULL REFERENCES users(id), idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), reference TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(actor_user_id,idempotency_key));
CREATE TABLE notification_outbox (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, entity_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','delivered','failed')), attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(event_type,entity_id));
CREATE TABLE operational_jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, entity_id TEXT, status TEXT NOT NULL CHECK(status IN ('completed','failed')), attempts INTEGER NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(kind,entity_id));
CREATE TABLE print_jobs (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), requested_by_user_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL CHECK(status IN ('requested','browser_opened','failed')), error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE integration_status (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, mode TEXT NOT NULL CHECK(mode IN ('mock','off')), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), detail TEXT NOT NULL, updated_at TEXT NOT NULL);
`
  },
  {
    version: 4,
    name: "local_notification_sink",
    sql: `
CREATE TABLE local_notifications (id TEXT PRIMARY KEY, outbox_id TEXT NOT NULL UNIQUE REFERENCES notification_outbox(id), event_type TEXT NOT NULL, entity_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
`
  },
  {
    version: 5,
    name: "product_operations",
    sql: `
ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT '';
ALTER TABLE restaurant_memberships ADD COLUMN permission TEXT NOT NULL DEFAULT 'owner' CHECK(permission IN ('owner','staff'));
ALTER TABLE restaurants ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE restaurants ADD COLUMN cuisine TEXT NOT NULL DEFAULT '';
ALTER TABLE restaurants ADD COLUMN phone TEXT NOT NULL DEFAULT '';
ALTER TABLE restaurants ADD COLUMN address TEXT NOT NULL DEFAULT '';
ALTER TABLE restaurants ADD COLUMN collection_enabled INTEGER NOT NULL DEFAULT 1 CHECK(collection_enabled IN (0,1));
ALTER TABLE restaurants ADD COLUMN cash_enabled INTEGER NOT NULL DEFAULT 1 CHECK(cash_enabled IN (0,1));
ALTER TABLE restaurants ADD COLUMN paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1));
ALTER TABLE restaurants ADD COLUMN busy_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE restaurants ADD COLUMN estimated_delivery_minutes INTEGER NOT NULL DEFAULT 35;
ALTER TABLE restaurants ADD COLUMN estimated_collection_minutes INTEGER NOT NULL DEFAULT 20;
ALTER TABLE restaurants ADD COLUMN opening_hours TEXT NOT NULL DEFAULT '[]';
ALTER TABLE restaurants ADD COLUMN holiday_dates TEXT NOT NULL DEFAULT '[]';
ALTER TABLE restaurants ADD COLUMN always_open INTEGER NOT NULL DEFAULT 0 CHECK(always_open IN (0,1));
ALTER TABLE restaurants ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0 CHECK(suspended IN (0,1));
ALTER TABLE restaurants ADD COLUMN suspension_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE restaurants ADD COLUMN food_verification_status TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE restaurants ADD COLUMN food_source TEXT;
ALTER TABLE restaurants ADD COLUMN food_checked_at TEXT;
ALTER TABLE menu_items ADD COLUMN category TEXT NOT NULL DEFAULT '';
ALTER TABLE menu_items ADD COLUMN allergens TEXT NOT NULL DEFAULT '[]';
ALTER TABLE menu_items ADD COLUMN dietary_tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE menu_items ADD COLUMN modifier_groups TEXT NOT NULL DEFAULT '[]';
ALTER TABLE orders ADD COLUMN customer_name TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN customer_email TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN customer_phone TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN delivery_instructions TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN allergy_notes TEXT NOT NULL DEFAULT '';
ALTER TABLE order_items ADD COLUMN base_price_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD COLUMN selected_modifiers TEXT NOT NULL DEFAULT '[]';
ALTER TABLE order_items ADD COLUMN allergens TEXT NOT NULL DEFAULT '[]';
ALTER TABLE order_items ADD COLUMN category TEXT NOT NULL DEFAULT '';
UPDATE order_items SET base_price_minor=unit_price_minor;
CREATE TABLE support_cases (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), order_id TEXT REFERENCES orders(id), subject TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','resolved')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE deletion_requests (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), reason TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('requested','under_review','resolved')), note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
`
  },
  {
    version: 6,
    name: "offers_and_in_app_notifications",
    sql: `
CREATE TABLE offer_campaigns (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL REFERENCES restaurants(id), created_by_user_id TEXT NOT NULL REFERENCES users(id), idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, menu_item_id TEXT NOT NULL REFERENCES menu_items(id), item_name TEXT NOT NULL, item_value_minor INTEGER NOT NULL CHECK(item_value_minor >= 0), min_subtotal_minor INTEGER NOT NULL CHECK(min_subtotal_minor >= 0), expires_at TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(created_by_user_id,idempotency_key));
CREATE TABLE offer_grants (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES offer_campaigns(id) ON DELETE CASCADE, restaurant_id TEXT NOT NULL REFERENCES restaurants(id), customer_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL CHECK(status IN ('available','reserved','redeemed','expired')), viewed_at TEXT, reserved_order_id TEXT REFERENCES orders(id), redeemed_order_id TEXT REFERENCES orders(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(campaign_id,customer_id));
CREATE INDEX offer_grants_customer_idx ON offer_grants(customer_id,created_at);
CREATE TABLE user_notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, order_id TEXT REFERENCES orders(id), offer_id TEXT REFERENCES offer_grants(id), restaurant_id TEXT REFERENCES restaurants(id), event_key TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT, UNIQUE(user_id,event_key));
CREATE INDEX user_notifications_user_idx ON user_notifications(user_id,created_at);
ALTER TABLE orders ADD COLUMN offer_grant_id TEXT REFERENCES offer_grants(id);
ALTER TABLE orders ADD COLUMN offer_snapshot TEXT;
ALTER TABLE order_items ADD COLUMN is_offer_item INTEGER NOT NULL DEFAULT 0 CHECK(is_offer_item IN (0,1));
`
  },
  {
    version: 7,
    name: "local_account_access",
    sql: `
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
CREATE TABLE account_access_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, purpose TEXT NOT NULL CHECK(purpose IN ('password_reset','email_verification')), token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX account_access_tokens_user_idx ON account_access_tokens(user_id,purpose,created_at);
CREATE TABLE local_mail_sink (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('password_reset','email_verification')), recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX local_mail_sink_created_idx ON local_mail_sink(created_at);
`
  },
  {
    version: 8,
    name: "persistent_auth_throttling",
    sql: `
CREATE TABLE auth_rate_limits (bucket_key TEXT PRIMARY KEY, window_start_ms INTEGER NOT NULL, attempt_count INTEGER NOT NULL CHECK(attempt_count > 0));
`
  },
  {
    version: 9,
    name: "final_local_polish",
    sql: `
ALTER TABLE users ADD COLUMN merchant_offers INTEGER NOT NULL DEFAULT 0 CHECK(merchant_offers IN (0,1));
CREATE TABLE saved_addresses (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, label TEXT NOT NULL, line1 TEXT NOT NULL, line2 TEXT, city TEXT NOT NULL, postcode TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX saved_addresses_user_idx ON saved_addresses(user_id,created_at);
CREATE TABLE media_assets (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE, mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png','image/jpeg')), data BLOB NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, byte_length INTEGER NOT NULL, created_at TEXT NOT NULL);
ALTER TABLE restaurants ADD COLUMN cover_media_id TEXT REFERENCES media_assets(id);
ALTER TABLE menu_items ADD COLUMN photo_media_id TEXT REFERENCES media_assets(id);
ALTER TABLE menu_items ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
UPDATE menu_items SET sort_order=rowid;
CREATE TABLE menu_imports (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE, actor_user_id TEXT NOT NULL REFERENCES users(id), idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, item_ids TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(actor_user_id,idempotency_key));
`
  }
];
