import { validateBase, type Envelope } from "./model";

export const API_BASE = validateBase(process.env.EXPO_PUBLIC_API_BASE_URL?.trim() || "");
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}
type Options = RequestInit & { token?: string | null; idempotencyKey?: string };
export async function request<T>(path: string, options: Options = {}): Promise<Envelope<T>> {
  if (!API_BASE) throw new ApiError("Set the Cal-Eats API address before opening the business app.", 0, "API_NOT_CONFIGURED");
  if (!path.startsWith("/api/") || path.startsWith("//")) throw new ApiError("This request is outside Cal-Eats.", 0, "INVALID_PATH");
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${API_BASE}${path}`, { ...options, headers, credentials: "omit", redirect: "error", signal: controller.signal });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new ApiError(payload?.error?.message || `Could not complete the request (${response.status}).`, response.status, payload?.error?.code || "API_ERROR");
    if (!payload || !Object.prototype.hasOwnProperty.call(payload, "data")) throw new ApiError("Cal-Eats returned an incomplete response. Please refresh.", response.status, "INVALID_RESPONSE");
    return payload as Envelope<T>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError((error as Error).name === "AbortError" ? "The request timed out. Refresh to check the latest result." : "Could not reach Cal-Eats. Your unsent text is still here.", 0, "NETWORK_ERROR");
  } finally { clearTimeout(timer); }
}
export async function api<T>(path: string, options: Options = {}): Promise<T> { return (await request<T>(path, options)).data; }
export async function dashboardCsv({ restaurantId, period, kind, token, signal }: { restaurantId: string; period: "today" | "yesterday" | "this_week" | "last_week"; kind: "metrics" | "orders"; token: string; signal?: AbortSignal }) {
  if (!API_BASE) throw new ApiError("The Cal-Eats service address is unavailable.", 0, "API_NOT_CONFIGURED");
  if (!/^[A-Za-z0-9-]{1,100}$/.test(restaurantId) || !["today", "yesterday", "this_week", "last_week"].includes(period) || !["metrics", "orders"].includes(kind) || !token) throw new ApiError("This dashboard export is unavailable.", 0, "INVALID_EXPORT");
  const maxBytes = 256 * 1024;
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener("abort", abort);
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 20000);
  const url = `${API_BASE}/api/restaurant/restaurants/${restaurantId}/dashboard/${kind}.csv?period=${period}`;
  const tooLarge = () => new ApiError("This export is too large to share on your phone. Download it from the tablet or browser dashboard.", 413, "EXPORT_TOO_LARGE");
  try {
    const response = await fetch(url, { method: "GET", headers: { Accept: "text/csv", Authorization: `Bearer ${token}` }, credentials: "omit", redirect: "error", signal: controller.signal });
    if (response.redirected || (response.url && response.url !== url)) throw new ApiError("Cal-Eats returned an unexpected export address. Please refresh.", 0, "INVALID_RESPONSE");
    if (!response.ok) { const payload = await response.json().catch(() => null); throw new ApiError(payload?.error?.message || "The CSV could not be prepared. Please try again.", response.status, payload?.error?.code || "EXPORT_ERROR"); }
    if (!response.headers.get("content-type")?.toLowerCase().includes("text/csv")) throw new ApiError("The CSV is unavailable. Please refresh and try again.", response.status, "INVALID_RESPONSE");
    const declaredBytes = Number(response.headers.get("content-length"));
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes <= 0) throw new ApiError("The CSV download could not be checked. Please use the tablet or browser dashboard.", 0, "INVALID_RESPONSE");
    if (declaredBytes > maxBytes) throw tooLarge();
    const csv = await response.text();
    if (csv.length > maxBytes || new Blob([csv]).size > maxBytes) throw tooLarge();
    if (controller.signal.aborted) throw new ApiError("The export was cancelled. Please try again.", 0, "EXPORT_CANCELLED");
    const filename = response.headers.get("content-disposition")?.match(/filename="([A-Za-z0-9._-]+\.csv)"/)?.[1] || `Cal-Eats-${kind}-${period}.csv`;
    return { csv, filename };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError((error as Error).name === "AbortError" ? "The export took too long or was cancelled. Please try again." : "Could not download the CSV. Check your connection and try again.", 0, "EXPORT_ERROR");
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
export const json = (token: string, method: string, body: unknown, key?: string): Options => ({ token, method, body: JSON.stringify(body), idempotencyKey: key });
export function mediaUrl(path?: string | null) {
  if (!path || !API_BASE) return undefined;
  try { const resolved = new URL(path, API_BASE); return resolved.origin === API_BASE && !resolved.username && !resolved.password ? resolved.toString() : undefined; } catch { return undefined; }
}
