export function requireUser(session) {
  if (!session) throw Object.assign(new Error("Authentication required"), { status: 401, code: "AUTH_REQUIRED" });
  return session.user;
}

export function requireRole(session, ...roles) {
  const user = requireUser(session);
  if (!roles.includes(user.role)) throw Object.assign(new Error("Forbidden"), { status: 403, code: "FORBIDDEN" });
  return user;
}

export function requireRestaurantMembership(db, session, restaurantId) {
  const user = requireRole(session, "restaurant");
  const member = db.prepare("SELECT 1 FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?").get(restaurantId, user.id);
  if (!member) throw Object.assign(new Error("Resource not found"), { status: 404, code: "NOT_FOUND" });
  return user;
}

export function requireRestaurantOwner(db, session, restaurantId) {
  const user = requireRole(session, "restaurant");
  const membership = db.prepare("SELECT permission FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?").get(restaurantId, user.id);
  if (!membership) throw Object.assign(new Error("Resource not found"), { status: 404, code: "NOT_FOUND" });
  if (membership.permission !== "owner") throw Object.assign(new Error("Owner permission required"), { status: 403, code: "OWNER_REQUIRED" });
  return user;
}
