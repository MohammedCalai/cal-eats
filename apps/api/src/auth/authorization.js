import { hasAdminRestaurantScope } from "./admin-restaurant-scope.js";

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
  if (hasAdminRestaurantScope(session, restaurantId)) {
    if (!db.prepare("SELECT 1 FROM restaurants WHERE id=?").get(restaurantId)) throw Object.assign(new Error("Resource not found"), { status: 404, code: "NOT_FOUND" });
    return session.user;
  }
  const user = requireRole(session, "restaurant");
  const member = db.prepare("SELECT 1 FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?").get(restaurantId, user.id);
  if (!member) throw Object.assign(new Error("Resource not found"), { status: 404, code: "NOT_FOUND" });
  return user;
}

export function requireRestaurantOwner(db, session, restaurantId) {
  if (session?.principalKind === "terminal") throw Object.assign(new Error("Sign in as the business owner to use this feature."), { status: 403, code: "OWNER_REQUIRED" });
  if (hasAdminRestaurantScope(session, restaurantId)) return requireRestaurantMembership(db, session, restaurantId);
  const user = requireRole(session, "restaurant");
  const membership = db.prepare("SELECT permission FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?").get(restaurantId, user.id);
  if (!membership) throw Object.assign(new Error("Resource not found"), { status: 404, code: "NOT_FOUND" });
  if (membership.permission !== "owner") throw Object.assign(new Error("Owner permission required"), { status: 403, code: "OWNER_REQUIRED" });
  return user;
}

const restaurantCapabilityColumns = Object.freeze({
  viewFinance: "can_view_finance", viewDevices: "can_view_devices",
  manageMenu: "can_manage_menu", manageMarketing: "can_manage_marketing",
  manageCustomers: "can_manage_customers", manageSettings: "can_manage_settings",
  manageStaff: "can_manage_staff"
});

export function restaurantCapabilities(db, session, restaurantId) {
  const result = { viewOrders: false, manageTerminal: false, ...Object.fromEntries(Object.keys(restaurantCapabilityColumns).map(key => [key, false])) };
  if (!session?.user?.id || session.principalKind === "terminal") return result;
  const user = db.prepare("SELECT role,account_enabled,principal_kind FROM users WHERE id=?").get(session.user.id);
  if (!user?.account_enabled || user.principal_kind !== "human") return result;
  if (hasAdminRestaurantScope(session, restaurantId) && user.role === "admin") return Object.fromEntries(Object.keys(result).map(key => [key, true]));
  if (user.role !== "restaurant") return result;
  const membership = db.prepare("SELECT * FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?").get(restaurantId, session.user.id);
  if (!membership) return result;
  result.viewOrders = true;
  result.manageTerminal = membership.permission === "owner";
  for (const [capability, column] of Object.entries(restaurantCapabilityColumns)) result[capability] = membership.permission === "owner" || membership[column] === 1;
  return result;
}

export function requireRestaurantCapability(db, session, restaurantId, capability) {
  if (!Object.hasOwn(restaurantCapabilityColumns, capability)) throw new TypeError("Unknown restaurant capability");
  const user = requireRestaurantMembership(db, session, restaurantId);
  if (!restaurantCapabilities(db, session, restaurantId)[capability]) throw Object.assign(new Error("This restaurant permission is required."), { status: 403, code: "RESTAURANT_CAPABILITY_REQUIRED" });
  return user;
}
