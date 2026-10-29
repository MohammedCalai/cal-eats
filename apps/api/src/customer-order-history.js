import { HttpError } from "./http.js";

export const CUSTOMER_ORDER_HISTORY_DAYS = 90;
export const CUSTOMER_ACTIVE_ORDER_STATUSES = ["placed", "accepted", "preparing", "ready", "out_for_delivery"];
export const customerOrderHistoryCutoff = now => new Date(now.getTime() - CUSTOMER_ORDER_HISTORY_DAYS * 86400000).toISOString();
export const customerOrderHistorySql = alias => `(${alias}.status IN ('placed','accepted','preparing','ready','out_for_delivery') OR ${alias}.created_at>?)`;
export function customerOrderIsVisible(order, now = new Date()) {
  return Boolean(order && (CUSTOMER_ACTIVE_ORDER_STATUSES.includes(order.status) || Date.parse(order.created_at) > now.getTime() - CUSTOMER_ORDER_HISTORY_DAYS * 86400000));
}
export function assertCustomerOrderVisible(order, user, now) {
  if (user?.role === "customer" && order?.customer_id === user.id && !customerOrderIsVisible(order, now)) throw new HttpError(404, "NOT_FOUND", "Order is outside your 90-day history");
}

// Run before route handlers so a saved detail, receipt, message, payment or case URL
// cannot bypass the customer history window. Business/admin records are retained.
export function enforceCustomerOrderHistory({ url, db, config, session }) {
  const user = session?.user;
  if (user?.role !== "customer") return;
  const orderMatch = url.pathname.match(/^\/api\/(?:native\/)?orders\/([^/]+)(?:\/|$)/);
  const caseMatch = url.pathname.match(/^\/api\/refund-cases\/([^/]+)(?:\/|$)/);
  let order;
  if (orderMatch) order = db.prepare("SELECT id,customer_id,status,created_at FROM orders WHERE id=?").get(orderMatch[1]);
  else if (caseMatch) order = db.prepare("SELECT o.id,o.customer_id,o.status,o.created_at FROM refund_cases c JOIN orders o ON o.id=c.order_id WHERE c.id=? AND c.customer_id=?").get(caseMatch[1], user.id);
  assertCustomerOrderVisible(order, user, config.now());
}
