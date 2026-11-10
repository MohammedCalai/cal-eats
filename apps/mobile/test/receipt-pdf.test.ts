import assert from "node:assert/strict";
import test from "node:test";

const previousBase = process.env.EXPO_PUBLIC_API_BASE_URL;
process.env.EXPO_PUBLIC_API_BASE_URL = "https://eats.calai.info";
const { loadReceiptPdf, RECEIPT_PDF_MAX_BYTES } = await import("../src/receipt-pdf.ts");
if (previousBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL; else process.env.EXPO_PUBLIC_API_BASE_URL = previousBase;

const options = () => ({ token: "private-customer-session", orderId: "order/one", signal: new AbortController().signal, isCurrent: () => true });
const pdf = () => new Response("%PDF-1.7\nreceipt", { headers: { "Content-Type": "application/pdf" } });

test("receipt requests use a bearer header and return PDF bytes without putting the session in a URL", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(url, "https://eats.calai.info/api/orders/order%2Fone/receipt.pdf");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Authorization"), "Bearer private-customer-session");
      assert.equal(headers.get("Accept"), "application/pdf");
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.cache, "no-store");
      return pdf();
    }) as typeof fetch;
    const bytes = await loadReceiptPdf(options());
    assert.equal(new TextDecoder().decode(bytes!), "%PDF-1.7\nreceipt");
  } finally { globalThis.fetch = originalFetch; }
});

test("a receipt response cannot reach file sharing after an account switch", async () => {
  const originalFetch = globalThis.fetch;
  let finish!: (value: ArrayBuffer) => void, current = true;
  try {
    const response = pdf(), body = new Promise<ArrayBuffer>(resolve => { finish = resolve; });
    response.arrayBuffer = () => body;
    globalThis.fetch = (async () => response) as typeof fetch;
    const pending = loadReceiptPdf({ ...options(), isCurrent: () => current });
    await Promise.resolve();
    current = false;
    finish(new TextEncoder().encode("%PDF-1.7\nprevious customer").buffer);
    assert.equal(await pending, null);
  } finally { globalThis.fetch = originalFetch; }
});

test("closing a receipt aborts the pending download and discards its result", async () => {
  const originalFetch = globalThis.fetch, controller = new AbortController();
  try {
    let requestedSignal: AbortSignal | undefined;
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      requestedSignal = init?.signal || undefined;
      requestedSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })) as typeof fetch;
    const pending = loadReceiptPdf({ ...options(), signal: controller.signal });
    controller.abort();
    assert.equal(requestedSignal?.aborted, true);
    assert.equal(await pending, null);
  } finally { globalThis.fetch = originalFetch; }
});

test("PDF sharing rejects non-PDF and oversized payloads before creating a file", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const response of [
      new Response("<html>Sign in</html>", { headers: { "Content-Type": "text/html" } }),
      new Response("not a PDF", { headers: { "Content-Type": "application/pdf" } }),
      new Response("%PDF-1.7", { headers: { "Content-Type": "application/pdf", "Content-Length": String(RECEIPT_PDF_MAX_BYTES + 1) } }),
      new Response(new Uint8Array(RECEIPT_PDF_MAX_BYTES + 1), { headers: { "Content-Type": "application/pdf" } }),
    ]) {
      globalThis.fetch = (async () => response) as typeof fetch;
      await assert.rejects(loadReceiptPdf(options()), error => ["INVALID_RECEIPT", "RECEIPT_TOO_LARGE"].includes((error as { code: string }).code));
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("a receipt that is not ready reports the authenticated API error", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: "RECEIPT_NOT_READY", message: "Receipts are available for completed orders." } }), { status: 409, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    await assert.rejects(loadReceiptPdf(options()), error => (error as { code: string; status: number }).code === "RECEIPT_NOT_READY" && (error as { status: number }).status === 409);
  } finally { globalThis.fetch = originalFetch; }
});
