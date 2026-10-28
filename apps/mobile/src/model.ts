import type { CartEntry, Fulfillment, MenuItem, Restaurant, Selections } from "./types";

export function money(minor = 0): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(minor / 100);
}

export function outwardPostcode(value: string): string {
  const compact = value.trim().toUpperCase().replace(/\s+/g, "");
  return compact.match(/^([A-Z]{1,2}\d[A-Z\d]?)(?:\d[A-Z]{2})?$/)?.[1] ?? "";
}

export function validateSelections(item: MenuItem, selected: Selections): { ok: boolean; reason: string } {
  for (const group of item.modifierGroups ?? []) {
    const ids = [...new Set(selected[group.id] ?? [])];
    const valid = ids.filter((id) => group.options.some((option) => option.id === id && option.available));
    if (valid.length !== ids.length) return { ok: false, reason: `Choose available options for ${group.name}.` };
    if (valid.length < group.minSelections || valid.length > group.maxSelections) {
      return { ok: false, reason: `${group.name} needs ${group.minSelections}${group.minSelections === group.maxSelections ? "" : `–${group.maxSelections}`} selection${group.maxSelections === 1 ? "" : "s"}.` };
    }
  }
  return { ok: true, reason: "" };
}

export function entryUnitMinor(entry: CartEntry): number {
  const extras = entry.item.modifierGroups.reduce((sum, group) => {
    const selected = new Set(entry.selections[group.id] ?? []);
    return sum + group.options.filter((option) => selected.has(option.id)).reduce((groupSum, option) => groupSum + option.priceMinor, 0);
  }, 0);
  return entry.item.priceMinor + extras;
}

export function refreshCart(entries: CartEntry[], menu: MenuItem[]): CartEntry[] {
  return entries.flatMap(entry => {
    const item = menu.find(candidate => candidate.id === entry.item.id && candidate.available);
    if (!item) return [];
    const selections = Object.fromEntries(item.modifierGroups.map(group => [group.id,
      (entry.selections[group.id] ?? []).filter(id => group.options.some(option => option.id === id && option.available)).slice(0, group.maxSelections)
    ]));
    return [{ ...entry, item, selections }];
  });
}

export function toggleSelection(selected: string[], optionId: string, maximum: number): string[] {
  if (selected.includes(optionId)) return selected.filter(id => id !== optionId);
  return maximum === 1 ? [optionId] : [...selected, optionId].slice(0, maximum);
}

export function cartTotals(entries: CartEntry[], fulfillment: Fulfillment, restaurant?: Restaurant | null) {
  const subtotalMinor = entries.reduce((sum, entry) => sum + entryUnitMinor(entry) * entry.quantity, 0);
  const deliveryFeeMinor = fulfillment === "delivery" ? restaurant?.delivery.deliveryFeeMinor ?? 0 : 0;
  return { subtotalMinor, deliveryFeeMinor, totalMinor: subtotalMinor + deliveryFeeMinor };
}

export function canCheckout(entries: CartEntry[], fulfillment: Fulfillment, restaurant: Restaurant | null, postcode: string) {
  if (!restaurant) return { ok: false, reason: "Choose a restaurant first." };
  if (!entries.length) return { ok: false, reason: "Your basket is empty." };
  if (entries.some((entry) => !Number.isSafeInteger(entry.quantity) || entry.quantity < 1 || entry.quantity > 20)) return { ok: false, reason: "Basket quantities must be between 1 and 20." };
  if (restaurant.suspended || restaurant.profile.paused || !restaurant.acceptingOrders) return { ok: false, reason: restaurant.closedReason || "This restaurant cannot accept orders now." };
  for (const entry of entries) {
    if (!entry.item.available) return { ok: false, reason: `${entry.item.name} is no longer available. Refresh the menu before ordering.` };
    const validity = validateSelections(entry.item, entry.selections);
    if (!validity.ok) return validity;
  }
  if (fulfillment === "collection" && !restaurant.profile.collectionEnabled) return { ok: false, reason: "Collection is unavailable." };
  if (fulfillment === "delivery") {
    if (!restaurant.delivery.enabled) return { ok: false, reason: "Delivery is unavailable." };
    const outcode = outwardPostcode(postcode);
    if (!outcode || !restaurant.delivery.outcodes.includes(outcode)) return { ok: false, reason: "That postcode is outside this delivery area." };
    if (cartTotals(entries, fulfillment, restaurant).subtotalMinor < restaurant.delivery.minDeliverySubtotalMinor) return { ok: false, reason: `Delivery needs at least ${money(restaurant.delivery.minDeliverySubtotalMinor)} of food.` };
  }
  return { ok: true, reason: "" };
}

export function orderItems(entries: CartEntry[]) {
  return entries.map((entry) => ({
    menuItemId: entry.item.id,
    quantity: entry.quantity,
    ...(entry.item.modifierGroups.some((group) => (entry.selections[group.id] ?? []).length) ? {
      modifiers: entry.item.modifierGroups.flatMap((group) => {
        const optionIds = entry.selections[group.id] ?? [];
        return optionIds.length ? [{ groupId: group.id, optionIds }] : [];
      })
    } : {})
  }));
}

export function requestKey(prefix: string): string {
  const random = Math.random().toString(36).slice(2);
  return `${prefix}-${Date.now().toString(36)}-${random}`.slice(0, 100);
}
