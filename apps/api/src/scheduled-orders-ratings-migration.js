export const scheduledOrdersRatingsMigration36 = {
  version: 36,
  name: "scheduled_orders_and_shop_star_ratings",
  sql: `
ALTER TABLE orders ADD COLUMN scheduled_for TEXT;
ALTER TABLE orders ADD COLUMN schedule_minimum_lead_minutes INTEGER CHECK(schedule_minimum_lead_minutes IS NULL OR schedule_minimum_lead_minutes BETWEEN 30 AND 480);
CREATE INDEX orders_restaurant_schedule_idx ON orders(restaurant_id,scheduled_for) WHERE scheduled_for IS NOT NULL;
CREATE TABLE restaurant_order_ratings (
  order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  customer_id TEXT NOT NULL REFERENCES users(id),
  stars INTEGER NOT NULL CHECK(typeof(stars)='integer' AND stars BETWEEN 1 AND 5),
  created_at TEXT NOT NULL
);
CREATE INDEX restaurant_order_ratings_restaurant_idx ON restaurant_order_ratings(restaurant_id,created_at);
`
};
