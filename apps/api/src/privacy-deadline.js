const DAY_MS = 86_400_000;

// The owner's 30-day operational target never extends the calendar-month cap.
// Clamp month ends in UTC and preserve the original received time on upgrades.
export function customerErasureDueAt(requestedAt) {
  const received = new Date(requestedAt);
  if (!Number.isFinite(received.getTime())) throw new TypeError("A valid original request time is required");
  const calendar = new Date(received), day = calendar.getUTCDate();
  calendar.setUTCDate(1);
  calendar.setUTCMonth(calendar.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(calendar.getUTCFullYear(), calendar.getUTCMonth() + 1, 0)).getUTCDate();
  calendar.setUTCDate(Math.min(day, lastDay));
  return new Date(Math.min(received.getTime() + 30 * DAY_MS, calendar.getTime())).toISOString();
}
