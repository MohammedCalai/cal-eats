import { HttpError, sendJson } from "./http.js";
import { restaurantAvailability } from "./availability.js";
import { defaultCustomerEtaMinutes } from "./order-confirmation.js";

export const SCHEDULE_MAX_DAYS = 7;

// Normalize identity separately from clock validation so an accepted request can
// still be replayed after its original slot or restaurant availability changes.
export function normalizeScheduledFor(value) {
  if (value === undefined || value === null) return null;
  const shape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
  const stamp = typeof value === "string" && shape.test(value) ? Date.parse(value) : NaN;
  const calendar = typeof value === "string" ? new Date(`${value.slice(0, 10)}T00:00:00.000Z`) : null;
  if (!Number.isFinite(stamp) || !calendar || !Number.isFinite(+calendar) || calendar.toISOString().slice(0, 10) !== value.slice(0, 10)) throw new HttpError(400, "VALIDATION_ERROR", "Scheduled time must be a valid ISO date and time with a timezone");
  return new Date(stamp).toISOString();
}

export function validateOrderSchedule(restaurant, fulfillment, scheduledFor, now) {
  const minimumLeadMinutes = Math.max(30, defaultCustomerEtaMinutes({ fulfillment }, restaurant));
  if (fulfillment === "collection" && !restaurant.collection_enabled) throw new HttpError(409, "COLLECTION_DISABLED", "Restaurant collection is disabled");
  if (fulfillment === "delivery" && !restaurant.delivery_enabled) throw new HttpError(409, "DELIVERY_DISABLED", "Restaurant delivery is disabled");
  if (scheduledFor) {
    const target = Date.parse(scheduledFor);
    if (target < +now + minimumLeadMinutes * 60000) throw new HttpError(400, "SCHEDULE_TOO_SOON", `Choose a time at least ${minimumLeadMinutes} minutes from now`);
    if (target > +now + SCHEDULE_MAX_DAYS * 86400000) throw new HttpError(400, "SCHEDULE_TOO_FAR", "Scheduled orders can be placed up to 7 days ahead");
  }
  const availability = restaurantAvailability(restaurant, scheduledFor ? new Date(scheduledFor) : now);
  if (!availability.acceptingOrders) throw new HttpError(409, scheduledFor ? "SCHEDULE_UNAVAILABLE" : "RESTAURANT_CLOSED", scheduledFor ? `The restaurant is unavailable at the selected time. ${availability.closedReason}` : availability.closedReason);
  return { scheduledFor, scheduleMinimumLeadMinutes: minimumLeadMinutes, scheduleMaxDays: SCHEDULE_MAX_DAYS };
}

export async function routeScheduledOrders({ req, res, url, db, config }) {
  const match = url.pathname.match(/^\/api\/restaurants\/([^/]+)\/schedule-slots$/);
  if (req.method !== "GET" || !match) return false;
  const fulfillment = url.searchParams.get("fulfillment");
  if (!["delivery", "collection"].includes(fulfillment)) throw new HttpError(400, "VALIDATION_ERROR", "Choose delivery or collection");
  const restaurant = db.prepare("SELECT * FROM restaurants WHERE id=? AND status='approved'").get(match[1]);
  if (!restaurant) throw new HttpError(404, "NOT_FOUND", "Resource not found");
  const now = config.now(), minimumLeadMinutes = Math.max(30, defaultCustomerEtaMinutes({ fulfillment }, restaurant)), items = [];
  const dateFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });
  const dayFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short" });
  const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const enabled = fulfillment === "delivery" ? restaurant.delivery_enabled : restaurant.collection_enabled;
  if (enabled && !restaurant.paused && !restaurant.suspended) {
    const step = 15 * 60000, first = Math.ceil((+now + minimumLeadMinutes * 60000) / step) * step;
    for (let stamp = first; stamp <= +now + SCHEDULE_MAX_DAYS * 86400000; stamp += step) {
      const target = new Date(stamp);
      if (restaurantAvailability(restaurant, target).acceptingOrders) items.push({ scheduledFor: target.toISOString(), label: timeFormat.format(target), dateKey: dateFormat.format(target), dateLabel: dayFormat.format(target) });
    }
  }
  return sendJson(res, 200, { data: { items, minimumLeadMinutes, maxDays: SCHEDULE_MAX_DAYS } });
}
