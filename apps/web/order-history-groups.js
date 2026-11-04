// Group by when the order was placed; later refunds and updates do not move it.
export function orderHistoryGroups(orders = []) {
  const formatter = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "Europe/London" });
  const keys = new Intl.DateTimeFormat("en-GB", { month: "2-digit", year: "numeric", timeZone: "Europe/London" });
  const groups = new Map();
  for (const order of [...orders].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || a.id.localeCompare(b.id))) {
    const date = new Date(order.createdAt), valid = Boolean(order.createdAt) && Number.isFinite(date.getTime());
    const parts = valid ? Object.fromEntries(keys.formatToParts(date).map(part => [part.type, part.value])) : null;
    const key = parts ? `${parts.year}-${parts.month}` : "unknown";
    if (!groups.has(key)) groups.set(key, { key, label: valid ? formatter.format(date) : "Date unavailable", orders: [] });
    groups.get(key).orders.push(order);
  }
  return [...groups.values()];
}
