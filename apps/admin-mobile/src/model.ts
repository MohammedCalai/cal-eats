export function validateBase(raw: string): string {
  if (!raw) return "";
  let value: URL;
  try { value = new URL(raw); } catch { throw new Error("Configure a complete Cal-Eats API address."); }
  if (value.username || value.password || value.search || value.hash || !["", "/"].includes(value.pathname)) throw new Error("The API address must be an origin, without credentials, a path or a query.");
  const hostname = value.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname !== "eats.calai.info" && (hostname === "calai.info" || hostname.endsWith(".calai.info"))) throw new Error("The original Calai system is read-only and cannot be used by this app.");
  if (value.protocol !== "https:" && !(value.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(hostname))) throw new Error("Use HTTPS for Cal-Eats, or loopback HTTP for a local simulator.");
  return value.origin;
}

export function minorUnits(value: string, label = "Amount"): number {
  const input = value.trim().replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(input)) throw new Error(`${label} must be a positive number with at most two decimal places.`);
  const [whole, fraction = ""] = input.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result) || result > 10_000_000) throw new Error(`${label} is too large.`);
  return result;
}

export const money = (value = 0) => `£${(value / 100).toFixed(2)}`;
export const readable = (value?: string | null) => (value || "Not set").replaceAll("_", " ");
export const operationKey = () => `admin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}-${Math.random().toString(36).slice(2, 14)}`;
export const list = <T,>(value: T[] | { items?: T[] } | null | undefined): T[] => Array.isArray(value) ? value : value?.items || [];

export function caseEvidencePath(caseId: string, evidence: { id: string; url: string }): string | null {
  const id = /^[A-Za-z0-9-]{1,100}$/;
  if (!id.test(caseId) || !id.test(evidence.id)) return null;
  const expected = `/api/refund-cases/${caseId}/evidence/${evidence.id}`;
  return evidence.url === expected ? expected : null;
}

export type NativeUser = { id: string; name: string; email: string; role: "restaurant" | "admin" | "customer" };
export type Restaurant = { id: string; name: string; status: string; suspended?: boolean; permission?: "owner" | "staff" };
export type Option = { id: string; name: string; priceMinor: number; available: boolean };
export type Modifier = { id: string; name: string; minSelections: number; maxSelections: number; options: Option[] };
export type MenuItem = { productType?: string; energyKcal?: number | null; energyKj?: number | null; id: string; name: string; description: string; category: string; priceMinor: number; available: boolean; photoUrl?: string | null; allergens: string[]; dietaryTags: string[]; modifierGroups: Modifier[] };
export type Customer = { id?: string; customerId: string; name: string; completedOrderCount?: number; totalOrderCount?: number; netSpendMinor?: number; averageOrderMinor?: number; lastOrderAt?: string; workflowStatus?: string; engagementStatus?: string; segments?: Record<string, boolean>; merchantOffers?: boolean; eligibleForOffers?: boolean; unreadMessageCount?: number; activeRefundCaseCount?: number; threadId?: string };
export type PageInfo = { page?: number; pageSize?: number; total?: number; totalPages?: number; hasNext?: boolean; hasMore?: boolean };
export type Envelope<T> = { data: T; pagination?: PageInfo; summary?: Record<string, unknown> };
export type Message = { id: string; senderRole: string; senderUserId?: string; message: string; createdAt: string };
export type Thread = { id?: string; threadId?: string; customerId?: string; customerName?: string; name?: string; status: string; unreadCount?: number; unreadMessageCount?: number; lastMessageAt?: string; updatedAt?: string; conversationType?: "order" | "customer"; orderId?: string; messagingAvailable?: boolean };
export type Paged<T> = { items: T[]; pagination?: PageInfo; summary?: Record<string, unknown>; nextCursor?: string | null };
export type Conversation = { thread: Thread; items: Message[]; unreadCount: number; readThroughMessageId?: string | null; nextCursor?: { before: string; beforeId: string } | null };
export type Proposal = { id: string; type: string; status: string; description: string; amountMinor?: number | null; voucherValueMinor?: number | null; redemptionConditions?: string | null; expiresAt?: string | null };
export type RefundCase = { id: string; reference: string; orderId: string; status: string; phase?: string; reason: string; description: string; approvedAmountMinor?: number | null; messages?: Array<{ id: string; audience?: string; message: string; createdAt: string }>; evidence?: Array<{ id: string; url: string; mimeType: string }>; execution?: { status: string; error?: string | null } };
export type Resolution = { phase: string; proposals: Proposal[] };
export type Promotion = { id: string; title: string; offerType: string; recipientCount: number; openedCount: number; redeemedCount: number; expiresAt: string; committedBudgetMinor?: number };
export type Notification = { id: string; title: string; message: string; type: string; readAt?: string | null; restaurantId?: string | null; customerId?: string | null; conversationId?: string | null; orderId?: string | null; supportCaseId?: string | null };
