export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers, credentials: "include" });
  const type = response.headers.get("content-type") || "";
  const body = type.includes("json") ? await response.json() : await response.text();
  if (!response.ok) {
    const detail = body?.error || body;
    throw new ApiError(detail?.message || `Request failed (${response.status})`, response.status, detail?.code);
  }
  return body?.data ?? body;
}

export function json(method, body, idempotencyKey) {
  const headers = {};
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  return { method, headers, body: JSON.stringify(body ?? {}) };
}

export function newKey(prefix = "portal") {
  return `${prefix}-${crypto.randomUUID()}`;
}
