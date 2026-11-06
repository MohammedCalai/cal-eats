const LIVE_DELIVERY_STATES = new Set(["placed", "accepted", "preparing", "ready"]);
const FIFTEEN_MINUTES = 15 * 60000;

function instant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = new Date(`${value.slice(0,10)}T00:00:00.000Z`), stamp = Date.parse(value);
  return Number.isFinite(+date) && date.toISOString().slice(0,10) === value.slice(0,10) && Number.isFinite(stamp) ? stamp : null;
}

export function deliveryDeadlineAt(order) {
  if (order?.fulfillment !== "delivery" || !LIVE_DELIVERY_STATES.has(order.status)) return null;
  const confirmed = instant(order.confirmedAt) !== null || ["accepted", "preparing", "ready"].includes(order.status);
  return instant(order.customerEtaAt) ?? (confirmed ? instant(order.estimatedReadyAt) : null) ?? instant(order.scheduledFor);
}

export function deliveryDispatchWarning(order, now = Date.now()) {
  const due = deliveryDeadlineAt(order), current = now instanceof Date ? +now : now;
  if (due === null || typeof current !== "number" || !Number.isFinite(current)) return null;
  const remaining = due - current;
  if (remaining > FIFTEEN_MINUTES) return null;
  const overdue = remaining < 0, minutes = overdue ? Math.floor(-remaining / 60000) : Math.ceil(remaining / 60000);
  const label = overdue ? minutes ? `Delivery overdue by ${minutes} min` : "Delivery overdue" : remaining === 0 ? "Delivery due now" : `Delivery due in ${minutes} min`;
  return { dueAt: new Date(due).toISOString(), overdue, minutes, label };
}
