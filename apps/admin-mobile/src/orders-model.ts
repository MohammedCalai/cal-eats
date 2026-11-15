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
export const orderEtaLabel = (order: Pick<BusinessOrder, "fulfillment">) => order.fulfillment === "delivery" ? "Customer arrival estimate" : "Ready for collection estimate";
export function customerEtaDisplay(order: BusinessOrder) {
  const value = order.customerEtaAt || (order.fulfillment === "collection" ? order.estimatedReadyAt : null);
  if (!value || !Number.isFinite(Date.parse(value))) return "Not confirmed yet";
  return new Date(value).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
}
