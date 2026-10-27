export const loyaltyMigration20 = {
  version: 20,
  name: "restaurant_loyalty_promotions_and_consent",
  sql: `
CREATE TABLE loyalty_settings (restaurant_id TEXT PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE, regular_order_count INTEGER NOT NULL DEFAULT 3 CHECK(regular_order_count BETWEEN 2 AND 100), regular_window_days INTEGER NOT NULL DEFAULT 60 CHECK(regular_window_days BETWEEN 7 AND 730), lapsed_after_days INTEGER NOT NULL DEFAULT 30 CHECK(lapsed_after_days BETWEEN 7 AND 730), updated_by_user_id TEXT REFERENCES users(id), updated_at TEXT NOT NULL);
CREATE TABLE marketing_preferences (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, in_app_promotions INTEGER NOT NULL DEFAULT 0 CHECK(in_app_promotions IN (0,1)), push_promotions INTEGER NOT NULL DEFAULT 0 CHECK(push_promotions IN (0,1)), consent_version TEXT NOT NULL DEFAULT 'loyalty-v1', consent_source TEXT NOT NULL DEFAULT 'default', consented_at TEXT, updated_at TEXT NOT NULL);
INSERT INTO marketing_preferences(user_id,in_app_promotions,push_promotions,consent_version,consent_source,consented_at,updated_at) SELECT id,merchant_offers,0,'loyalty-v1','legacy-merchant-offers-unknown-time',NULL,created_at FROM users;
ALTER TABLE offer_campaigns ADD COLUMN offer_type TEXT NOT NULL DEFAULT 'free_item' CHECK(offer_type IN ('free_item','percent_off','fixed_off'));
ALTER TABLE offer_campaigns ADD COLUMN offer_value INTEGER NOT NULL DEFAULT 0 CHECK(offer_value >= 0);
ALTER TABLE offer_campaigns ADD COLUMN starts_at TEXT;
ALTER TABLE offer_campaigns ADD COLUMN redemption_limit INTEGER NOT NULL DEFAULT 100000 CHECK(redemption_limit BETWEEN 1 AND 100000);
ALTER TABLE offer_campaigns ADD COLUMN budget_minor INTEGER CHECK(budget_minor IS NULL OR budget_minor >= 0);
ALTER TABLE offer_campaigns ADD COLUMN eligible_item_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE offer_campaigns ADD COLUMN eligible_categories TEXT NOT NULL DEFAULT '[]';
ALTER TABLE offer_campaigns ADD COLUMN recipient_segment TEXT NOT NULL DEFAULT 'selected' CHECK(recipient_segment IN ('selected','new','returning','regular','lapsed','first_order'));
ALTER TABLE offer_campaigns ADD COLUMN stacking_policy TEXT NOT NULL DEFAULT 'exclusive' CHECK(stacking_policy='exclusive');
ALTER TABLE offer_campaigns ADD COLUMN funding_party TEXT NOT NULL DEFAULT 'restaurant' CHECK(funding_party='restaurant');
ALTER TABLE offer_campaigns ADD COLUMN segment_snapshot TEXT NOT NULL DEFAULT '{}';
ALTER TABLE offer_grants ADD COLUMN reserved_discount_minor INTEGER NOT NULL DEFAULT 0 CHECK(reserved_discount_minor >= 0);
ALTER TABLE orders ADD COLUMN gross_food_minor INTEGER NOT NULL DEFAULT 0 CHECK(gross_food_minor >= 0);
ALTER TABLE orders ADD COLUMN restaurant_discount_minor INTEGER NOT NULL DEFAULT 0 CHECK(restaurant_discount_minor >= 0);
ALTER TABLE orders ADD COLUMN promotion_snapshot TEXT;
UPDATE orders SET gross_food_minor=subtotal_minor WHERE gross_food_minor=0;
CREATE INDEX loyalty_orders_restaurant_customer ON orders(restaurant_id,customer_id,status,created_at);
CREATE INDEX loyalty_campaign_window ON offer_campaigns(restaurant_id,starts_at,expires_at);
`
};
