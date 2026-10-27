const RAW_BASE = process.env.EXPO_PUBLIC_API_BASE_URL?.trim().replace(/\/$/, "") ?? "";

export function validateBase(raw: string): string {
  if (!raw) return "";
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("EXPO_PUBLIC_API_BASE_URL must be a complete URL."); }
  if (url.username || url.password || url.search || url.hash) throw new Error("The API URL cannot contain credentials, a query or a fragment.");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const unbracketed = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (hostname !== "eats.calai.info" && (hostname === "calai.info" || hostname.endsWith(".calai.info"))) throw new Error("The original Calai host is not permitted.");
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(unbracketed);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("Use HTTPS, except for an explicit loopback development API.");
  return url.toString().replace(/\/$/, "");
}

export const API_BASE_URL = validateBase(RAW_BASE);

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code = "API_ERROR") { super(message); this.status = status; this.code = code; }
}

type ApiOptions = RequestInit & { token?: string | null; idempotencyKey?: string };
export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  if (!API_BASE_URL) throw new ApiError("Set EXPO_PUBLIC_API_BASE_URL to this independent Cal-Eats API before using the app.", 0, "API_NOT_CONFIGURED");
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers, signal: controller.signal, credentials: "omit", redirect: "error" });
    const payload = await response.json().catch(() => null) as { data?: T; error?: { code?: string; message?: string } } | null;
    if (!response.ok) throw new ApiError(payload?.error?.message ?? `Request failed (${response.status}).`, response.status, payload?.error?.code);
    if (!payload || !Object.prototype.hasOwnProperty.call(payload, "data")) throw new ApiError("The API returned a malformed response.", response.status, "MALFORMED_RESPONSE");
    return payload.data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if ((error as Error).name === "AbortError") throw new ApiError("The request timed out. Check the local API and try again.", 0, "TIMEOUT");
    throw new ApiError("Could not reach the configured Cal-Eats API.", 0, "NETWORK_ERROR");
  } finally { clearTimeout(timeout); }
}

export function absoluteMediaUrl(path?: string | null): string | undefined {
  if (!path) return undefined;
  if (!API_BASE_URL) return undefined;
  try {
    const resolved = new URL(path, `${API_BASE_URL}/`);
    if (resolved.origin !== new URL(API_BASE_URL).origin || resolved.username || resolved.password) return undefined;
    return resolved.toString();
  } catch { return undefined; }
}
