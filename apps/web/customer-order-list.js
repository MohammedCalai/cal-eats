import { money, statusLabel } from "./model.js";

const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const activeStatuses = new Set(["placed", "accepted", "preparing", "ready", "out_for_delivery"]);
const parsedDate = value => { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? date : null; };
const activityDate = order => parsedDate(order.updatedAt) || parsedDate(order.createdAt);
const initials = value => String(value || "Restaurant").trim().split(/[\s-]+/).filter(Boolean).slice(0, 2).map(word => [...word][0]).join("").toUpperCase();
const dayKey = date => date.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
const readableDate = date => date.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });

function orderStatus(order) {
  const payment = String(order.payment?.status || order.paymentStatus || "").replace(/^stripe_/, "");
  if (order.status === "placed" && order.paymentMethod === "card" && !["authorized", "captured", "partially_refunded", "refunded"].includes(payment)) return order.payment?.checkoutAvailable ? "Complete your payment" : ["failed", "declined", "unknown"].includes(payment) ? "Payment needs attention" : "Checking your payment";
  return ({ placed: "Waiting for confirmation", accepted: "Order confirmed", preparing: "Preparing your food", ready: order.fulfillment === "delivery" ? "Ready for dispatch" : "Ready to collect", out_for_delivery: "Out for delivery", completed: order.fulfillment === "delivery" ? "Delivered" : "Collected", rejected: "Order declined", cancelled: "Order cancelled", expired: "Checkout expired" })[order.status] || statusLabel(order.status);
}

function rowHtml(order, { selectedId, now }) {
  const live = activeStatuses.has(order.status), name = order.restaurantName || "Restaurant", reference = order.id.slice(0, 8).toUpperCase(), date = activityDate(order), currentDate = parsedDate(now) || new Date();
  const time = date ? dayKey(date) === dayKey(currentDate) ? date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }) : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" }) : "";
  const unread = Number.isSafeInteger(order.unreadMessageCount) && order.unreadMessageCount > 0 ? order.unreadMessageCount : 0;
  const eta = live && order.status !== "placed" && order.confirmedAt ? parsedDate(order.customerEtaAt || order.estimatedReadyAt) : null;
  const price = Number.isSafeInteger(order.totalMinor) && order.totalMinor >= 0 ? money(order.totalMinor) : "Total unavailable";
  return `<article class="customer-order-list-item${live ? " is-live" : ""}${unread ? " has-unread" : ""}" data-order-id="${escape(order.id)}"><button type="button" class="customer-order-list-row" data-action="open-customer-order" data-id="${escape(order.id)}"${selectedId === order.id ? ' aria-current="true"' : ""} aria-label="Open order ${escape(reference)} from ${escape(name)}, ${escape(orderStatus(order))}${unread ? `, ${unread} unread message${unread === 1 ? "" : "s"}` : ""}"><span class="customer-order-list-avatar" aria-hidden="true">${escape(initials(name))}${live ? '<span class="customer-order-live-energy"></span>' : ""}</span><span class="customer-order-list-copy"><span class="customer-order-list-heading"><strong>${escape(name)}</strong>${date ? `<time datetime="${date.toISOString()}" title="${escape(readableDate(date))}">${escape(time)}</time>` : ""}</span><span class="customer-order-list-status"><span>${live ? '<i aria-hidden="true"></i>' : ""}${escape(orderStatus(order))}</span><b>${escape(price)}</b></span><span class="customer-order-list-meta"><span>${order.fulfillment === "delivery" ? "Delivery" : "Collection"} · #${escape(reference)}${eta ? ` · ${order.fulfillment === "delivery" ? "ETA" : "Collect"} ${eta.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" })}` : ""}${Number.isSafeInteger(order.refundedTotalMinor) && order.refundedTotalMinor > 0 ? ` · ${escape(money(order.refundedTotalMinor))} refunded` : ""}</span>${unread ? `<b class="customer-order-unread" aria-hidden="true">${unread > 99 ? "99+" : unread}</b>` : '<span class="customer-order-list-chevron" aria-hidden="true">›</span>'}</span></span></button></article>`;
}

export function customerOrdersListHtml(orders, { selectedId = null, now = Date.now() } = {}) {
  // Visibility and the 90-day history limit remain enforced by the customer API.
  const rows = [...new Map((Array.isArray(orders) ? orders : []).filter(order => order && typeof order.id === "string" && order.id).map(order => [order.id, order])).values()];
  const newest = (a, b) => (activityDate(b)?.getTime() || 0) - (activityDate(a)?.getTime() || 0) || a.id.localeCompare(b.id);
  const live = rows.filter(order => activeStatuses.has(order.status)).sort(newest), past = rows.filter(order => !activeStatuses.has(order.status)).sort(newest);
  const group = (items, active) => items.length ? `<section class="customer-order-list-group" aria-label="${active ? "Live orders" : "Past orders"}"><header><h2>${active ? "Live orders" : "Past orders"}</h2><span>${items.length} order${items.length === 1 ? "" : "s"}</span></header><div class="customer-order-list-rows">${items.map(order => rowHtml(order, { selectedId, now })).join("")}</div></section>` : "";
  if (!rows.length) return `<div class="customer-orders-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 7h6M9 11h6M9 15h3"/></svg><strong>No orders to show</strong><p>Try another search, or browse restaurants to start a new order.</p><button type="button" class="secondary" data-view="discover">Browse restaurants</button></div>`;
  return `${group(live, true)}${group(past, false)}`;
}
