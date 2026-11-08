import { HttpError } from "./http.js";

export function restaurantContactBlocked(db, customerId, restaurantId) {
  return Boolean(customerId && restaurantId && db.prepare("SELECT 1 FROM customer_restaurant_safety WHERE customer_id=? AND restaurant_id=? AND blocked=1").get(customerId, restaurantId));
}

export function assertRestaurantContactAllowed(db, customerId, restaurantId) {
  if (restaurantContactBlocked(db, customerId, restaurantId)) throw new HttpError(409, "RESTAURANT_CONTACT_BLOCKED", "Restaurant messages are blocked. The customer can unblock this restaurant in Cal-Eats.");
}

// Only human merchant contact and personalised promotions are suppressed. Order
// status/ETA, payment updates and platform support remain available.
export function blockedRestaurantNotification(db, row) {
  const customer = db.prepare("SELECT role FROM users WHERE id=?").get(row.user_id);
  if (customer?.role !== "customer") return false;
  if (["customer_message", "order_message", "offer"].includes(row.type)) return restaurantContactBlocked(db, row.user_id, row.restaurant_id);
  if (row.type === "support_reply" && row.support_case_id) {
    const messageId = row.event_key?.split(":").at(-1);
    const sender = db.prepare("SELECT m.sender_role,s.restaurant_id FROM support_case_messages m JOIN support_cases s ON s.id=m.case_id WHERE m.id=? AND s.id=? AND s.user_id=?").get(messageId, row.support_case_id, row.user_id);
    return sender?.sender_role === "restaurant" && restaurantContactBlocked(db, row.user_id, sender.restaurant_id);
  }
  return false;
}
