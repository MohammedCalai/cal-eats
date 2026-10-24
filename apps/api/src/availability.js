const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function londonParts(date) {
  const parts = Object.fromEntries(formatter.formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { day: weekdays[parts.weekday], date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
const clockMinutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));

export function restaurantAvailability(row, now = new Date()) {
  if (row.suspended) return { acceptingOrders: false, closedReason: "Restaurant is suspended" };
  if (row.paused) return { acceptingOrders: false, closedReason: "Restaurant has paused new orders" };
  const local = londonParts(now);
  if (JSON.parse(row.holiday_dates ?? "[]").includes(local.date)) return { acceptingOrders: false, closedReason: "Restaurant is closed for a holiday" };
  if (row.always_open) return { acceptingOrders: true, closedReason: null };
  const hours = JSON.parse(row.opening_hours ?? "[]");
  const open = hours.some((entry) => {
    const start = clockMinutes(entry.open); const end = clockMinutes(entry.close);
    if (end > start) return entry.day === local.day && local.minutes >= start && local.minutes < end;
    const nextDay = (entry.day + 1) % 7;
    return (entry.day === local.day && local.minutes >= start) || (nextDay === local.day && local.minutes < end);
  });
  return open ? { acceptingOrders: true, closedReason: null } : { acceptingOrders: false, closedReason: "Restaurant is currently closed" };
}
