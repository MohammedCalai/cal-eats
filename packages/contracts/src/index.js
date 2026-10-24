export const ROLES = Object.freeze(["customer", "restaurant", "admin"]);
export const RESTAURANT_STATUSES = Object.freeze(["pending", "approved", "rejected"]);
export const ORDER_STATUSES = Object.freeze(["placed", "accepted", "preparing", "ready", "out_for_delivery", "completed", "rejected"]);
export const CURRENCY = "GBP";
export const COMMISSION_BASIS_POINTS = 700;
export const VALIDATION = Object.freeze({
  nameMin: 1,
  nameMax: 100,
  emailMax: 254,
  passwordMin: 12,
  passwordMax: 200,
  requestBodyMaxBytes: 16 * 1024,
  sessionHours: 24,
  restaurantNameMax: 100,
  menuNameMax: 120,
  descriptionMax: 500,
  priceMaxMinor: 10_000_000,
  quantityMax: 50,
  orderItemsMax: 50,
  idempotencyKeyMax: 128,
  addressLineMax: 120,
  cityMax: 100,
  deliveryOutcodesMax: 50
});

export function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

export function calculateCommission(subtotalMinor) {
  return calculateCommissionAtRate(subtotalMinor, COMMISSION_BASIS_POINTS);
}

export function calculateCommissionAtRate(subtotalMinor, rateBasisPoints) {
  if (!Number.isSafeInteger(subtotalMinor) || subtotalMinor < 0) throw new TypeError("Invalid subtotal");
  if (!Number.isSafeInteger(rateBasisPoints) || rateBasisPoints < 0 || rateBasisPoints > 10000) throw new TypeError("Invalid commission rate");
  return Number((BigInt(subtotalMinor) * BigInt(rateBasisPoints) + 5000n) / 10000n);
}
