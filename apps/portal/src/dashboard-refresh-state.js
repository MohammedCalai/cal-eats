// Background refreshes keep the current screen and error safety gates stable.
// A changed scope must clear old data immediately to avoid showing another
// restaurant or reporting period while the new request is pending.
export function beginDashboardRefresh(previous, key) {
  return previous.key === key ? previous : { key, data: null, error: "", loading: true };
}

export function beginActiveOrderRefresh(previous, restaurantId) {
  return previous.restaurantId === restaurantId ? previous : { restaurantId, items: [], total: 0, error: "", loading: true };
}
