export const mediaObjectMigration56 = {
  version: 56,
  name: "private_media_object_storage",
  sql: `
CREATE TABLE media_asset_objects (
  media_id TEXT PRIMARY KEY REFERENCES media_assets(id) ON DELETE CASCADE,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  backend_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  object_version TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
  byte_length INTEGER NOT NULL CHECK(byte_length>0),
  created_at TEXT NOT NULL
);
CREATE INDEX media_asset_objects_restaurant_idx ON media_asset_objects(restaurant_id);
CREATE TABLE media_object_cleanup (
  object_key TEXT PRIMARY KEY,
  backend_id TEXT NOT NULL,
  available_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX media_object_cleanup_due_idx ON media_object_cleanup(backend_id,available_at);
CREATE TRIGGER media_asset_object_binding BEFORE INSERT ON media_asset_objects
WHEN NOT EXISTS(SELECT 1 FROM media_assets m WHERE m.id=NEW.media_id AND m.restaurant_id=NEW.restaurant_id AND m.byte_length=NEW.byte_length AND length(m.data)=0)
BEGIN SELECT RAISE(ABORT,'Media object does not match its tenant metadata'); END;
CREATE TRIGGER media_asset_object_immutable BEFORE UPDATE ON media_asset_objects
BEGIN SELECT RAISE(ABORT,'Media object bindings are immutable'); END;
`
};
