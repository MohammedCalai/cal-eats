export const LIVE_ACTIVITY_NAME = "CalEatsOrderActivity";
export const LIVE_ACTIVITY_PROJECT_ID = "5bf59184-c670-44f4-be78-5229cbd02300";
export const LIVE_ACTIVITY_LIFETIME_MS = 8 * 60 * 60 * 1000;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export type LiveOrderContent = { orderId: string; restaurantName: string; statusLabel: string; etaLabel: string; etaUnix: number | null; fulfillment: "delivery" | "collection"; updatedAtUnix: number };
export type LiveOrderCandidate = { orderId: string; createdAt: string; scheduledFor: string | null; serverRevision: number; content: LiveOrderContent };
export type LiveActivityFeed = { updatesEnabled: boolean; items: LiveOrderCandidate[] };
export type LiveActivityRegistration = { registered: boolean; activityId: string; expiresAt: string | null; content: LiveOrderContent; serverRevision: number; updatesEnabled: boolean; action: "update" | "end" };
export type LiveActivityIdentity = { token: string; userId: string; installationId: string };
export type LiveActivityBinding = { activityId: string | null; orderId: string; userId: string; startedAt: number; expiresAt: number; suppressed: boolean; serverRevision?: number };

export function parseLiveOrderContent(value: unknown): LiveOrderContent | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const text = (name: string, max: number) => typeof v[name] === "string" && (v[name] as string).length <= max && !/[\u0000-\u001f]/.test(v[name] as string);
  if (typeof v.orderId !== "string" || !uuid.test(v.orderId) || !text("restaurantName", 160) || !text("statusLabel", 100) || !text("etaLabel", 100) || !["delivery", "collection"].includes(String(v.fulfillment)) || typeof v.updatedAtUnix !== "number" || !Number.isSafeInteger(v.updatedAtUnix) || v.updatedAtUnix <= 0 || !(v.etaUnix === null || typeof v.etaUnix === "number" && Number.isSafeInteger(v.etaUnix) && v.etaUnix > 0)) return null;
  // Explicit fields keep addresses, customer names, messages and prices out of
  // the Lock Screen even if an API response gains more fields in the future.
  return { orderId: v.orderId, restaurantName: v.restaurantName as string, statusLabel: v.statusLabel as string, etaLabel: v.etaLabel as string, etaUnix: v.etaUnix as number | null, fulfillment: v.fulfillment as "delivery" | "collection", updatedAtUnix: v.updatedAtUnix };
}
export function eligibleLiveOrder(value: unknown, now = Date.now()): LiveOrderCandidate | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>, content = parseLiveOrderContent(v.content), created = Date.parse(String(v.createdAt)), scheduled = v.scheduledFor == null ? null : Date.parse(String(v.scheduledFor));
  if (!content || v.orderId !== content.orderId || !Number.isFinite(created) || created < now - LIVE_ACTIVITY_LIFETIME_MS || created > now + 60_000 || scheduled !== null && (!Number.isFinite(scheduled) || scheduled > now + 2 * 60 * 60 * 1000) || typeof v.serverRevision !== "number" || !Number.isSafeInteger(v.serverRevision) || v.serverRevision < 0) return null;
  return { orderId: content.orderId, createdAt: String(v.createdAt), scheduledFor: v.scheduledFor == null ? null : String(v.scheduledFor), serverRevision: v.serverRevision, content };
}
export function parseLiveActivityBindings(value: unknown, now = Date.now()): LiveActivityBinding[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-40).filter(v => v && typeof v === "object" && uuid.test(v.orderId) && uuid.test(v.userId) && (v.activityId === null || typeof v.activityId === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(v.activityId)) && Number.isFinite(v.startedAt) && Number.isFinite(v.expiresAt) && v.expiresAt > now && v.expiresAt <= v.startedAt + LIVE_ACTIVITY_LIFETIME_MS && typeof v.suppressed === "boolean").map(v => ({ activityId: v.activityId, orderId: v.orderId, userId: v.userId, startedAt: v.startedAt, expiresAt: v.expiresAt, suppressed: v.suppressed, serverRevision: Number.isSafeInteger(v.serverRevision) ? v.serverRevision : 0 }));
}
export function parseLiveActivityOrderLink(raw: string): string | null {
  try { const u = new URL(raw); return u.protocol === "caleats:" && u.hostname === "order" && !u.port && !u.username && !u.password && !u.search && !u.hash && uuid.test(u.pathname.slice(1)) && u.pathname.split("/").length === 2 ? u.pathname.slice(1) : null; } catch { return null; }
}
export const sameLiveActivityIdentity = (a: LiveActivityIdentity | null, b: LiveActivityIdentity | null) => a === b || Boolean(a && b && a.token === b.token && a.userId === b.userId && a.installationId === b.installationId);
export const isLiveActivityAuthError = (error: unknown) => Boolean(error && typeof error === "object" && [401, 403].includes(Number((error as { status?: number }).status)));
export const validActivityPushToken = (token: unknown): token is string => typeof token === "string" && /^[a-f0-9]{32,512}$/i.test(token);
export function liveOrderPaymentEligible(order: { paymentMethod: string; paymentStatus: string }): boolean {
  return order.paymentMethod === "cash" ? order.paymentStatus === "cash_due" : order.paymentMethod === "mock_card" ? ["mock_authorized", "mock_captured"].includes(order.paymentStatus) : order.paymentMethod === "card" ? ["stripe_authorized", "stripe_captured"].includes(order.paymentStatus) : order.paymentMethod === "voucher" && ["voucher_reserved", "voucher_redeemed"].includes(order.paymentStatus);
}
