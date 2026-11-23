export function businessAccountMembership(db, userId, businessId) {
  const member = db.prepare("SELECT * FROM business_account_memberships WHERE business_id=? AND user_id=?").get(businessId, userId);
  const eats = db.prepare("SELECT restaurant_id FROM business_product_links WHERE business_id=? AND product='cal-eats'").get(businessId);
  const source = eats && db.prepare("SELECT permission FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?").get(eats.restaurant_id, userId);
  if (member?.membership_source === "cal-eats") return source ? { ...member, permission: source.permission } : null;
  if (member) return member;
  return source ? { permission: source.permission, membership_source: "cal-eats", can_view_calai: 0, productOnly: true } : null;
}
