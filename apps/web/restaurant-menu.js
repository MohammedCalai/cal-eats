import { menuSections } from "./menu-sections.js";
import { money } from "./model.js";
const e = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

function itemHtml(item, cart) {
  const quantity = cart[item.id] || 0;
  const controls = `<div class="dish-quantity" aria-label="Quantity for ${e(item.name)}">${quantity ? `<button data-action="qty" data-id="${e(item.id)}" data-delta="-1" aria-label="Remove one ${e(item.name)}">−</button><span>${quantity}</span>` : ""}<button data-action="${item.modifierGroups?.length ? "menu-item" : "qty"}" data-id="${e(item.id)}" data-delta="1" aria-label="${item.modifierGroups?.length ? "Customise" : "Add one"} ${e(item.name)}" ${item.available === false || quantity >= 20 ? "disabled" : ""}>+</button></div>`;
  return `<article class="restaurant-dish ${item.photoUrl ? "dish-with-photo" : "dish-text"}" data-menu-card data-search="${e(`${item.name} ${item.description ?? ""} ${item.category ?? ""}`.toLowerCase())}">
    ${item.photoUrl ? `<div class="dish-visual"><button class="dish-photo" data-action="menu-item" data-id="${e(item.id)}" aria-label="View ${e(item.name)}"><img loading="lazy" src="${e(item.photoUrl)}" alt="${e(item.name)}"></button>${controls}</div>` : ""}
    <div class="dish-copy"><button class="dish-title" data-action="menu-item" data-id="${e(item.id)}"><h3>${e(item.name)}</h3></button><strong class="dish-price">${money(item.priceMinor)}</strong>${item.description ? `<p class="dish-description">${e(item.description)}</p>` : ""}
    ${item.allergens?.length ? `<span class="dish-tags">Contains ${item.allergens.map(e).join(", ")}</span>` : ""}${item.dietaryTags?.length ? `<span class="dish-tags">${item.dietaryTags.map(e).join(" · ")}</span>` : ""}${item.modifierGroups?.length ? `<span class="dish-options">Customise available</span>` : ""}</div>
    ${!item.photoUrl ? controls : ""}
  </article>`;
}

export function restaurantMenuHtml({ restaurant, items, cart }) {
  const sections = menuSections(items);
  return `<div class="restaurant-menu" data-restaurant-menu><nav class="restaurant-menu-nav" aria-label="Restaurant menu navigation"><div class="menu-mini-heading"><button class="quiet" data-action="back-discover" aria-label="Back to restaurants">←</button><strong>${e(restaurant.name)}</strong><button class="quiet" data-menu-search-toggle aria-label="Search this menu">⌕</button></div>
    <div class="menu-category-line"><button class="menu-section-picker" data-action="menu-sections" aria-label="All menu sections">☷</button><div class="menu-category-scroll">${sections.map((section, index) => `<button data-menu-section="${section.id}" ${index === 0 ? 'aria-current="true"' : ""}>${e(section.title)}</button>`).join("")}</div></div>
    <label class="menu-search" hidden><span class="sr-only">Search this menu</span><input type="search" placeholder="Search dishes in this menu" aria-label="Search dishes in this menu" maxlength="100"><button class="quiet" data-menu-search-close aria-label="Close menu search">×</button></label></nav>
    <div class="menu-content">${sections.map(section => `<section class="restaurant-menu-section" id="${section.id}" data-menu-section-content><h2>${e(section.title)}</h2><div class="restaurant-dishes">${section.items.map(item => itemHtml(item, cart)).join("")}</div></section>`).join("")}${!sections.length ? '<p class="empty">This restaurant has no available items right now.</p>' : ""}<p class="empty" data-menu-no-results hidden>No dishes match your search.</p></div></div>`;
}

export function mountRestaurantMenu(root) {
  const nav = root.querySelector(".restaurant-menu-nav"), track = root.querySelector(".menu-category-scroll"), search = root.querySelector(".menu-search"), input = search.querySelector("input");
  const sections = [...root.querySelectorAll("[data-menu-section-content]")];
  let frame = 0, active = "", closed = false;
  function sync() {
    frame = 0; if (closed || !root.isConnected) return;
    const edge = nav.getBoundingClientRect().bottom + 12, visible = sections.filter(section => !section.hidden);
    const current = visible.filter(section => section.getBoundingClientRect().top <= edge).at(-1) || visible[0];
    if (!current || active === current.id) return; active = current.id;
    for (const button of track.children) button.setAttribute("aria-current", String(button.dataset.menuSection === active));
    const button = [...track.children].find(button => button.dataset.menuSection === active);
    if (button && (button.offsetLeft < track.scrollLeft || button.offsetLeft + button.offsetWidth > track.scrollLeft + track.clientWidth)) track.scrollTo({ left: Math.max(0, button.offsetLeft - 12), behavior: "auto" });
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(sync); }
  function filter() {
    const needle = input.value.trim().toLowerCase(); let count = 0;
    for (const section of sections) { let matches = 0; for (const card of section.querySelectorAll("[data-menu-card]")) { card.hidden = !card.dataset.search.includes(needle); if (!card.hidden) matches++; } section.hidden = !matches; count += matches; const button = [...track.children].find(button => button.dataset.menuSection === section.id); if (button) button.hidden = !matches; }
    root.querySelector("[data-menu-no-results]").hidden = count > 0 || !needle; active = ""; sync();
  }
  function jump(id) { const section = sections.find(section => section.id === id); if (!section) return; if (input.value) { input.value = ""; filter(); } const bannerHeight = parseFloat(getComputedStyle(nav).top) || 0; const top = window.scrollY + section.getBoundingClientRect().top - bannerHeight - nav.offsetHeight - 10; window.scrollTo({ top: Math.max(0, top), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" }); }
  function click(event) { const button = event.target.closest("button"); if (!button) return; if (button.dataset.menuSection) jump(button.dataset.menuSection); if (button.hasAttribute("data-menu-search-toggle")) { search.hidden = !search.hidden; if (!search.hidden) input.focus(); } if (button.hasAttribute("data-menu-search-close")) { input.value = ""; search.hidden = true; filter(); } }
  root.addEventListener("click", click); input.addEventListener("input", filter); window.addEventListener("scroll", schedule, { passive: true }); window.addEventListener("resize", schedule); sync();
  return { jump, close() { closed = true; cancelAnimationFrame(frame); root.removeEventListener("click", click); input.removeEventListener("input", filter); window.removeEventListener("scroll", schedule); window.removeEventListener("resize", schedule); } };
}
