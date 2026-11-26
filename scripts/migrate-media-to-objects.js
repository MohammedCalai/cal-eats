import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { assertDatabaseCompatible, openDatabase, withTransaction } from "../apps/api/src/db/index.js";
import { decodeImage } from "../apps/api/src/polish.js";
import { loadMediaObjectStore, mediaObjectKey, mediaSha256 } from "../apps/api/src/media-object-store.js";

const MAX_IMAGE_BYTES = 1024 * 1024;
const DEFAULT_BATCH_SIZE = 25;

export function mediaRelocationPlan(db) {
  assertDatabaseCompatible(db, { requireCurrent: true });
  return { ...db.prepare(`SELECT
    COUNT(*) AS totalImages,
    COUNT(*) - COUNT(o.media_id) AS inlineImages,
    COALESCE(SUM(CASE WHEN o.media_id IS NULL THEN m.byte_length ELSE 0 END), 0) AS inlineBytes,
    COUNT(o.media_id) AS externalImages,
    COUNT(DISTINCT o.backend_id) AS externalBackends,
    COALESCE(SUM(CASE WHEN m.byte_length NOT BETWEEN 1 AND ? OR
      (o.media_id IS NULL AND length(m.data) <> m.byte_length) OR
      (o.media_id IS NOT NULL AND (length(m.data) <> 0 OR o.byte_length <> m.byte_length OR o.restaurant_id <> m.restaurant_id))
      THEN 1 ELSE 0 END), 0) AS invalidImages
    FROM media_assets m LEFT JOIN media_asset_objects o ON o.media_id=m.id`).get(MAX_IMAGE_BYTES) };
}

