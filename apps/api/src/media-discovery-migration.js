export const mediaDiscoveryMigration35 = {
  version: 35,
  name: "tenant_media_and_discovery_indexes",
  sql: `
CREATE INDEX media_assets_restaurant_bytes_idx ON media_assets(restaurant_id,byte_length);
CREATE INDEX restaurants_cover_media_idx ON restaurants(cover_media_id) WHERE cover_media_id IS NOT NULL;
CREATE INDEX menu_items_photo_media_idx ON menu_items(photo_media_id) WHERE photo_media_id IS NOT NULL;
CREATE INDEX menu_items_restaurant_available_idx ON menu_items(restaurant_id,available,sort_order,created_at);
CREATE INDEX restaurants_discovery_idx ON restaurants(status,suspended,name,id);
CREATE INDEX orders_restaurant_status_created_idx ON orders(restaurant_id,status,created_at);
CREATE INDEX restaurant_memberships_user_idx ON restaurant_memberships(user_id,restaurant_id);
`
};
