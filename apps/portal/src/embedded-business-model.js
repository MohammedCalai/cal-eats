import { embeddedLiveStats } from "./embedded-live-stats.js";

export const EMBEDDED_PARENT_ORIGIN = "https://calai.info";
export const EMBEDDED_VIEWS = Object.freeze({
  background: "/owner/embedded-background",
  dashboard: "/owner/dashboard",
  reports: "/owner/dashboard?section=reports",
  statements: "/owner/statements",
  notifications: "/owner/notifications",
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
const orderId = value => typeof value === "string" && /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value);

export function embeddedCommand(event, parentWindow) {
  if (event?.origin !== EMBEDDED_PARENT_ORIGIN || event.source !== parentWindow || event.data?.type !== "cal-eats-workspace:navigate" || event.data.version !== 1) return null;
  if (event.data.orderId !== undefined) {
    return event.data.view === "orders" && orderId(event.data.orderId)
      ? EMBEDDED_VIEWS.orders + "?order=" + encodeURIComponent(event.data.orderId) : null;
  }
  return Object.hasOwn(EMBEDDED_VIEWS, event.data.view) ? EMBEDDED_VIEWS[event.data.view] : null;
}

export function acceptsHostedMessageSound(event, parentWindow, businessId) {
  return Boolean(businessId && parentWindow && event?.source === parentWindow &&
    event.origin === EMBEDDED_PARENT_ORIGIN && event.data?.version === 1 &&
    event.data.type === "cal-eats-workspace:host-message-audio" && event.data.businessId === businessId);
}

function messageAttentionFor(business, attention, now) {
  if (!business?.eatsRestaurantId || attention?.restaurantId !== business.eatsRestaurantId ||
      !Number.isSafeInteger(attention.checkedAt) || attention.checkedAt > now || now - attention.checkedAt > 45_000 ||
      !Number.isSafeInteger(attention.unreadCount) || attention.unreadCount < 0 ||
      !Number.isSafeInteger(attention.revision) || attention.revision < 0 ||
      !Number.isSafeInteger(attention.acknowledgedRevision) || attention.acknowledgedRevision < -1 ||
      typeof attention.soundEnabled !== "boolean" || typeof attention.orderAlarmActive !== "boolean") return null;
  // A read receipt can arrive just ahead of the count poll. It covers all
  // arrivals in this snapshot without claiming how many later messages exist.
  return { unreadCount: attention.unreadCount, revision: attention.revision, acknowledgedRevision: Math.min(attention.acknowledgedRevision, attention.revision),
    soundEnabled: attention.soundEnabled, orderAlarmActive: attention.orderAlarmActive };
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
  const both = workspaceMode === "both" && (principalKind === "human" && tabletMode === null || tabletMode === "both" && principalKind !== null) &&
    Object.values(products).every(product => product.adminAllowed && product.linked && product.ready);
  const orders = both && capabilities.viewOrders && Array.isArray(linkedDashboard?.orders) ? linkedDashboard.orders
    .filter(row => counters[row?.source]?.available && orderStates.has(row.status) &&
      typeof row.createdAt === "string" && Number.isFinite(Date.parse(row.createdAt)))
    .slice(0, 8)
    .map(row => ({
      source: row.source, status: row.status, createdAt: new Date(row.createdAt).toISOString(),
      ...(row.source === "cal-eats" && orderId(row.sourceOrderId) ? { sourceOrderId: row.sourceOrderId } : {}),
      fulfilment: orderTypes.has(row.fulfilment) ? row.fulfilment : "unknown",
      totalMinor: Number.isSafeInteger(row.totalMinor) && row.totalMinor >= 0 ? row.totalMinor : null,
    })) : [];
  const pendingOrderCount = both && tabletMode === "both" && capabilities.viewOrders &&
    Number.isSafeInteger(workspace.pendingOrderCount) && workspace.pendingOrderCount >= 0
      ? workspace.pendingOrderCount : null;
  const messageAttention = both && (capabilities.viewInbox || capabilities.viewOrders)
    ? messageAttentionFor(business, workspace.messageAttention, Date.now()) : null;
  return {
    type: "cal-eats-workspace:state", version: 1, authenticated: authenticated === true, workspaceMode, principalKind, tabletMode,
    business: authenticated && business ? { id: business.id, name: business.name } : null,
    products, capabilities, counters, orders, pendingOrderCount, messageAttention,
    ...embeddedLiveStats(both && authenticated && capabilities.viewOrders ? linkedDashboard : null),
    surface: authenticated && typeof surface?.state === "string" ? { state: surface.state } : null,
  };
}
