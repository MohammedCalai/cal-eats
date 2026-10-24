export const ORDER_FLOW = Object.freeze({
  collection: ["placed", "accepted", "preparing", "ready", "completed"],
  delivery: ["placed", "accepted", "preparing", "ready", "out_for_delivery", "completed"]
});
export const AUTH_SUBMIT_SELECTOR = "button[type=submit], button:not([type])";

export function money(minor = 0, currency = "GBP") {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(Number(minor) / 100);
}

export function outwardPostcode(value = "") {
  const compact = String(value).trim().toUpperCase().replace(/\s+/g, "");
  const match = compact.match(/^([A-Z]{1,2}\d[A-Z\d]?)(?:\d[A-Z]{2})?$/);
  return match?.[1] ?? "";
}

export function restaurantMatches(restaurant, query = "", postcode = "", fulfillment = "delivery") {
  const needle = query.trim().toLocaleLowerCase("en-GB");
  const searchable = [restaurant.name, restaurant.profile?.description, restaurant.profile?.cuisine].filter(Boolean).join(" ").toLocaleLowerCase("en-GB");
  const textMatch = !needle || searchable.includes(needle);
  const outcode = outwardPostcode(postcode);
  const deliveryMatch = fulfillment === "collection" || !outcode || (restaurant.delivery?.enabled && restaurant.delivery.outcodes?.includes(outcode));
  return textMatch && deliveryMatch;
}

export function modifierSelection(item, selected = {}) {
  const modifiers = [];
  let modifierTotalMinor = 0;
  for (const group of item.modifierGroups ?? []) {
    const ids = [...new Set(selected[group.id] ?? [])];
    const options = ids.map((id) => group.options.find((option) => option.id === id)).filter(Boolean);
    if (options.length) modifiers.push({ groupId: group.id, optionIds: options.map((option) => option.id) });
    modifierTotalMinor += options.reduce((sum, option) => sum + option.priceMinor, 0);
  }
  return { modifiers, modifierTotalMinor };
}

export function validateModifierSelection(item, selected = {}) {
  for (const group of item.modifierGroups ?? []) {
    const ids = [...new Set(selected[group.id] ?? [])];
    const valid = ids.filter((id) => group.options.some((option) => option.id === id && option.available));
    if (valid.length !== ids.length) return { ok: false, reason: `Choose available options for ${group.name}.` };
    if (valid.length < group.minSelections || valid.length > group.maxSelections) return { ok: false, reason: `${group.name} needs ${group.minSelections}${group.minSelections === group.maxSelections ? "" : `–${group.maxSelections}`} selection${group.maxSelections === 1 ? "" : "s"}.` };
  }
  return { ok: true, reason: "" };
}

export function cartLines(items, quantities, selections = {}) {
  return items.filter((item) => (quantities[item.id] ?? 0) > 0).map((item) => ({
    ...item, quantity: quantities[item.id], ...modifierSelection(item, selections[item.id]),
    lineTotalMinor: (item.priceMinor + modifierSelection(item, selections[item.id]).modifierTotalMinor) * quantities[item.id]
  }));
}

export function cartTotals(lines, fulfillment, delivery = {}) {
  const subtotalMinor = lines.reduce((sum, item) => sum + item.lineTotalMinor, 0);
  const deliveryFeeMinor = fulfillment === "delivery" ? (delivery.deliveryFeeMinor ?? 0) : 0;
  return { subtotalMinor, deliveryFeeMinor, totalMinor: subtotalMinor + deliveryFeeMinor };
}

export function orderItemPayload(lines) {
  return lines.map((line) => ({
    menuItemId: line.id,
    quantity: line.quantity,
    ...(line.modifiers?.length ? { modifiers: line.modifiers } : {})
  }));
}

export function currentSelections(item, snapshots = []) {
  const selected = {};
  for (const snapshot of snapshots) {
    const group = item.modifierGroups?.find((candidate) => candidate.id === snapshot.groupId);
    const option = group?.options.find((candidate) => candidate.id === snapshot.optionId && candidate.available);
    if (option) (selected[group.id] ??= []).push(option.id);
  }
  return validateModifierSelection(item, selected).ok ? selected : {};
}

export function canDeliver(delivery, postcode, subtotalMinor) {
  if (!delivery?.enabled) return { ok: false, reason: "Delivery is not available from this restaurant." };
  const outcode = outwardPostcode(postcode);
  if (!outcode || !delivery.outcodes?.includes(outcode)) return { ok: false, reason: "This postcode is outside the restaurant’s delivery area." };
  if (subtotalMinor < delivery.minDeliverySubtotalMinor) return { ok: false, reason: `Add ${money(delivery.minDeliverySubtotalMinor - subtotalMinor)} more for delivery.` };
  return { ok: true, reason: "" };
}

export function availabilityMessage(restaurant, fulfillment = "collection") {
  if (restaurant.suspended) return "This restaurant is suspended and cannot take new orders.";
  if (restaurant.profile?.paused) return "Ordering is paused by the restaurant.";
  if (restaurant.acceptingOrders === false) return restaurant.closedReason || "This restaurant is currently closed.";
  if (fulfillment === "collection" && restaurant.profile?.collectionEnabled === false) return "Collection is currently unavailable.";
  if (fulfillment === "delivery" && !restaurant.delivery?.enabled) return "Delivery is currently unavailable.";
  return "";
}

export function estimatedMargin(grossCommissionMinor, costs = {}) {
  const totalCostsMinor = Object.values(costs).reduce((sum, value) => sum + (Number.isSafeInteger(value) ? value : 0), 0);
  return { grossCommissionMinor, totalCostsMinor, estimatedMarginMinor: grossCommissionMinor - totalCostsMinor };
}

export function recognisedCommission(entries = []) {
  const kinds = new Set(["commission_mock", "commission_cash_receivable", "commission_mock_refund", "commission_cash_refund"]);
  return entries.filter((entry) => kinds.has(entry.kind)).reduce((sum, entry) => sum + entry.amountMinor, 0);
}

export function shortStableId(value, fallback = "item") {
  const id = String(value ?? "").toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return id || fallback;
}

export function serializeOpeningRows(rows) {
  return rows.map((row) => ({ day: Number(row.day), open: row.open, close: row.close }));
}

export function serializeModifierRows(groups) {
  return groups.map((group, groupIndex) => ({
    id: group.id || shortStableId(group.name, `group-${groupIndex + 1}`), name: group.name,
    minSelections: Number(group.minSelections), maxSelections: Number(group.maxSelections),
    options: group.options.map((option, optionIndex) => ({ id: option.id || shortStableId(option.name, `option-${optionIndex + 1}`), name: option.name, priceMinor: Math.round(Number(option.extraPrice) * 100), available: Boolean(option.available) }))
  }));
}

export function nextOrderStatuses(order) {
  if (order.status === "placed") return ["accepted", "rejected"];
  const flow = ORDER_FLOW[order.fulfillment] ?? ORDER_FLOW.collection;
  const index = flow.indexOf(order.status);
  return index >= 0 && index < flow.length - 1 ? [flow[index + 1]] : [];
}

export function statusLabel(value = "") {
  return String(value).replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

export function createRequestKey(prefix = "order") {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function safeCsvCell(value) {
  const text = String(value ?? "");
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}
