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
export const json = (token: string, method: string, body: unknown, key?: string): Options => ({ token, method, body: JSON.stringify(body), idempotencyKey: key });
export function mediaUrl(path?: string | null) {
  if (!path || !API_BASE) return undefined;
  try { const resolved = new URL(path, API_BASE); return resolved.origin === API_BASE && !resolved.username && !resolved.password ? resolved.toString() : undefined; } catch { return undefined; }
}
