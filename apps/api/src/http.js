export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

const requestBodies = new WeakMap();
export function cachedRequestBody(req) { return requestBodies.get(req)?.body; }
export async function readRequestBody(req, limit) {
  const saved = requestBodies.get(req);
  if (saved) return saved.body ?? saved.pending;
  const state = {};
  requestBodies.set(req, state);
  state.pending = (async () => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) { req.resume(); throw new HttpError(413, "BODY_TOO_LARGE", "Request body is too large"); }
    chunks.push(chunk);
  }
    state.body = Buffer.concat(chunks);
    return state.body;
  })();
  return state.pending;
}

export async function readJson(req, limit) {
  if (req.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  const body = await readRequestBody(req, limit);
  try { return JSON.parse(body.toString("utf8")); }
  catch { throw new HttpError(400, "INVALID_JSON", "Request body must be valid JSON"); }
}

export function exactObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) throw new HttpError(400, "VALIDATION_ERROR", "Request body has invalid fields");
}
