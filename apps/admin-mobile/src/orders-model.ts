export type OrderStatus = "placed" | "accepted" | "preparing" | "ready" | "out_for_delivery" | "completed" | "rejected";
export type BusinessOrder = {
  id: string; restaurantId: string; restaurantName: string; customerId: string; customerName: string; customerPhone?: string | null;
  fulfillment: "delivery" | "collection"; status: OrderStatus; currency: string; totalMinor: number; subtotalMinor: number; deliveryFeeMinor: number;
  paymentMethod: "cash" | "mock_card" | "card"; paymentStatus: string; createdAt: string; updatedAt: string;
  deliveryAddress?: { line1: string; line2?: string; city: string; postcode: string } | null; deliveryInstructions?: string; allergyNotes?: string;
  estimatedReadyAt?: string | null; customerEtaAt?: string | null; customerEtaType?: "arrival" | "ready" | null; confirmedAt?: string | null;
  merchantVisibleAt?: string | null; confirmationDueAt?: string | null; confirmationOverdue?: boolean; defaultCustomerEtaMinutes?: number;
  items: Array<{ id: string; name: string; quantity: number; unitPriceMinor: number; lineTotalMinor: number; isOfferItem?: boolean; selectedModifiers?: Array<{ name: string; priceMinor: number }>; allergens?: string[] }>;
};
export type PendingOrders = { items: BusinessOrder[]; total: number; limit: number };
export const CONFIRMED_STATUSES = new Set<OrderStatus>(["accepted", "preparing", "ready", "out_for_delivery", "completed"]);
export const orderEtaLabel = (order: Pick<BusinessOrder, "fulfillment">) => order.fulfillment === "delivery" ? "Customer arrival estimate" : "Ready for collection estimate";
export function minutesFromText(text: string) {
  if (!/^\d+$/.test(text.trim())) throw new Error("Enter the estimate in whole minutes.");
  const minutes = Number(text.trim());
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error("Choose an estimate between 1 minute and 24 hours.");
  return minutes;
}
export function etaTimestamp(text: string, now = new Date()): string { const minutes = minutesFromText(text); if (!Number.isFinite(now.getTime())) throw new Error("The phone's clock could not be read."); return new Date(now.getTime() + minutes * 60_000).toISOString(); }
export function defaultEtaMinutes(order: BusinessOrder, now = new Date()) {
  const current = order.customerEtaAt || (order.fulfillment === "collection" ? order.estimatedReadyAt : null);
  if (order.status !== "placed" && current && Date.parse(current) > now.getTime()) return Math.min(1440, Math.max(1, Math.ceil((Date.parse(current) - now.getTime()) / 60_000)));
  const fallback = order.fulfillment === "delivery" ? 45 : 20, value = order.defaultCustomerEtaMinutes;
  return value && Number.isInteger(value) && value > 0 && value <= 1440 ? value : fallback;
}
export function nextOrderAction(order: Pick<BusinessOrder, "status" | "fulfillment">): { status: OrderStatus; label: string } | null {
  if (order.status === "accepted") return { status: "preparing", label: "Start preparing" };
  if (order.status === "preparing") return { status: "ready", label: order.fulfillment === "delivery" ? "Mark ready for driver" : "Mark ready for collection" };
  if (order.status === "ready") return order.fulfillment === "delivery" ? { status: "out_for_delivery", label: "Mark out for delivery" } : { status: "completed", label: "Mark collected" };
  if (order.status === "out_for_delivery" && order.fulfillment === "delivery") return { status: "completed", label: "Mark delivered" };
  return null;
}
export function pendingOrderQueue(items: BusinessOrder[]) {
  return [...new Map(items.filter(order => order.status === "placed").map(order => [order.id, order])).values()].sort((a, b) => {
    const time = (order: BusinessOrder) => { const value = Date.parse(order.confirmationDueAt || order.merchantVisibleAt || order.createdAt); return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER; };
    return time(a) - time(b) || a.id.localeCompare(b.id);
  });
}
export function orderSoundAllowed({ signedIn, foreground, enabled, verified, pendingCount }: { signedIn: boolean; foreground: boolean; enabled: boolean; verified: boolean; pendingCount: number }) { return signedIn && foreground && enabled && verified && pendingCount > 0; }
export function customerEtaDisplay(order: BusinessOrder) {
  const value = order.customerEtaAt || (order.fulfillment === "collection" ? order.estimatedReadyAt : null);
  if (!value || !Number.isFinite(Date.parse(value))) return "Not confirmed yet";
  return new Date(value).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
}
