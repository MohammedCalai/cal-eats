/** Arrival sequences survive notification deletion and SQLite rowid reuse/VACUUM. */
export function restaurantMessageArrivalRevision(db, restaurantId, userId) {
  return db.prepare(`SELECT COALESCE(MAX(a.sequence),0) AS revision
    FROM business_message_arrivals a JOIN user_notifications n ON n.id=a.notification_id
    JOIN users u ON u.id=n.user_id
    JOIN restaurant_memberships m ON m.restaurant_id=n.restaurant_id AND m.user_id=n.user_id
    WHERE n.user_id=? AND n.restaurant_id=? AND u.role='restaurant'
      AND EXISTS(SELECT 1 FROM restaurants r WHERE r.id=n.restaurant_id AND r.archived_at IS NULL)
      AND (n.type='order_message' OR (m.permission='owner' AND n.type='customer_message'))`).get(userId, restaurantId).revision;
}
