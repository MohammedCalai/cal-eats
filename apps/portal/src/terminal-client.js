const LOCAL_ORIGIN = "http://127.0.0.1:17864";
const PRODUCT = "calai-business-terminal";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROOF = /^[A-Za-z0-9_-]{43}$/;
const MAX_BODY = 64 * 1024, MAX_RESPONSE = 1024 * 1024, RENEW_BEFORE_MS = 65000;
const utf8Length = value => new TextEncoder().encode(value).length;
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const bounded = (value, length) => typeof value === "string" && value.length <= length && !/[\u0000-\u001f\u007f]/.test(value);
const clone = value => value === null ? null : JSON.parse(JSON.stringify(value));

function failure(message, status, code, retryable = false) {
  return Object.assign(new Error(message), { name: "ApiError", status, code, terminal: true, retryable });
}
function changed() { return failure("The restaurant tablet connection changed. Reconnect it before continuing.", 409, "TERMINAL_CONTEXT_CHANGED", true); }
function aborted() { return failure("The restaurant tablet request was cancelled.", 0, "TERMINAL_ABORTED", true); }
function waitForCaller(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const stop = () => { cleanup(); reject(aborted()); };
    const cleanup = () => signal.removeEventListener("abort", stop);
    signal.addEventListener("abort", stop, { once: true });
    promise.then(value => { cleanup(); if (!signal.aborted) resolve(value); }, error => { cleanup(); reject(error); });
  });
}
function validJson(value, depth = 0) {
  if (depth > 12) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 10000 && value.every(item => validJson(item, depth + 1));
  return plain(value) && Object.keys(value).length <= 1000 && Object.entries(value).every(([key, item]) => bounded(key, 200) && validJson(item, depth + 1));
}
function productState(value) {
  if (!plain(value) || typeof value.active !== "boolean") throw failure("Update the restaurant tablet connection.", 502, "TERMINAL_LOCAL_INVALID");
  const result = { active: value.active };
  if (typeof value.linked === "boolean") result.linked = value.linked;
  if (["active", "inactive", "unlinked"].includes(value.status)) result.status = value.status;
  if (value.sourceAccountId === null || bounded(value.sourceAccountId, 100)) result.sourceAccountId = value.sourceAccountId;
  if (bounded(value.connectionStatus, 64)) result.connectionStatus = value.connectionStatus;
  if (value.authExpiresAt === null || bounded(value.authExpiresAt, 40) && Number.isFinite(Date.parse(value.authExpiresAt))) result.authExpiresAt = value.authExpiresAt;
  return result;
}
function safeContext(value, screenId, now) {
  if (!plain(value) || value.principalKind !== "terminal" || !UUID.test(value.terminalId) || !UUID.test(value.businessId) || value.restaurantId !== null && !UUID.test(value.restaurantId) || !plain(value.user) || value.user.role !== "restaurant" || !UUID.test(value.user.id) || !bounded(value.user.name, 120) || !plain(value.products) || !bounded(value.expiresAt, 40) || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now || Date.parse(value.expiresAt) > now + 24 * 3600000 || value.screenId !== undefined && value.screenId !== screenId) {
    throw failure("The restaurant tablet identity could not be verified.", 502, "TERMINAL_LOCAL_INVALID");
  }
  const products = {};
  for (const key of ["calai", "cal-eats"]) if (Object.hasOwn(value.products, key)) products[key] = productState(value.products[key]);
  if (!Object.keys(products).length) throw failure("The restaurant tablet services could not be verified.", 502, "TERMINAL_LOCAL_INVALID");
  const user = { id: value.user.id, name: value.user.name, role: "restaurant" };
  if (bounded(value.user.email, 254)) user.email = value.user.email;
  return { user, principalKind: "terminal", terminalId: value.terminalId, businessId: value.businessId, restaurantId: value.restaurantId, products, expiresAt: value.expiresAt, screenId };
}
function allowedPath(target, method, context) {
  if (typeof target !== "string" || target.length > 4096 || !target.startsWith("/api/") || /[\\#\u0000-\u0020\u007f]/.test(target)) return false;
  const pathname = target.split("?")[0];
  if (pathname.includes("%") || pathname.includes("//")) return false;
  let url;
  try { url = new URL(target, "https://terminal.invalid"); } catch { return false; }
  if (`${url.pathname}${url.search}` !== target || url.origin !== "https://terminal.invalid") return false;
  if (pathname === "/api/auth/me") return method === "GET" && !url.search;
  const businessMatch = /^\/api\/business\/businesses\/([^/]+)(?:\/|$)/.exec(pathname);
  if (businessMatch && businessMatch[1] !== context.businessId) return false;
  if (pathname.startsWith("/api/business/")) {
    if (/\/calai(?:\/|$)/.test(pathname) && context.products.calai?.active !== true) return false;
  } else if (pathname === "/api/restaurant/restaurants" || pathname.startsWith("/api/restaurant/") || /^\/api\/(?:orders|print-jobs)\//.test(pathname)) {
    if (!context.restaurantId || context.products["cal-eats"]?.linked !== true) return false;
    const match = /^\/api\/restaurant\/restaurants\/([^/]+)(?:\/|$)/.exec(pathname);
    if (match && match[1] !== context.restaurantId) return false;
  } else if (!/^\/api\/notifications(?:\/|$)/.test(pathname)) return false;
  for (const key of ["businessId", "business_id"]) if (url.searchParams.has(key) && url.searchParams.getAll(key).some(value => value !== context.businessId)) return false;
  for (const key of ["restaurantId", "restaurant_id"]) if (url.searchParams.has(key) && url.searchParams.getAll(key).some(value => value !== context.restaurantId)) return false;
  return true;
}
function requestEnvelope(path, options, context) {
  const method = String(options.method || "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) || !allowedPath(path, method, context)) throw failure("This operation is not available through the restaurant tablet.", 403, "TERMINAL_OPERATION_DENIED");
  let headers;
  try { headers = new Headers(options.headers || {}); } catch { throw failure("The tablet request headers are invalid.", 400, "TERMINAL_HEADER_INVALID"); }
  for (const [name, value] of headers) {
    if (!["accept", "content-type", "idempotency-key"].includes(name) || name === "content-type" && !/^application\/json(?:;\s*charset=utf-8)?$/i.test(value)) throw failure("The tablet request contains an unsupported header.", 400, "TERMINAL_HEADER_DENIED");
  }
  const forwarded = {};
  if (headers.has("Idempotency-Key")) {
    const key = headers.get("Idempotency-Key");
    if (!/^[A-Za-z0-9_.:-]{8,200}$/.test(key)) throw failure("The request identifier is invalid.", 400, "TERMINAL_IDEMPOTENCY_INVALID");
    forwarded["Idempotency-Key"] = key;
  }
  let body = null;
  if (options.body !== undefined && options.body !== null) {
    if (method === "GET") throw failure("A tablet read cannot contain a body.", 400, "TERMINAL_BODY_INVALID");
    try { body = typeof options.body === "string" ? JSON.parse(options.body) : options.body; }
    catch { throw failure("The tablet request must contain valid JSON.", 400, "TERMINAL_BODY_INVALID"); }
    if (!validJson(body)) throw failure("The tablet request must contain bounded JSON data.", 400, "TERMINAL_BODY_INVALID");
  }
  if (plain(body) && (Object.hasOwn(body, "businessId") && body.businessId !== context.businessId || Object.hasOwn(body, "restaurantId") && body.restaurantId !== context.restaurantId)) throw failure("The request belongs to another restaurant.", 403, "TERMINAL_SCOPE_MISMATCH");
  const value = { method, path, body, headers: forwarded };
  if (utf8Length(JSON.stringify(value)) > MAX_BODY) throw failure("The tablet request is too large.", 413, "TERMINAL_BODY_TOO_LARGE");
  return value;
}
async function readJson(response) {
  if (!/application\/json/i.test(response.headers.get("content-type") || "") || Number(response.headers.get("content-length") || 0) > MAX_RESPONSE) throw failure("The tablet connection returned an invalid response.", 502, "TERMINAL_LOCAL_INVALID");
  let text = "", size = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader(), decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE) { await reader.cancel(); throw failure("The tablet response is too large.", 502, "TERMINAL_LOCAL_INVALID"); }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
  } else {
    text = await response.text();
    if (utf8Length(text) > MAX_RESPONSE) throw failure("The tablet response is too large.", 502, "TERMINAL_LOCAL_INVALID");
  }
  try { return JSON.parse(text); } catch { throw failure("The tablet connection returned invalid JSON.", 502, "TERMINAL_LOCAL_INVALID"); }
}

export function createAutomaticTerminalClient({ fetchImpl = (...args) => globalThis.fetch(...args), clock = Date.now, screenIdFactory = () => globalThis.crypto.randomUUID(), timeoutMs = 10000, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let generation = 0, csrfToken = null, windowProof = null, context = null, currentScreenId = null, connecting = null;
  let state = { status: "unchecked", terminalId: null, paired: null, errorCode: null };
  const requests = new Set();
  function invalidate(status, code = null) {
    generation++; csrfToken = null; windowProof = null; context = null;
    for (const controller of requests) controller.abort(changed());
    state = { ...state, status, errorCode: code };
  }
  const assertCurrent = expected => { if (expected !== generation) throw changed(); };
  function failed(error, stage, expected) {
    if (expected !== generation || error.code === "TERMINAL_CONTEXT_CHANGED") return;
    if (error.code === "TERMINAL_ABORTED") { invalidate("unchecked", error.code); return; }
    const revoked = /(?:TABLET|TERMINAL)_(?:REVOKED|DISABLED)/.test(error.code || "");
    const unpaired = /(?:TABLET_NOT_ENROLLED|TERMINAL_NOT_PAIRED)/.test(error.code || "");
    const missing = stage === "bootstrap" && state.paired !== true && error.code === "TERMINAL_LOCAL_UNAVAILABLE";
    invalidate(revoked ? "revoked" : unpaired ? "unpaired" : missing ? "not_installed" : "offline", error.code);
    if (unpaired) state.paired = false;
  }
  async function local(route, body, { expected, signal, proof = null, csrf = csrfToken } = {}) {
    assertCurrent(expected);
    if (signal?.aborted) throw aborted();
    const controller = new AbortController(); requests.add(controller);
    const externalAbort = () => controller.abort(aborted());
    signal?.addEventListener("abort", externalAbort, { once: true });
    const timer = schedule(() => controller.abort(failure("The restaurant tablet connection took too long. Try reconnecting.", 0, "TERMINAL_TIMEOUT", true)), timeoutMs);
    let abortListener;
    const abortPromise = new Promise((_, reject) => { abortListener = () => reject(controller.signal.reason?.code ? controller.signal.reason : aborted()); controller.signal.addEventListener("abort", abortListener, { once: true }); });
    const work = (async () => {
      let response;
      try {
        response = await fetchImpl(`${LOCAL_ORIGIN}${route}`, { method: body === undefined ? "GET" : "POST", mode: "cors", credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal, headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json", "X-Calai-Terminal-CSRF": csrf, ...(proof ? { "X-Calai-Terminal-Window": proof } : {}) }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      } catch (error) { if (controller.signal.aborted) throw controller.signal.reason; throw failure("The local restaurant tablet connection is unavailable.", 0, "TERMINAL_LOCAL_UNAVAILABLE", true); }
      assertCurrent(expected); if (controller.signal.aborted) throw controller.signal.reason;
      const result = await readJson(response);
      assertCurrent(expected); if (controller.signal.aborted) throw controller.signal.reason;
      if (!response.ok) throw failure(bounded(result?.error?.message, 500) ? result.error.message : "The restaurant tablet request was not accepted.", response.status, bounded(result?.error?.code, 100) ? result.error.code : "TERMINAL_REQUEST_REJECTED", response.status >= 500 || response.status === 429);
      return result?.data ?? result;
    })();
    try { return await Promise.race([work, abortPromise]); }
    finally { cancel(timer); requests.delete(controller); signal?.removeEventListener("abort", externalAbort); controller.signal.removeEventListener("abort", abortListener); }
  }
  function connectAutomaticTerminal({ signal, screenId } = {}) {
    const selectedScreen = screenId || currentScreenId || screenIdFactory();
    if (!UUID.test(selectedScreen)) return Promise.reject(failure("The tablet screen identifier is invalid.", 400, "TERMINAL_SCREEN_INVALID"));
    if (signal?.aborted) return Promise.reject(aborted());
    if (connecting && connecting.screenId === selectedScreen && !connecting.signal?.aborted) return connecting.signal === signal ? connecting.promise : waitForCaller(connecting.promise, signal);
    if (windowProof && state.status === "ready" && currentScreenId === selectedScreen && Date.parse(context.expiresAt) > clock() + RENEW_BEFORE_MS) return Promise.resolve(clone(context));
    invalidate("connecting"); currentScreenId = selectedScreen;
    const expected = generation, attempt = { screenId: selectedScreen, signal, promise: null };
    attempt.promise = (async () => {
      let stage = "bootstrap";
      try {
        const bootstrap = await local("/v1/bootstrap", undefined, { expected, signal });
        assertCurrent(expected);
        if (!plain(bootstrap) || bootstrap.product !== PRODUCT || !PROOF.test(bootstrap.csrfToken) || typeof bootstrap.paired !== "boolean" || bootstrap.terminalId !== undefined && bootstrap.terminalId !== null && !UUID.test(bootstrap.terminalId)) throw failure("Update the restaurant tablet connection.", 502, "TERMINAL_LOCAL_INVALID");
        state = { ...state, terminalId: bootstrap.terminalId || null, paired: bootstrap.paired };
        if (!bootstrap.paired) throw failure("Register this restaurant tablet once before using automatic sign-in.", 403, "TABLET_NOT_ENROLLED");
        csrfToken = bootstrap.csrfToken; stage = "session";
        const result = await local("/v1/automatic-session", { screenId: selectedScreen }, { expected, signal });
        assertCurrent(expected);
        const safe = safeContext(result, selectedScreen, clock());
        if (!PROOF.test(result.windowProof) || safe.terminalId !== bootstrap.terminalId) throw failure("The restaurant tablet identity could not be verified.", 502, "TERMINAL_LOCAL_INVALID");
        context = safe; windowProof = result.windowProof;
        state = { status: "ready", paired: true, terminalId: safe.terminalId, errorCode: null };
        return clone(context);
      } catch (error) { failed(error, stage, expected); throw error; }
      finally { if (connecting === attempt) connecting = null; }
    })();
    connecting = attempt; return attempt.promise;
  }
  async function terminalApi(path, options = {}) {
    if (windowProof && context && Date.parse(context.expiresAt) <= clock() + RENEW_BEFORE_MS) await connectAutomaticTerminal({ signal: options.signal });
    if (!windowProof || !context || state.status !== "ready") throw failure("Reconnect the registered restaurant tablet to continue.", 401, "TERMINAL_SESSION_REQUIRED", true);
    const envelope = requestEnvelope(path, options, context), expected = generation, proof = windowProof;
    try { return await local("/v1/request", envelope, { expected, signal: options.signal, proof }); }
    catch (error) {
      const operationDenied = ["TABLET_OPERATION_DENIED", "TERMINAL_OPERATION_DENIED", "OWNER_REQUIRED", "FORBIDDEN","PRODUCT_INACTIVE","PRODUCT_DISABLED","ADMIN_CONNECTION_PERMISSION_REQUIRED","CAL_EATS_DISABLED","BUSINESS_LINK_CHANGED","CALAI_RECONNECT_REQUIRED"].includes(error.code);
      if (!operationDenied && error.code !== "TERMINAL_ABORTED" && (error.status === 401 || error.status === 403 || error.status === 0 || error.code === "TERMINAL_LOCAL_INVALID" || error.status >= 500)) failed(error, "request", expected);
      throw error;
    }
  }
  function disconnectLocalTerminal() { invalidate("unchecked"); connecting = null; }
  function terminalStatus() { return { ...state, context: clone(context), expiresAt: context?.expiresAt || null }; }
  return { connectAutomaticTerminal, terminalApi, disconnectLocalTerminal, terminalStatus };
}

const automatic = createAutomaticTerminalClient();
export const connectAutomaticTerminal = options => automatic.connectAutomaticTerminal(options);
export const terminalApi = (path, options) => automatic.terminalApi(path, options);
export const disconnectLocalTerminal = () => automatic.disconnectLocalTerminal();
export const terminalStatus = () => automatic.terminalStatus();
export const terminalCanRequest = (path,method='GET') => {const state=automatic.terminalStatus();return state.status==='ready'&&state.context&&allowedPath(path,String(method).toUpperCase(),state.context);};