export async function relocateInlineMedia(db, store, { limit = DEFAULT_BATCH_SIZE, now = () => new Date() } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error("Batch size must be between 1 and 100");
  if (typeof store?.backendId !== "string" || !store.backendId || typeof store.put !== "function" || typeof store.read !== "function") {
    throw Error("Configure the matching versioned image storage before applying the migration");
  }
  const before = mediaRelocationPlan(db);
  if (before.invalidImages || db.prepare("SELECT 1 FROM media_asset_objects WHERE backend_id <> ? LIMIT 1").get(store.backendId)) {
    throw Error("Existing image metadata or storage configuration requires review");
  }
  const candidates = db.prepare(`SELECT m.id FROM media_assets m
    WHERE NOT EXISTS (SELECT 1 FROM media_asset_objects o WHERE o.media_id=m.id)
    ORDER BY m.id LIMIT ?`).all(limit);
  const selectInline = db.prepare(`SELECT m.* FROM media_assets m WHERE m.id=?
    AND NOT EXISTS (SELECT 1 FROM media_asset_objects o WHERE o.media_id=m.id)`);
  const reserve = db.prepare("INSERT INTO media_object_cleanup(object_key,backend_id,available_at,created_at) VALUES(?,?,?,?)");
  const reservation = db.prepare("SELECT 1 FROM media_object_cleanup WHERE object_key=? AND backend_id=? AND available_at>?");
  const clearInline = db.prepare("UPDATE media_assets SET data=X'' WHERE id=?");
  const bindObject = db.prepare(`INSERT INTO media_asset_objects
    (media_id,restaurant_id,backend_id,object_key,object_version,content_sha256,byte_length,created_at) VALUES(?,?,?,?,?,?,?,?)`);
  const clearReservation = db.prepare("DELETE FROM media_object_cleanup WHERE object_key=? AND backend_id=?");
  let relocated = 0, relocatedBytes = 0, alreadyChanged = 0;
  const failures = {};
  const recordFailure = code => { failures[code] = (failures[code] ?? 0) + 1; };

  for (const { id } of candidates) {
    const row = selectInline.get(id);
    if (!row) { alreadyChanged++; continue; }
    const bytes = Buffer.from(row.data);
    const sha256 = mediaSha256(bytes);
    let key;
    try {
      if (bytes.length !== row.byte_length || bytes.length > MAX_IMAGE_BYTES) throw Error("Invalid recorded image size");
      const image = decodeImage({ mimeType: row.mime_type, dataBase64: bytes.toString("base64") });
      if (image.width !== row.width || image.height !== row.height) throw Error("Image dimensions changed");
      // Each attempt has its own immutable key. An ambiguous PUT or concurrent
      // change leaves the standard cleanup reservation without blocking a retry.
      key = mediaObjectKey(row.restaurant_id, randomUUID(), row.mime_type);
    } catch { recordFailure("invalid_inline_image"); continue; }

    const createdAt = now();
    reserve.run(key, store.backendId, new Date(createdAt.getTime() + 3600000).toISOString(), createdAt.toISOString());
    let versionId;
    try {
      ({ versionId } = await store.put({ key, bytes, mimeType: row.mime_type, sha256 }));
      if (typeof versionId !== "string" || !versionId || versionId === "null" || versionId.length > 1024 || /[\r\n\0]/.test(versionId)) {
        throw Error("Missing immutable object version");
      }
      const saved = await store.read({ key, versionId, byteLength: bytes.length, sha256 });
      if (saved.length !== bytes.length || mediaSha256(saved) !== sha256) throw Error("Stored bytes do not match");
    } catch { recordFailure("object_verification_failed"); break; }

    const outcome = withTransaction(db, () => {
      const current = selectInline.get(id);
      if (!current || current.restaurant_id !== row.restaurant_id || current.mime_type !== row.mime_type ||
          current.byte_length !== row.byte_length || current.width !== row.width || current.height !== row.height ||
          current.created_at !== row.created_at || mediaSha256(current.data) !== sha256) return "changed";
      const stamp = now().toISOString();
      if (!reservation.get(key, store.backendId, stamp)) return "expired";
      clearInline.run(id);
      bindObject.run(id, row.restaurant_id, store.backendId, key, versionId, sha256, bytes.length, stamp);
      clearReservation.run(key, store.backendId);
      return "relocated";
    });
    if (outcome === "relocated") { relocated++; relocatedBytes += bytes.length; }
    else if (outcome === "changed") alreadyChanged++;
    else { recordFailure("cleanup_reservation_expired"); break; }
  }

  return { relocated, relocatedBytes, alreadyChanged, failures, ...mediaRelocationPlan(db) };
}

async function main() {
  const [mode, dbFlag, source, limitFlag, rawLimit, ...extra] = process.argv.slice(2);
  if (!["--plan", "--apply"].includes(mode) || dbFlag !== "--db" || !source?.endsWith(".sqlite") || extra.length ||
      (limitFlag !== undefined && (mode !== "--apply" || limitFlag !== "--limit" || !/^[1-9]\d{0,2}$/.test(rawLimit ?? "") || +rawLimit > 100))) {
    throw Error("Usage: node scripts/migrate-media-to-objects.js --plan|--apply --db <cal-eats.sqlite> [--limit 1..100]");
  }
  const database = fs.realpathSync(source);
  if (!fs.statSync(database).isFile()) throw Error("An existing Cal-Eats database file is required");
  const preflight = new DatabaseSync(database, { readOnly: true });
  let report;
  try { report = mediaRelocationPlan(preflight); }
  finally { preflight.close(); }
  if (mode === "--apply" && !report.invalidImages) {
    const store = loadMediaObjectStore();
    if (!store) throw Error("Configure the dedicated image storage before applying the migration");
    const db = openDatabase(database);
    try { report = await relocateInlineMedia(db, store, { limit: rawLimit ? +rawLimit : DEFAULT_BATCH_SIZE }); }
    finally { db.close(); }
  }
  console.log(JSON.stringify(report));
  if (report.invalidImages || Object.keys(report.failures ?? {}).length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("Image relocation could not finish. Check the Cal-Eats database, storage configuration and batch arguments.");
    process.exitCode = 1;
  });
}
