import { money, statusLabel } from "./model.js";
const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);
const paths = {
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  delivery: '<path d="M3 5h11v12H3zM14 10h4l3 4v3h-7"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',
  location: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  work: '<rect x="3" y="6" width="18" height="15" rx="3"/><path d="M8 6V3h8v3M3 12h18M10 12v3h4v-3"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  shield: '<path d="m12 2 8 3v6c0 6-8 11-8 11S4 17 4 11V5zM8 11l3 3 5-6"/>',
  discover: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
  orders: '<rect x="5" y="4" width="14" height="17" rx="2"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M9 10h6M9 14h6M9 18h4"/>',
  offers: '<path d="M3 11V3h8l10 10-8 8z"/><circle cx="7.5" cy="7.5" r="1"/>',
  messages: '<path d="M21 11a8 8 0 0 1-8 8H8l-5 3V9a7 7 0 0 1 7-7h3a8 8 0 0 1 8 9zM7 8h10M7 12h7"/>',
  account: '<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  basket: '<path d="M4 8h16l-1 13H5zM8 8V6a4 4 0 0 1 8 0v2"/>'
};
export function customerIcon(name) { return `<svg class="customer-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${Object.hasOwn(paths,name) ? paths[name] : paths.discover}</svg>`; }
export function customerReceiptHtml(order) {
  const id = String(order.id), items = Array.isArray(order.items) ? order.items : [];
  const rows = items.map(item => `<li><div><strong>${escape(item.quantity)} × ${escape(item.name || item.itemName)}</strong>${item.selectedModifiers?.length ? `<small>${item.selectedModifiers.map(value => escape(value.optionName || value.name)).join(" · ")}</small>` : ""}</div><strong>${item.isOfferItem ? "Free offer" : money(item.lineTotalMinor)}</strong></li>`).join("");
  const date = new Intl.DateTimeFormat("en-GB", {dateStyle:"medium",timeStyle:"short",timeZone:"Europe/London"}).format(new Date(order.createdAt));
  return `<section class="customer-receipt"><p class="eyebrow">Cal-Eats receipt</p><h3>${escape(order.restaurantName)}</h3><p class="meta">Order ${escape(id.slice(0,8).toUpperCase())} · ${escape(date)}</p><p>${order.fulfillment === "delivery" ? "Delivery" : "Collection"} · ${escape(statusLabel(order.status))}</p><ul class="receipt-items">${rows}</ul><dl class="receipt-totals">${order.restaurantDiscountMinor > 0 ? `<div><dt>Food before offers</dt><dd>${money(order.grossFoodMinor)}</dd></div><div><dt>Restaurant offer</dt><dd>−${money(order.restaurantDiscountMinor)}</dd></div>` : ""}<div><dt>Food</dt><dd>${money(order.subtotalMinor)}</dd></div><div><dt>Delivery</dt><dd>${money(order.deliveryFeeMinor)}</dd></div><div class="receipt-total"><dt>Total paid / due</dt><dd>${money(order.totalMinor)}</dd></div>${order.refundedTotalMinor > 0 ? `<div><dt>Refunded</dt><dd>${money(order.refundedTotalMinor)}</dd></div>` : ""}</dl><p class="meta">${escape(statusLabel(order.paymentStatus))}</p><a class="secondary" href="/api/orders/${encodeURIComponent(id)}/receipt" target="_blank" rel="noopener">Open printable receipt</a></section>`;
}
