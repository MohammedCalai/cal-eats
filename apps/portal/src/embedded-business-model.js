export const EMBEDDED_PARENT_ORIGIN = "https://calai.info";
export const EMBEDDED_VIEWS = Object.freeze({
  dashboard: "/owner/dashboard",
  orders: "/owner/orders",
  menu: "/owner/menu",
  inbox: "/owner/inbox",
  customers: "/owner/customers",
  offers: "/owner/offers",
  support: "/owner/support",
  devices: "/owner/printers",
  payouts: "/owner/earnings",
  settings: "/owner/settings",
  accounts: "/owner/connections",
});
const capabilityViews = Object.freeze({
  viewOrders: "orders", manageMenu: "menu", viewInbox: "inbox", viewCustomers: "customers",
  manageMarketing: "offers", viewSupport: "support", viewDevices: "devices", viewPayouts: "payouts", manageSettings: "settings",
});
const workspaceModes = ["calai", "cal-eats", "both"];
const orderStates = new Set(["received", "confirmed", "unconfirmed", "placed", "accepted", "preparing",
  "ready", "out_for_delivery", "completed", "rejected", "cancelled", "expired"]);
const orderTypes = new Set(["delivery", "collection", "takeaway"]);

export function embeddedCommand(event, parentWindow) {
  if (event?.origin !== EMBEDDED_PARENT_ORIGIN || event.source !== parentWindow || event.data?.type !== "cal-eats-workspace:navigate" || event.data.version !== 1) return null;
  return Object.hasOwn(EMBEDDED_VIEWS, event.data.view) ? EMBEDDED_VIEWS[event.data.view] : null;
}

export function embeddedState(business, dashboard, surface, authenticated, workspace = {}) {
  const linkedDashboard = business && dashboard?.business?.id === business.id ? dashboard : null;
  const workspaceMode = authenticated && workspaceModes.includes(workspace.mode) ? workspace.mode : null;
  const principalKind = authenticated && ["human", "terminal"].includes(business?.principalKind) ? business.principalKind : null;
  const tabletMode = authenticated && workspaceModes.includes(workspace.tabletMode) ? workspace.tabletMode : null;
  const products = {};
  for (const key of ["calai", "cal-eats"]) {
    const value = business?.products?.[key];
    const enabled = authenticated && value?.allowedOnTablet !== false;
    products[key] = { adminAllowed: enabled && value?.adminAllowed === true, linked: enabled && value?.linked === true, ready: enabled && value?.readiness?.ready === true, effectiveStatus: enabled && typeof value?.effectiveStatus === "string" ? value.effectiveStatus : "unavailable" };
    products[key].sourceAccountId = authenticated && typeof (value?.nativeAccountId || value?.sourceAccountId) === "string" ? value.nativeAccountId || value.sourceAccountId : null;
    if (key === "calai") products[key].verifiedSourceUserId = authenticated && typeof value?.verifiedSourceUserId === "string" ? value.verifiedSourceUserId : null;
  }
  const counters = {};
  for (const key of ["calai", "cal-eats"]) { const value = linkedDashboard?.counts?.[key], available = authenticated && business?.products?.[key]?.allowedOnTablet !== false && value?.available === true && Number.isSafeInteger(value.today) && value.today >= 0; counters[key] = { today: available ? value.today : null, available }; }
  const capabilities = {};
  for (const [key, view] of Object.entries(capabilityViews)) {
    const allowed = workspace.paths instanceof Set
      ? workspace.paths.has(EMBEDDED_VIEWS[view])
      : business?.products?.["cal-eats"]?.capabilities?.[key] === true;
    capabilities[key] = authenticated && business?.products?.["cal-eats"]?.allowedOnTablet !== false && allowed;
  }
  const both = workspaceMode === "both" && (principalKind === "human" || tabletMode === "both");
  const orders = both && Array.isArray(linkedDashboard?.orders) ? linkedDashboard.orders
    .filter(row => counters[row?.source]?.available && orderStates.has(row.status) &&
      typeof row.createdAt === "string" && Number.isFinite(Date.parse(row.createdAt)))
    .slice(0, 8)
    .map(row => ({
      source: row.source, status: row.status, createdAt: new Date(row.createdAt).toISOString(),
      fulfilment: orderTypes.has(row.fulfilment) ? row.fulfilment : "unknown",
      totalMinor: Number.isSafeInteger(row.totalMinor) && row.totalMinor >= 0 ? row.totalMinor : null,
    })) : [];
  const pendingOrderCount = both && tabletMode === "both" && capabilities.viewOrders &&
    Number.isSafeInteger(workspace.pendingOrderCount) && workspace.pendingOrderCount >= 0
      ? workspace.pendingOrderCount : null;
  return {
    type: "cal-eats-workspace:state", version: 1, authenticated: authenticated === true, workspaceMode, principalKind, tabletMode,
    business: authenticated && business ? { id: business.id, name: business.name } : null,
    products, capabilities, counters, orders, pendingOrderCount,
    surface: authenticated && typeof surface?.state === "string" ? { state: surface.state } : null,
  };
}
