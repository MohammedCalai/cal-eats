export const EMBEDDED_PARENT_ORIGIN = "https://calai.info";
export const EMBEDDED_VIEWS = Object.freeze({ dashboard: "/owner/dashboard", orders: "/owner/orders", payouts: "/owner/statements", menu: "/owner/menu", accounts: "/owner/connections", devices: "/owner/devices" });
export function embeddedCommand(event, parentWindow) {
  if (event?.origin !== EMBEDDED_PARENT_ORIGIN || event.source !== parentWindow || event.data?.type !== "cal-eats-workspace:navigate" || event.data.version !== 1) return null;
  return Object.hasOwn(EMBEDDED_VIEWS, event.data.view) ? EMBEDDED_VIEWS[event.data.view] : null;
}
export function embeddedState(business, dashboard, surface, authenticated) {
  const products = {};
  for (const key of ["calai", "cal-eats"]) {
    const value = business?.products?.[key];
    const enabled = authenticated && value?.allowedOnTablet !== false;
    products[key] = { adminAllowed: enabled && value?.adminAllowed === true, linked: enabled && value?.linked === true, ready: enabled && value?.readiness?.ready === true, effectiveStatus: enabled && typeof value?.effectiveStatus === "string" ? value.effectiveStatus : "unavailable" };
    products[key].sourceAccountId = authenticated && typeof (value?.nativeAccountId || value?.sourceAccountId) === "string" ? value.nativeAccountId || value.sourceAccountId : null;
    if (key === "calai") { products[key].sourceAccountId = authenticated && typeof (value?.nativeAccountId || value?.sourceAccountId) === "string" ? value.nativeAccountId || value.sourceAccountId : null; products[key].verifiedSourceUserId = authenticated && typeof value?.verifiedSourceUserId === "string" ? value.verifiedSourceUserId : null; }
  }
  const counters = {};
  for (const key of ["calai", "cal-eats"]) { const value = dashboard?.counts?.[key], available = authenticated && business?.products?.[key]?.allowedOnTablet !== false && value?.available === true && Number.isSafeInteger(value.today) && value.today >= 0; counters[key] = { today: available ? value.today : null, available }; }
  const capabilities = {};
  for (const key of ["viewOrders", "viewPayouts", "manageMenu", "viewDevices"]) capabilities[key] = authenticated && business?.products?.["cal-eats"]?.allowedOnTablet !== false && business?.products?.["cal-eats"]?.capabilities?.[key] === true;
  return { type: "cal-eats-workspace:state", version: 1, authenticated: authenticated === true, business: authenticated && business ? { id: business.id, name: business.name } : null, products, capabilities, counters, surface: authenticated && typeof surface?.state === "string" ? { state: surface.state } : null };
}
