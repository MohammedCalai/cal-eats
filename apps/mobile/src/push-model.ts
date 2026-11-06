export type CustomerPushTarget = {
  notificationId: string;
  recipientUserId: string;
  kind: "order" | "conversation" | "offers" | "support" | "account";
  orderId?: string;
  conversationId?: string;
  offerId?: string;
  supportCaseId?: string;
};
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
export function parseCustomerPushTarget(data: unknown): CustomerPushTarget | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  if (!identifier(value.notificationId) || !identifier(value.recipientUserId) || typeof value.kind !== "string" || !["order", "conversation", "offers", "support", "account"].includes(value.kind)) return null;
  for (const field of ["orderId", "conversationId", "offerId", "supportCaseId"] as const) if (value[field] !== undefined && !identifier(value[field])) return null;
  if (value.kind === "order" && !value.orderId || value.kind === "conversation" && !value.conversationId || value.kind === "support" && !value.supportCaseId) return null;
  return { notificationId: value.notificationId, recipientUserId: value.recipientUserId, kind: value.kind as CustomerPushTarget["kind"], ...Object.fromEntries(["orderId", "conversationId", "offerId", "supportCaseId"].filter(field => value[field] !== undefined).map(field => [field, value[field]])) };
}

export function customerPushProject(projectId: unknown, platform: string): string | null {
  if (projectId === "5bf59184-c670-44f4-be78-5229cbd02300" && ["ios", "android"].includes(platform)) return projectId;
  if (projectId === "f76a2adf-34ca-438a-9208-bdb5d4e65ded" && platform === "android") return projectId;
  return null;
}

export function createCustomerPushTapQueue() {
  let pending: { key: string; target: CustomerPushTarget } | null = null;
  const handled = new Set<string>();
  function remember(key: string) { handled.add(key); if (handled.size > 100) handled.delete(handled.values().next().value!); }
  return {
    receive(key: string, data: unknown) {
      const target = parseCustomerPushTarget(data);
      if (!target || handled.has(key)) return false;
      pending = { key, target }; return true;
    },
    take(userId: string | null, blocked: boolean) {
      if (!pending || !userId || blocked) return null;
      const result = pending; pending = null; remember(result.key);
      return result.target.recipientUserId === userId ? result : null;
    },
    waitingKey() { return pending?.key ?? null; },
    clear() { if (pending) remember(pending.key); pending = null; }
  };
}
