export const restaurantCommissionMigration39 = {
  version: 39,
  name: "restaurant_commission_controls",
  sql: `
CREATE TABLE restaurant_commission_controls (
  restaurant_id TEXT PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  free_period_starts_at TEXT,
  free_period_ends_at TEXT,
  revision INTEGER NOT NULL CHECK(revision>0),
  updated_by_user_id TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL,
  CHECK((free_period_starts_at IS NULL AND free_period_ends_at IS NULL) OR
        (free_period_starts_at IS NOT NULL AND free_period_ends_at IS NOT NULL AND free_period_ends_at>free_period_starts_at))
);
ALTER TABLE orders ADD COLUMN commission_control_snapshot TEXT CHECK(commission_control_snapshot IS NULL OR json_valid(commission_control_snapshot));
`
};
