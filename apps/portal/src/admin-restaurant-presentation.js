export function adminRestaurantAvailabilityLabel(restaurant) {
  if (restaurant.archivedAt) return "Archived";
  if (restaurant.suspended) return "Suspended";
  if (restaurant.status === "pending") return "Pending approval";
  if (restaurant.status === "rejected") return "Not approved";
  if (restaurant.status !== "approved") return "Unavailable";
  if (restaurant.profile?.paused) return "Paused";
  return restaurant.acceptingOrders ? "Open now" : "Closed now";
}
