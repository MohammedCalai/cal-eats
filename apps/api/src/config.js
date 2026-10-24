import path from "node:path";

export function loadConfig(overrides = {}) {
  const hostname = overrides.hostname ?? process.env.CALAI_HOST ?? "127.0.0.1";
  const port = Number(overrides.port ?? process.env.CALAI_PORT ?? 4310);
  const nodeEnv = overrides.nodeEnv ?? process.env.NODE_ENV ?? "development";
  if (nodeEnv === "production") throw new Error("This local milestone cannot run in production");
  if (hostname !== "127.0.0.1" && hostname !== "::1" && hostname !== "localhost") throw new Error("CALAI_HOST must be loopback");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("CALAI_PORT is invalid");
  const origin = overrides.origin ?? process.env.CALAI_ORIGIN ?? `http://${hostname === "::1" ? "[::1]" : hostname}:${port}`;
  const parsed = new URL(origin);
  if (parsed.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname)) throw new Error("CALAI_ORIGIN must be loopback HTTP");
  const orderExpiryMinutes = overrides.orderExpiryMinutes ?? Number(process.env.CALAI_ORDER_EXPIRY_MINUTES ?? 15);
  if (!Number.isInteger(orderExpiryMinutes) || orderExpiryMinutes < 1 || orderExpiryMinutes > 1440) throw new Error("CALAI_ORDER_EXPIRY_MINUTES must be an integer from 1 to 1440");
  return {
    hostname,
    port,
    origin: parsed.origin,
    expectedHost: parsed.host,
    dbPath: overrides.dbPath ?? process.env.CALAI_DB_PATH ?? path.resolve("data/calai-eats.sqlite"),
    sessionHours: overrides.sessionHours ?? 24,
    bodyLimit: overrides.bodyLimit ?? 16 * 1024,
    orderExpiryMinutes,
    mockCapture: overrides.mockCapture,
    now: overrides.now ?? (() => new Date()),
    rateLimit: overrides.rateLimit ?? { attempts: 8, windowMs: 60_000 }
  };
}
