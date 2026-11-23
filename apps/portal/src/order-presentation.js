export const orderCustomerName = order => order?.customerName || order?.contactName || "Customer name unavailable";
export function orderDeliveryAddress(order) {
  const address = order?.deliveryAddress;
  if (typeof address === "string") return address;
  return address ? [address.line1, address.line2, address.city, address.postcode].filter(Boolean).join(", ") : "";
}
export const orderDestination = order => order?.fulfillment === "delivery" ? orderDeliveryAddress(order) || "Delivery address unavailable" : orderCustomerName(order);
export const orderReprintLabel = order => `${order?.fulfillment === "delivery" ? "Delivery" : "Collection"} · ${orderDestination(order)}${order?.fulfillment === "delivery" ? ` · ${orderCustomerName(order)}` : ""} · #${String(order?.id || "").slice(0,8).toUpperCase()}`;
export function canPrintOrderReceipt(order, restaurantId) {
  return Boolean(order?.id && restaurantId && order.restaurantId === restaurantId &&
    (!order.source || order.source === "cal-eats") &&
    ["accepted", "preparing", "ready", "out_for_delivery", "completed"].includes(order.status));
}
export function orderReceiptPrincipal(business, restaurantId, permission, registeredTablet) {
  const eats = business?.products?.["cal-eats"];
  if (!business?.id || business.eatsRestaurantId !== restaurantId || eats?.allowedOnTablet === false) return null;
  if (registeredTablet) return "terminal";
  return business.principalKind === "human" && permission === "owner" &&
    business.canConnectProducts === true && business.canViewEats === true && eats?.active === true
    ? "owner" : null;
}
export const orderStatusText = order => ({placed:"Awaiting confirmation",accepted:"Confirmed",preparing:"Preparing",ready:order?.fulfillment === "delivery"?"Ready for dispatch":"Ready to collect",out_for_delivery:"Out for delivery",completed:order?.fulfillment === "delivery"?"Delivered":"Collected",rejected:"Rejected",cancelled:"Cancelled"})[order?.status] || String(order?.status || "Unavailable").replaceAll("_", " ");
function shiftDate(value, days) { const date = new Date(`${value}T12:00:00Z`); date.setUTCDate(date.getUTCDate()+days); return date.toISOString().slice(0,10); }
export function orderDatePreset(preset, now = new Date()) {
  if (preset === "all") return {from:"",to:""};
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/London",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now).map(part=>[part.type,part.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`, weekday = new Date(`${today}T12:00:00Z`).getUTCDay(), monday = shiftDate(today,-((weekday+6)%7));
  if(preset === "yesterday") { const date=shiftDate(today,-1); return {from:date,to:date}; }
  if(preset === "this_week") return {from:monday,to:today};
  if(preset === "last_week") return {from:shiftDate(monday,-7),to:shiftDate(monday,-1)};
  return {from:today,to:today};
}
