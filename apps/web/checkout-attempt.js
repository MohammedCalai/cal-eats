const NO_ORDER_CONFLICTS = new Set([
  "PRICE_CHANGED", "RESTAURANT_UNAVAILABLE", "COLLECTION_DISABLED", "DELIVERY_DISABLED", "DELIVERY_OUTSIDE_AREA", "DELIVERY_MINIMUM",
  "MENU_ITEM_UNAVAILABLE", "MODIFIER_SELECTION_INVALID", "MODIFIER_UNAVAILABLE", "OFFER_UNAVAILABLE", "MARKETING_CONSENT_WITHDRAWN",
  "OFFER_EXPIRED", "OFFER_NOT_STARTED", "OFFER_LIMIT_REACHED", "OFFER_BUDGET_EXCEEDED", "OFFER_MINIMUM", "OFFER_NOT_ELIGIBLE",
  "OFFER_REQUIRES_PURCHASE", "OFFER_ITEM_UNAVAILABLE", "PAYMENT_DECLINED", "CARD_MINIMUM_TOTAL", "APPROVED_TERMS_REQUIRED"
]);

export function isDefiniteNoOrderError(error) {
  if (!error || typeof error.code !== "string" || error.code === "IDEMPOTENCY_CONFLICT") return false;
  return [400, 401, 403, 404, 413, 422, 429].includes(error.status) || (error.status === 409 && NO_ORDER_CONFLICTS.has(error.code));
}

// Shared by browser and native checkout. Retain the exact reviewed request until its outcome is known.
export function createCheckoutAttempt(createKey) {
  let pending = null, flight = null, uncertain = false;
  return {
    get pending() { return pending; },
    clear() { pending = null; flight = null; uncertain = false; },
    submit(body, send) {
      if (flight) return flight;
      if (!pending) {
        if (!body) throw new TypeError("A reviewed checkout is required");
        pending = Object.freeze({ key: createKey(), serializedBody: JSON.stringify(body) });
        uncertain = false;
      }
      const current = pending;
      const work = Promise.resolve().then(() => send(current)).then(value => {
        if (!value || typeof value.id !== "string" || !value.id) { if (pending === current) uncertain = true; const error = new Error("The order response was incomplete. Check the original order before trying again."); error.status = 0; error.code = "MALFORMED_RESPONSE"; throw error; }
        if (pending === current) { pending = null; uncertain = false; }
        return value;
      }, error => {
        if (pending === current) {
          // A guard can reject a retry before looking up an order that already committed.
          if (!uncertain && isDefiniteNoOrderError(error)) pending = null;
          else uncertain = true;
        }
        throw error;
      }).finally(() => { if (flight === work) flight = null; });
      flight = work;
      return work;
    }
  };
}
