import { HttpError } from "./http.js";

// Decimal MB: each business owns a separate 100 MB image allowance.
export const RESTAURANT_MEDIA_LIMIT_BYTES = 100_000_000;

export function assertMediaCapacity(usedBytes, incomingBytes, reclaimedBytes = 0) {
  if (usedBytes - reclaimedBytes + incomingBytes > RESTAURANT_MEDIA_LIMIT_BYTES) {
    throw new HttpError(409, "MEDIA_LIMIT", "Restaurant image storage limit of 100 MB reached");
  }
}

export function mediaStorage(db, restaurantId) {
  const usedBytes = db.prepare("SELECT COALESCE(SUM(byte_length),0) total FROM media_assets WHERE restaurant_id=?").get(restaurantId).total;
  return { usedBytes, limitBytes: RESTAURANT_MEDIA_LIMIT_BYTES, remainingBytes: Math.max(0, RESTAURANT_MEDIA_LIMIT_BYTES - usedBytes) };
}

export function mediaIsReferenced(db, id) {
  return Boolean(db.prepare("SELECT 1 FROM restaurants WHERE cover_media_id=? UNION ALL SELECT 1 FROM menu_items WHERE photo_media_id=? LIMIT 1").get(id, id));
}
