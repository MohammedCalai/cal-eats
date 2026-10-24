import { HttpError } from "./http.js";
export function restaurantReadiness(db, restaurantId) {
  const r = db.prepare("SELECT * FROM restaurants WHERE id=?").get(restaurantId); if (!r) throw new HttpError(404, "NOT_FOUND", "Resource not found");
  const checks = { contact: Boolean(r.phone?.trim()), address: Boolean(r.address?.trim()), hours: Boolean(r.always_open || JSON.parse(r.opening_hours ?? "[]").length), usableMenu: Boolean(db.prepare("SELECT 1 FROM menu_items WHERE restaurant_id=? AND available=1 LIMIT 1").get(r.id)), fulfillment: Boolean(r.collection_enabled || (r.delivery_enabled && JSON.parse(r.delivery_outcodes).length)) };
  return { ready: Object.values(checks).every(Boolean), checks };
}
