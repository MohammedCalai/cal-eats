export const RESTAURANT_PAGE_SIZE = 25;
const STATUSES = new Set(["all", "approved", "pending", "rejected", "suspended"]);

export function restaurantDirectoryState(params = new URLSearchParams()) {
  const rawPage = params.get("page") || "1";
  return {
    search: String(params.get("q") || "").slice(0, 100),
    status: STATUSES.has(params.get("status")) ? params.get("status") : "all",
    page: /^[1-9]\d*$/.test(rawPage) && Number.isSafeInteger(Number(rawPage)) && Number(rawPage) <= 100000 ? Number(rawPage) : 1,
  };
}

export function restaurantDirectoryQuery({ search = "", status = "all", page = 1 } = {}) {
  const checked = restaurantDirectoryState(new URLSearchParams({ q: search, status, page: String(page) }));
  return new URLSearchParams({ q: checked.search.trim(), status: checked.status, page: String(checked.page), pageSize: String(RESTAURANT_PAGE_SIZE) }).toString();
}

export function restaurantDirectoryParams(current, changes) {
  const next = new URLSearchParams(current);
  for (const [key, value] of Object.entries(changes)) {
    if (value === "" || key === "status" && value === "all" || key === "page" && Number(value) === 1) next.delete(key);
    else next.set(key, String(value));
  }
  return next;
}

// Keep numbered navigation small even when the directory has thousands of pages.
export function restaurantResultPages(page, totalPages) {
  if (!Number.isSafeInteger(totalPages) || totalPages < 1) return [];
  const current = Math.max(1, Math.min(totalPages, Number.isSafeInteger(page) ? page : 1));
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
  const selected = new Set([1, totalPages]);
  const from = current <= 3 ? 2 : current >= totalPages - 2 ? totalPages - 3 : current - 1;
  const to = current <= 3 ? 4 : current >= totalPages - 2 ? totalPages - 1 : current + 1;
  for (let number = from; number <= to; number++) selected.add(number);
  const result = [];
  for (const number of [...selected].sort((a, b) => a - b)) {
    if (result.length && number - result.at(-1) > 1) result.push("gap");
    result.push(number);
  }
  return result;
}

export function restaurantDirectoryStatus(restaurant) {
  if (restaurant.archivedAt) return { label: "Archived", tone: "muted" };
  if (restaurant.suspended) return { label: "Suspended", tone: "attention" };
  if (restaurant.status === "pending") return { label: "Pending application", tone: "pending" };
  if (restaurant.status === "rejected") return { label: "Not approved", tone: "muted" };
  if (restaurant.status === "approved") return { label: "Approved", tone: "approved" };
  return { label: "Status unavailable", tone: "muted" };
}
