// This capability is created only by the administrator restaurant router.
// A URL, request body or ordinary restaurant session cannot supply it.
const restaurantScope = Symbol("administrator restaurant scope");

export function scopedAdminRestaurantSession(session, restaurantId) {
  if (session?.user?.role !== "admin") throw Object.assign(new Error("Forbidden"), { status: 403, code: "FORBIDDEN" });
  return { ...session, [restaurantScope]: restaurantId };
}

export function hasAdminRestaurantScope(session, restaurantId) {
  return session?.user?.role === "admin" && session[restaurantScope] === restaurantId;
}
