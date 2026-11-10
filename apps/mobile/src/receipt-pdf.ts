import { API_BASE_URL, ApiError } from "./api.ts";

export const RECEIPT_PDF_MAX_BYTES = 2 * 1024 * 1024;

export async function loadReceiptPdf({ token, orderId, signal, isCurrent }: { token: string; orderId: string; signal: AbortSignal; isCurrent: () => boolean }): Promise<Uint8Array | null> {
  if (!isCurrent() || signal.aborted) return null;
  if (!token.trim()) throw new ApiError("Please sign in again to download your receipt.", 401, "AUTH_REQUIRED");
  if (!API_BASE_URL) throw new ApiError("Cal-Eats is temporarily unavailable. Please try again shortly.", 0, "API_NOT_CONFIGURED");
  const controller = new AbortController(), abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 15_000);
  try {
    const response = await fetch(`${API_BASE_URL}/api/orders/${encodeURIComponent(orderId)}/receipt.pdf`, {
      method: "GET", headers: { Accept: "application/pdf", Authorization: `Bearer ${token}` },
      credentials: "omit", redirect: "error", cache: "no-store", signal: controller.signal,
    });
    if (!isCurrent() || signal.aborted) return null;
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
      throw new ApiError(String(payload?.error?.message || "We couldn’t download your receipt. Please try again."), response.status, payload?.error?.code);
    }
    const length = Number(response.headers.get("Content-Length") || 0);
    if (length > RECEIPT_PDF_MAX_BYTES) throw new ApiError("This receipt is too large to share. Please contact support.", 0, "RECEIPT_TOO_LARGE");
    if (response.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/pdf") throw new ApiError("We couldn’t open this receipt. Please try again.", 0, "INVALID_RECEIPT");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!isCurrent() || signal.aborted) return null;
    if (bytes.length > RECEIPT_PDF_MAX_BYTES) throw new ApiError("This receipt is too large to share. Please contact support.", 0, "RECEIPT_TOO_LARGE");
    if (bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") throw new ApiError("We couldn’t open this receipt. Please try again.", 0, "INVALID_RECEIPT");
    return bytes;
  } catch (error) {
    if (!isCurrent() || signal.aborted) return null;
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) throw new ApiError("The receipt download timed out. Check your connection and try again.", 0, "TIMEOUT");
    throw new ApiError("Could not download your receipt. Check your connection and try again.", 0, "NETWORK_ERROR");
  } finally { clearTimeout(timeout); signal.removeEventListener("abort", abort); }
}
