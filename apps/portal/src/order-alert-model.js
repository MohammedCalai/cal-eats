export function orderNeedsConfirmation(order) {
  if (!order || order.status !== "placed") return false;
  if (order.paymentMethod !== "card") return true;
  return ["authorized", "captured"].includes(order.payment?.status) || ["stripe_authorized", "stripe_captured"].includes(order.paymentStatus);
}

export function pendingOrdersForRestaurant(items, restaurantId) {
  return (Array.isArray(items) ? items : []).filter(order => order.restaurantId === restaurantId && orderNeedsConfirmation(order))
    .sort((a,b) => String(a.merchantVisibleAt || a.createdAt).localeCompare(String(b.merchantVisibleAt || b.createdAt)) || a.id.localeCompare(b.id));
}

// This input comes only from the authenticated, membership-scoped pending API.
// A selected restaurant must not hide another current membership's pending order.
export function pendingOrdersFromAuthoritativeQueue(items) {
  return (Array.isArray(items)?items:[]).filter(orderNeedsConfirmation)
    .sort((a,b)=>String(a.merchantVisibleAt||a.createdAt).localeCompare(String(b.merchantVisibleAt||b.createdAt))||a.id.localeCompare(b.id));
}

export function orderIsOverdue(order, now = Date.now()) {
  const due = Date.parse(order?.confirmationDueAt);
  return order?.confirmationOverdue === true || (Number.isFinite(due) && due <= now);
}

export function orderSoundPath(orders, now = Date.now()) {
  if (!orders?.length) return null;
  return orders.some(order=>orderIsOverdue(order,now)) ? "/business/unconfirmed-notification.wav" : "/business/notification.wav";
}

export function customerEtaLabel(order) { return order?.fulfillment === "delivery" ? "Expected delivery arrival" : "Ready for collection"; }

export function orderEtaDefaultMinutes(order, restaurant) {
  const supplied=Number(order?.defaultCustomerEtaMinutes);
  if (Number.isInteger(supplied) && supplied >= 1 && supplied <= 1440) return supplied;
  const profile=restaurant?.profile||{},base=Number(order?.fulfillment==="delivery"?profile.estimatedDeliveryMinutes:profile.estimatedCollectionMinutes),busy=Number(profile.busyMinutes)||0;
  return Math.min(1440,Math.max(1,Math.round((Number.isFinite(base)&&base>0?base:order?.fulfillment==="delivery"?45:20)+busy)));
}

export function confirmationPayload(minutes, now = Date.now()) {
  const value=Number(minutes);
  if (!Number.isInteger(value) || value < 1 || value > 1440) throw new Error("Choose an ETA from 1 to 1,440 minutes.");
  return { status:"accepted", estimatedReadyAt:new Date(now+value*60_000).toISOString() };
}

export function businessOrderTransitions(status, fulfillment) {
  return ({ placed:["accepted"], accepted:["preparing"], preparing:["ready"], ready:fulfillment==="delivery"?["out_for_delivery"]:["completed"], out_for_delivery:["completed"] })[status] || [];
}
