import { money, statusLabel } from "./model.js";
const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);
const paths = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  chevron: '<path d="m8 4 8 8-8 8"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  back: '<path d="m10 5-7 7 7 7M3 12h18"/>',
  forward: '<path d="m14 5 7 7-7 7M3 12h18"/>',
  gps: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  edit: '<path d="m15 4 5 5M4 20l4-1L20 7a2 2 0 0 0-5-3L3 16z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 8a2.5 2.5 0 1 1 4 2c-1 .6-1.5 1-1.5 3M12 17h.01"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  delivery: '<path d="M3 5h11v12H3zM14 10h4l3 4v3h-7"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',
  location: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  work: '<rect x="3" y="6" width="18" height="15" rx="3"/><path d="M8 6V3h8v3M3 12h18M10 12v3h4v-3"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  shield: '<path d="m12 2 8 3v6c0 6-8 11-8 11S4 17 4 11V5zM8 11l3 3 5-6"/>',
  discover: '<circle cx="12" cy="12" r="9"/><path d="m16 8-2.5 5.5L8 16l2.5-5.5z"/>',
  orders: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 7h6M9 11h6m-6 4 2 2 4-4"/>',
  offers: '<path d="M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 0 0 4v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4a2 2 0 0 0 0-4zM9 16l6-8"/><circle cx="9" cy="8" r="1"/><circle cx="15" cy="16" r="1"/>',
  messages: '<path d="M5 4h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H9l-5 3v-3a3 3 0 0 1-2-3V7a3 3 0 0 1 3-3zM7 9h10M7 13h6"/>',
  account: '<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  basket: '<path d="M4 8h16l-1 13H5zM8 8V6a4 4 0 0 1 8 0v2"/>'
};
const iconAccents = {
  discover: '<circle cx="12" cy="12" r="8"/>',
  orders: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/>',
  offers: '<rect x="4" y="5" width="16" height="14" rx="3"/>',
  messages: '<rect x="3" y="4" width="18" height="14" rx="3"/>',
  account: '<circle cx="12" cy="7" r="4"/><path d="M5 21v-2a7 7 0 0 1 14 0v2z"/>'
};
export function customerIcon(name) { const key=Object.hasOwn(paths,name)?name:"discover"; return `<svg class="customer-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${Object.hasOwn(iconAccents,key)?`<g class="customer-icon-accent" fill="currentColor" stroke="none" opacity=".13">${iconAccents[key]}</g>`:""}${paths[key]}</svg>`; }
export function customerRestaurantVisual(restaurant = {}) {
  const candidate = restaurant.restaurantImageUrl || restaurant.imageUrl || restaurant.logoUrl;
  let image = "";
  if (typeof candidate === "string") {
    try { const url = new URL(candidate, "https://calai.local"); if (url.protocol === "https:" && !url.username && !url.password) image = candidate; } catch {}
  }
  return `<span class="customer-restaurant-visual"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 14v13h22V14M4 13l3-8h18l3 8M4 13c0 4 6 4 6 0 0 4 6 4 6 0 0 4 6 4 6 0 0 4 6 4 6 0M10 19h5v8M20 19h3v3h-3zM10 5v8M16 5v8M22 5v8"/></svg>${image ? `<img src="${escape(image)}" alt="" loading="lazy" decoding="async">` : ""}</span>`;
}
export function customerReceiptHtml(order) {
  const id = String(order.id), items = Array.isArray(order.items) ? order.items : [];
  const rows = items.map(item => `<li><div><strong>${escape(item.quantity)} × ${escape(item.name || item.itemName)}</strong>${item.selectedModifiers?.length ? `<small>${item.selectedModifiers.map(value => escape(value.optionName || value.name)).join(" · ")}</small>` : ""}</div><strong>${item.isOfferItem ? "Free offer" : money(item.lineTotalMinor)}</strong></li>`).join("");
  const date = new Intl.DateTimeFormat("en-GB", {dateStyle:"medium",timeStyle:"short",timeZone:"Europe/London"}).format(new Date(order.createdAt));
  return `<section class="customer-receipt"><p class="eyebrow">Cal-Eats receipt</p><h3>${escape(order.restaurantName)}</h3><p class="meta">Order ${escape(id.slice(0,8).toUpperCase())} · ${escape(date)}</p><p>${order.fulfillment === "delivery" ? "Delivery" : "Collection"} · ${escape(statusLabel(order.status))}</p><ul class="receipt-items">${rows}</ul><dl class="receipt-totals">${order.restaurantDiscountMinor > 0 ? `<div><dt>Food before offers</dt><dd>${money(order.grossFoodMinor)}</dd></div><div><dt>Restaurant offer</dt><dd>−${money(order.restaurantDiscountMinor)}</dd></div>` : ""}<div><dt>Food</dt><dd>${money(order.subtotalMinor)}</dd></div><div><dt>Delivery</dt><dd>${money(order.deliveryFeeMinor)}</dd></div><div class="receipt-total"><dt>Total paid / due</dt><dd>${money(order.totalMinor)}</dd></div>${order.refundedTotalMinor > 0 ? `<div><dt>Refunded</dt><dd>${money(order.refundedTotalMinor)}</dd></div>` : ""}</dl><p class="meta">${escape(statusLabel(order.paymentStatus))}</p><a class="secondary" href="/api/orders/${encodeURIComponent(id)}/receipt" target="_blank" rel="noopener">Open printable receipt</a></section>`;
}
