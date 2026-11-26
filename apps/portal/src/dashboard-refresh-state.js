export const ACTIVE_DASHBOARD_ORDER_LIMIT = 12;

export function restaurantDashboardPath(restaurantId, period, page, principalKind) {
  const query = new URLSearchParams({ period, page: String(page), pageSize: "20" });
  // The registered Windows companion uses a fixed query allowlist. The server
  // already denies financial data to a tablet, even without view=operations.
  if (principalKind !== "terminal") query.set("view", "operations");
  return `/api/restaurant/restaurants/${encodeURIComponent(restaurantId)}/dashboard?${query}`;
}

export function activeDashboardOrdersPath(restaurantId) {
  const query = new URLSearchParams({ status: "active", page: "1", pageSize: String(ACTIVE_DASHBOARD_ORDER_LIMIT) });
  return `/api/restaurant/restaurants/${encodeURIComponent(restaurantId)}/orders?${query}`;
}

// Background refreshes keep the current screen and error safety gates stable.
// A changed scope must clear old data immediately to avoid showing another
// restaurant or reporting period while the new request is pending.
export function beginDashboardRefresh(previous, key) {
  return previous.key === key ? previous : { key, data: null, error: "", loading: true };
}

export function beginActiveOrderRefresh(previous, restaurantId) {
  return previous.restaurantId === restaurantId ? previous : { restaurantId, items: [], total: 0, error: "", loading: true };
}
