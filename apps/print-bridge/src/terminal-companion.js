import crypto from "node:crypto";
import http from "node:http";

const VERSION = "1.0.0";
function equalToken(a, b) { return typeof a === "string" && /^[A-Za-z0-9_-]{43}$/.test(a) && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function reply(response, status, data) { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(JSON.stringify(data)); }
async function readBody(request) {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] || "")) throw new Error("Use JSON for the tablet connection");
  let length = 0; const chunks = [];
  for await (const chunk of request) { length += chunk.length; if (length > 64 * 1024) throw new Error("Tablet request is too large"); chunks.push(chunk); }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid tablet request");
  return value;
}

export function createCompanionServer({ client, port = 17863, allowedOrigins = ["https://eats.calai.info"], csrfToken = crypto.randomBytes(32).toString("base64url") }) {
  if (!Array.isArray(allowedOrigins) || !allowedOrigins.length || allowedOrigins.some(origin => new URL(origin).origin !== origin || !["https://eats.calai.info"].includes(origin) && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin))) throw new Error("Companion origins must be exact Cal-Eats or explicit loopback origins");
  const origins = new Set(allowedOrigins);
  let windowStart = 0, requests = 0;
  const server = http.createServer(async (request, response) => {
    const actualPort = server.address()?.port ?? port;
    // Both checks are mandatory, including bootstrap and preflight: stops DNS
    // rebinding, arbitrary sites, extension/background no-Origin requests and
    // forged browser calls before reading any body or touching the device key.
    if (request.headers.host !== `127.0.0.1:${actualPort}` || !origins.has(request.headers.origin) || !["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress)) return reply(response, 403, { error: { code: "LOCAL_ORIGIN_DENIED", message: "Open the Cal-Eats business platform to connect this tablet" } });
    response.setHeader("Access-Control-Allow-Origin", request.headers.origin);
    response.setHeader("Vary", "Origin");
    if (request.method === "OPTIONS") {
      const headers = (request.headers["access-control-request-headers"] || "").toLowerCase().split(",").map(value => value.trim()).filter(Boolean);
      if (!["GET", "POST"].includes(request.headers["access-control-request-method"]) || headers.some(value => !["content-type", "x-cal-eats-csrf","x-cal-eats-user-proof"].includes(value))) return reply(response, 403, { error: { code: "LOCAL_PREFLIGHT_DENIED" } });
      response.setHeader("Access-Control-Allow-Methods", "GET, POST"); response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Cal-Eats-CSRF, X-Cal-Eats-User-Proof");
      if (request.headers["access-control-request-private-network"] === "true") response.setHeader("Access-Control-Allow-Private-Network", "true");
      response.writeHead(204); return response.end();
    }
    if (Date.now() - windowStart > 60_000) { windowStart = Date.now(); requests = 0; }
    if (++requests > 180) return reply(response, 429, { error: { code: "LOCAL_RATE_LIMIT" } });
    if (request.method === "GET" && request.url === "/v1/bootstrap") return reply(response, 200, { product: "cal-eats-terminal", version: VERSION, terminalId: client.identity?.terminalId || null, paired: client.paired, csrfToken });
    if (request.method !== "POST" || !equalToken(request.headers["x-cal-eats-csrf"], csrfToken)) return reply(response, 403, { error: { code: "LOCAL_CSRF_REQUIRED" } });
    try {
      const body = await readBody(request);
      const user={userProof:request.headers["x-cal-eats-user-proof"]};
      let result;
      if (request.url === "/v1/pair") result = await client.pair(body);
      else if (request.url === "/v1/session") result = await client.connectSession(body);
      else if (request.url === "/v1/screen-heartbeat") result = await client.screenHeartbeat(body,user);
      else if (request.url === "/v1/request") result = await client.forward(body,user);
      else if (request.url === "/v1/disconnect") result = client.disconnect(user);
      else return reply(response, 404, { error: { code: "LOCAL_ROUTE_NOT_FOUND" } });
      reply(response, 200, { data: result });
    } catch (error) { reply(response, error.status && [401, 403, 409, 429].includes(error.status) ? error.status : 400, { error: { code: error.code || "LOCAL_REQUEST_REJECTED", message: error instanceof SyntaxError ? "Invalid tablet request" : error.message } }); }
  });
  server.headersTimeout = 10_000; server.requestTimeout = 10_000; server.keepAliveTimeout = 2_000; server.maxConnections = 16;
  return server;
}

export async function startCompanion({ client, port = 17863, allowedOrigins, signal, diagnostics = null, heartbeatIntervalMs = 15_000, logger }) {
  const server = createCompanionServer({ client, port, allowedOrigins });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  let active = false;
  const pulse = async () => {
    if (active || signal?.aborted || !client.paired) return;
    active = true;
    try { await client.heartbeat(); if (diagnostics) await client.health(await diagnostics()); }
    catch (error) { await logger?.warn("terminal_heartbeat_failed", { code: error.code || "TERMINAL_UNAVAILABLE" }); }
    finally { active = false; }
  };
  const interval = setInterval(pulse, heartbeatIntervalMs); interval.unref();
  const stop = () => { clearInterval(interval); client.clearUserSession(); server.close(); server.closeAllConnections(); };
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  await pulse();
  return { server, stop };
}
