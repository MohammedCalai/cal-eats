import http2 from "node:http2";
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { LIVE_ACTIVITY_TOPIC } from "./order-live-activities.js";

const host = "https://api.push.apple.com";
const base64 = value => Buffer.from(JSON.stringify(value)).toString("base64url");

// Keep one HTTP/2 connection open. The sender never follows a redirect or accepts
// a request-supplied host, topic, headers, key or Activity token in error output.
function createAPNsRequest() {
  let connection = null, connecting = null;
  const connect = () => {
    if (connection && !connection.closed && !connection.destroyed) return Promise.resolve(connection);
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      const client = http2.connect(host), timeout = setTimeout(() => { client.destroy(); reject(new Error("APNS_CONNECT_TIMEOUT")); }, 10000);
      client.on("error", () => {});
      client.once("connect", () => { clearTimeout(timeout); connection = client; client.unref(); resolve(client); });
      client.once("error", () => { clearTimeout(timeout); client.destroy(); reject(new Error("APNS_CONNECT_FAILED")); });
      client.on("close", () => { if (connection === client) connection = null; });
    }).finally(() => { connecting = null; });
    return connecting;
  };
  return async ({ path, headers, body }, beforeSend) => {
    const client = await connect();
    if (!beforeSend()) return { cancelled: true };
    return new Promise((resolve, reject) => {
      let status = 0, responseHeaders = {}, bytes = 0, chunks = [], settled = false;
      const stream = client.request({ ":method": "POST", ":path": path, ...headers });
      const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timeout); if (error) reject(new Error("APNS_REQUEST_FAILED")); else resolve(result); };
      const timeout = setTimeout(() => { finish(true); stream.close(); }, 10000);
      stream.on("response", value => { status = value[":status"]; responseHeaders = value; });
      stream.on("data", chunk => { bytes += chunk.length; if (bytes > 4096) { finish(true); stream.close(); } else chunks.push(chunk); });
      stream.once("end", () => { let reason = null; try { reason = JSON.parse(Buffer.concat(chunks).toString("utf8")).reason; } catch {} finish(false, { status, apnsId: responseHeaders["apns-id"], reason }); });
      stream.once("error", () => finish(true));
      stream.once("aborted", () => finish(true));
      stream.end(body);
    });
  };
}

export function createAPNsLiveActivityAdapter(settings, { requestImpl = createAPNsRequest(), now = () => Date.now() } = {}) {
  if (!settings?.enabled || !settings.teamId || !settings.keyId || !settings.privateKey) throw new Error("Live Activity sender is not connected");
  const privateKey = createPrivateKey(settings.privateKey);
  let cached = null;
  function authorization() {
    const timestamp = Math.floor(now() / 1000);
    if (cached && timestamp >= cached.timestamp && timestamp - cached.timestamp < 45 * 60) return cached.token;
    const header = base64({ alg: "ES256", kid: settings.keyId }), payload = base64({ iss: settings.teamId, iat: timestamp }), unsigned = `${header}.${payload}`;
    cached = { timestamp, token: `${unsigned}.${sign("sha256", Buffer.from(unsigned), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}` };
    return cached.token;
  }
  return {
    async send(token, payload, { beforeSend, priority = 5 }) {
      if (!/^(?:[0-9a-f]{2}){8,512}$/.test(token) || ![5, 10].includes(priority)) return { status: "failed", errorCode: "LIVE_ACTIVITY_INVALID_REQUEST" };
      const body = JSON.stringify(payload); if (Buffer.byteLength(body) > 4096) return { status: "failed", errorCode: "LIVE_ACTIVITY_PAYLOAD_TOO_LARGE" };
      let result;
      try { result = await requestImpl({ path: `/3/device/${token}`, headers: { authorization: `bearer ${authorization()}`, "apns-push-type": "liveactivity", "apns-topic": LIVE_ACTIVITY_TOPIC, "apns-priority": String(priority), "apns-id": randomUUID(), "apns-expiration": String(payload.aps["stale-date"] ?? payload.aps.timestamp + 300), "content-type": "application/json" }, body }, beforeSend); }
      catch { return { status: "retry", errorCode: "LIVE_ACTIVITY_NETWORK_RETRY" }; }
      if (result.cancelled) return { status: "cancelled" };
      if (result.status === 200) return { status: "accepted", apnsId: /^[0-9a-f-]{36}$/i.test(result.apnsId ?? "") ? result.apnsId : null };
      if (result.status === 410 || result.reason === "Unregistered" || result.reason === "BadDeviceToken") return { status: "invalid_activity", errorCode: "LIVE_ACTIVITY_TOKEN_ENDED" };
      if (result.reason === "ExpiredProviderToken") { cached = null; return { status: "retry", errorCode: "LIVE_ACTIVITY_SENDER_TOKEN_EXPIRED" }; }
      if (result.status === 429 || result.status >= 500) return { status: "retry", errorCode: result.status === 429 ? "LIVE_ACTIVITY_RATE_LIMITED" : "LIVE_ACTIVITY_PROVIDER_RETRY" };
      const codes = { TopicDisallowed: "LIVE_ACTIVITY_TOPIC_DISALLOWED", DeviceTokenNotForTopic: "LIVE_ACTIVITY_TOKEN_TOPIC_MISMATCH", InvalidProviderToken: "LIVE_ACTIVITY_SENDER_REJECTED", MissingProviderToken: "LIVE_ACTIVITY_SENDER_REJECTED", BadTopic: "LIVE_ACTIVITY_TOPIC_REJECTED" };
      return { status: "failed", errorCode: codes[result.reason] ?? "LIVE_ACTIVITY_PROVIDER_REJECTED" };
    }
  };
}
