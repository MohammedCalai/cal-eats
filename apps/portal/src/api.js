import {terminalCanRequest,terminalApi} from './terminal-client.js';
let businessApiPrincipal='human';
export function setBusinessApiPrincipal(value){if(!['human','terminal'].includes(value))throw new TypeError('Invalid business principal');businessApiPrincipal=value;}
export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export async function api(path, options = {}) {
  const operational=/^\/api\/restaurant\/orders\/[^/]+\/(?:status|preparation)$/.test(path)||/^\/api\/restaurant\/restaurants\/[^/]+\/printers\/[^/]+\/(?:test-receipt|reprints|jobs\/[^/]+\/check)$/.test(path)||/^\/api\/business\/accounts\/[^/]+\/surface\/heartbeat$/.test(path);
  if(!options.humanSession&&(businessApiPrincipal==='terminal'||operational)&&terminalCanRequest(path,options.method??'GET'))return terminalApi(path,options);
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const {humanSession,...requestOptions}=options;
  const response = await fetch(path, { ...requestOptions, headers, credentials: "include" });
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

export function markOrderMessagesRead(orderId,lastMessageId) {
  const path = `/api/orders/${encodeURIComponent(orderId)}/messages`;
  if (businessApiPrincipal === "terminal") return terminalApi(path,json("POST",{action:"markRead",lastMessageId}));
  return api(path + "/read",{...json("POST",{lastMessageId}),humanSession:true});
}

export function newKey(prefix = "portal") {
  return `${prefix}-${crypto.randomUUID()}`;
}
