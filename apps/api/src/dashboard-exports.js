import { randomUUID } from "node:crypto";
import { requireRestaurantOwner, requireRole } from "./auth/authorization.js";
import { dashboardRange } from "./business-dashboard.js";
import { HttpError } from "./http.js";
import { buildFinanceSummary, parseLondonDateRange } from "./marketplace-reporting.js";
import { PAYABLE_ORDER_SQL } from "./order-confirmation.js";

const MAX_ROWS = 50000;
const MAX_BYTES = 10 * 1024 * 1024;
const confirmed = "o.status IN ('accepted','preparing','ready','out_for_delivery','completed') AND (o.payment_method<>'card' OR o.payment_status IN ('stripe_captured','stripe_partially_refunded','stripe_refunded'))";
const csvCell = value => {
  let text = String(value ?? "");
  if (!(typeof value === "number" && Number.isFinite(value)) && /^\s*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};
function csv(headers, rows) {
  if (rows.length > MAX_ROWS) throw new HttpError(413, "EXPORT_TOO_LARGE", "Choose a shorter date range for this export.");
  const body = "\uFEFF" + [headers, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  if (Buffer.byteLength(body) > MAX_BYTES) throw new HttpError(413, "EXPORT_TOO_LARGE", "Choose a shorter date range for this export.");
  return body;
}
function orderScope(restaurantId, range) {
  const clauses = [], values = [];
  if (restaurantId) { clauses.push("o.restaurant_id=?"); values.push(restaurantId); }
  if (range.from) { clauses.push("o.created_at>=?"); values.push(range.from); }
  if (range.toExclusive) { clauses.push("o.created_at<?"); values.push(range.toExclusive); }
  return { sql: clauses.length ? clauses.join(" AND ") : "1=1", values };
}
function periodMetrics(db, restaurantId, range) {
  const scope = orderScope(restaurantId, range);
  return db.prepare(`SELECT COUNT(*) AS ordersPlaced,
    COALESCE(SUM(CASE WHEN ${confirmed} THEN 1 ELSE 0 END),0) AS confirmedOrders,
    COALESCE(SUM(CASE WHEN o.status='completed' THEN 1 ELSE 0 END),0) AS completedOrders,
    COALESCE(SUM(CASE WHEN o.status IN ('rejected','cancelled','expired') THEN 1 ELSE 0 END),0) AS cancelledOrders,
    COALESCE(SUM(CASE WHEN o.fulfillment='delivery' THEN 1 ELSE 0 END),0) AS deliveryOrders,
    COALESCE(SUM(CASE WHEN o.fulfillment='collection' THEN 1 ELSE 0 END),0) AS collectionOrders
    FROM orders o WHERE ${scope.sql}`).get(...scope.values);
}
function liveMetrics(db, restaurantId, stamp) {
  const scope = orderScope(restaurantId, {});
  return db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN o.status='placed' AND o.confirmed_at IS NULL AND o.merchant_visible_at IS NOT NULL AND ${PAYABLE_ORDER_SQL} THEN 1 ELSE 0 END),0) AS pendingConfirmation,
    COALESCE(SUM(CASE WHEN o.status='placed' AND o.confirmed_at IS NULL AND o.merchant_visible_at IS NOT NULL AND ${PAYABLE_ORDER_SQL} AND o.confirmation_due_at<=? THEN 1 ELSE 0 END),0) AS overdueConfirmation,
    COALESCE(SUM(CASE WHEN o.status IN ('accepted','preparing') THEN 1 ELSE 0 END),0) AS confirmedInKitchen,
    COALESCE(SUM(CASE WHEN o.status='ready' THEN 1 ELSE 0 END),0) AS readyForHandover,
    COALESCE(SUM(CASE WHEN o.status IN ('accepted','preparing','ready','out_for_delivery') OR (o.status='placed' AND o.merchant_visible_at IS NOT NULL AND ${PAYABLE_ORDER_SQL}) THEN 1 ELSE 0 END),0) AS activeOrders
    FROM orders o WHERE ${scope.sql}`).get(stamp, ...scope.values);
}
function ordersExport(db, restaurantId, range, admin) {
  const scope = orderScope(restaurantId, range);
  const orders = db.prepare(`SELECT o.id,o.restaurant_id,o.restaurant_name,o.status,o.fulfillment,o.created_at,o.updated_at,o.confirmed_at,o.estimated_ready_at AS customer_eta_at,o.merchant_visible_at,
    o.total_minor,o.subtotal_minor,o.delivery_fee_minor,o.currency,o.payment_method,o.payment_status,o.commission_minor,
    COALESCE((SELECT SUM(food_amount_minor+delivery_amount_minor) FROM refunds WHERE order_id=o.id),0) AS refunded_minor,
    COALESCE((SELECT provider_mode FROM stripe_order_payments WHERE order_id=o.id),CASE WHEN o.payment_method='card' THEN 'unrecorded_card' ELSE 'local_simulator' END) AS provider_mode
    FROM orders o WHERE ${scope.sql} ORDER BY o.created_at,o.id LIMIT ?`).all(...scope.values, MAX_ROWS + 1);
  const headers = ["orderId", "restaurantId", "restaurantName", "status", "fulfillment", "createdAtUtc", "updatedAtUtc", "confirmedAtUtc", "customerEtaAtUtc", "restaurantReceivedAtUtc"];
  if (admin) headers.push("foodSubtotalMinor", "deliveryFeeMinor", "totalMinor", "recordedCommissionMinor", "refundsMinor", "currency", "paymentMethod", "paymentStatus", "providerMode");
  const rows = orders.map(order => {
    const row = [order.id, order.restaurant_id, order.restaurant_name, order.status, order.fulfillment, order.created_at, order.updated_at, order.confirmed_at, order.customer_eta_at, order.merchant_visible_at];
    if (admin) row.push(order.subtotal_minor, order.delivery_fee_minor, order.total_minor, order.commission_minor, order.refunded_minor, order.currency, order.payment_method, order.payment_status, order.provider_mode);
    return row;
  });
  return { headers, rows };
}
function ownerMetrics(db, restaurant, user, range, stamp) {
  const rows = [], prefix = (metric, value, basis, item = "") => rows.push([metric, value, "count", basis, restaurant.id, restaurant.name, item, range.fromDate, range.toDate, "Europe/London", stamp]);
  for (const [key, value] of Object.entries(periodMetrics(db, restaurant.id, range))) prefix(key, value, "order_created_in_selected_period");
  for (const [key, value] of Object.entries(liveMetrics(db, restaurant.id, stamp))) prefix(key, value, "current_all_dates");
  const openCases = db.prepare("SELECT COUNT(*) n FROM refund_cases WHERE restaurant_id=? AND resolved_at IS NULL AND status NOT IN ('refunded','rejected')").get(restaurant.id).n;
  prefix("openRefundCases", openCases, "current_all_dates");
  const orderUnread = db.prepare(`SELECT COUNT(*) n FROM order_messages m JOIN orders o ON o.id=m.order_id LEFT JOIN order_message_reads r ON r.order_id=m.order_id AND r.user_id=? WHERE o.restaurant_id=? AND m.sender_role='customer' AND m.expires_at>? AND (r.order_id IS NULL OR m.created_at>r.last_read_created_at OR (m.created_at=r.last_read_created_at AND m.id>r.last_read_message_id))`).get(user.id, restaurant.id, stamp).n;
  const customerUnread = db.prepare(`SELECT COUNT(*) n FROM restaurant_customer_messages m JOIN restaurant_customer_threads t ON t.id=m.thread_id LEFT JOIN restaurant_customer_message_reads r ON r.thread_id=m.thread_id AND r.user_id=? WHERE t.restaurant_id=? AND m.sender_role='customer' AND m.expires_at>? AND m.ingest_sequence>COALESCE(r.last_read_sequence,0)`).get(user.id, restaurant.id, stamp).n;
  prefix("unreadMessages", orderUnread + customerUnread, "current_for_exporting_owner");
  const scope = orderScope(restaurant.id, range);
  const items = db.prepare(`SELECT i.name,SUM(i.quantity) quantity FROM order_items i JOIN orders o ON o.id=i.order_id WHERE ${scope.sql} AND ${confirmed} GROUP BY i.name ORDER BY quantity DESC,i.name LIMIT 5`).all(...scope.values);
  for (const item of items) prefix("popularItemQuantity", item.quantity, "confirmed_order_created_in_selected_period", item.name);
  return { headers: ["metric", "value", "unit", "basis", "restaurantId", "restaurantName", "itemName", "fromDate", "toDate", "timeZone", "generatedAtUtc"], rows };
}
function adminFinance(db, restaurants, url) {
  return restaurants.map(restaurant => ({ restaurant, finance: buildFinanceSummary(db, restaurant.id, url) }));
}
function adminMetrics(db, restaurants, url, range, stamp) {
  const rows = [], prefix = (metric, value, unit, basis) => rows.push([metric, value, unit, basis, range.fromDate, range.toDate, "Europe/London", stamp]);
  prefix("restaurants", restaurants.length, "count", "current_all_dates");
  for (const [key, value] of Object.entries(periodMetrics(db, null, range))) prefix(key, value, "count", "order_created_in_selected_range");
  for (const [key, value] of Object.entries(liveMetrics(db, null, stamp))) prefix(key, value, "count", "current_all_dates");
  const summaries = adminFinance(db, restaurants, url), sum = key => summaries.reduce((total, row) => total + (row.finance[key] ?? 0), 0);
  for (const key of ["grossSalesMinor", "commissionMinor", "providerCostMinor", "refundsMinor"]) prefix(key, sum(key), "GBP_minor_units", "reconciled_finance_selected_range");
  prefix("estimatedMarginMinor", sum("commissionMinor") - sum("providerCostMinor"), "GBP_minor_units", "reconciled_finance_selected_range");
  prefix("providerCostsPendingCount", sum("providerCostsPendingCount"), "count", "current_all_dates");
  const modes = [...new Set(summaries.flatMap(row => row.finance.providerModes?.length ? row.finance.providerModes : [row.finance.providerMode]))];
  prefix("providerModes", modes.join("; "), "provider_mode", "current_all_dates");
  return { headers: ["metric", "value", "unit", "basis", "fromDate", "toDate", "timeZone", "generatedAtUtc"], rows };
}
function restaurantsExport(db, restaurants, url, range, stamp) {
  const headers = ["restaurantId", "restaurantName", "approvalStatus", "suspended", "ordersPlaced", "confirmedOrders", "completedOrders", "cancelledOrders", "deliveryOrders", "collectionOrders", "grossSalesMinor", "commissionMinor", "providerCostMinor", "refundsMinor", "providerMode", "currency", "fromDate", "toDate", "timeZone", "generatedAtUtc"];
  const rows = adminFinance(db, restaurants, url).map(({ restaurant, finance }) => {
    const stats = periodMetrics(db, restaurant.id, range);
    return [restaurant.id, restaurant.name, restaurant.status, Boolean(restaurant.suspended), stats.ordersPlaced, stats.confirmedOrders, stats.completedOrders, stats.cancelledOrders, stats.deliveryOrders, stats.collectionOrders, finance.grossSalesMinor, finance.commissionMinor, finance.providerCostMinor, finance.refundsMinor, finance.providerMode, "GBP", range.fromDate, range.toDate, "Europe/London", stamp];
  });
  return { headers, rows };
}

export async function routeDashboardExports({ req, res, url, db, config, session }) {
  const ownerMatch = url.pathname.match(/^\/api\/restaurant\/restaurants\/([^/]+)\/dashboard\/(metrics|orders)\.csv$/);
  const adminMatch = url.pathname.match(/^\/api\/admin\/dashboard\/(metrics|orders|restaurants)\.csv$/);
  if (req.method !== "GET" || (!ownerMatch && !adminMatch)) return false;
  const now = config.now(), stamp = now.toISOString();
  let user, range, report, kind, restaurantId = null;
  if (ownerMatch) {
    restaurantId = ownerMatch[1]; kind = ownerMatch[2];
    user = requireRestaurantOwner(db, session, restaurantId);
    range = dashboardRange(url.searchParams.get("period") ?? "today", now);
    const restaurant = db.prepare("SELECT id,name FROM restaurants WHERE id=?").get(restaurantId);
    report = kind === "orders" ? ordersExport(db, restaurantId, range, false) : ownerMetrics(db, restaurant, user, range, stamp);
  } else {
    user = requireRole(session, "admin"); kind = adminMatch[1];
    range = { ...parseLondonDateRange(url), fromDate: url.searchParams.get("from") || "", toDate: url.searchParams.get("to") || "" };
    const restaurants = db.prepare("SELECT id,name,status,suspended FROM restaurants ORDER BY name,id LIMIT ?").all(MAX_ROWS + 1);
    if (restaurants.length > MAX_ROWS) throw new HttpError(413, "EXPORT_TOO_LARGE", "The marketplace export is too large. Contact support for a managed export.");
    report = kind === "orders" ? ordersExport(db, null, range, true) : kind === "restaurants" ? restaurantsExport(db, restaurants, url, range, stamp) : adminMetrics(db, restaurants, url, range, stamp);
  }
  const body = csv(report.headers, report.rows);
  db.prepare("INSERT INTO audit_events(id,actor_user_id,entity_type,entity_id,action,details,created_at) VALUES(?,?,?,?,?,?,?)").run(randomUUID(), user.id, "dashboard_export", restaurantId || "platform", "dashboard_csv_exported", JSON.stringify({ kind, restaurantId, fromDate: range.fromDate, toDate: range.toDate, rowCount: report.rows.length }), stamp);
  const filename = `Cal-Eats-${restaurantId ? "business" : "platform"}-${kind}-${range.fromDate || "all"}-${range.toDate || "dates"}.csv`;
  res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"`, "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(body);
  return true;
}
