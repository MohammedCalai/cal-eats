import path from "node:path";

export function loadConfig(overrides = {}) {
  const runMode = overrides.runMode ?? process.env.CALAI_RUN_MODE ?? "local";
  if (!["local", "hosted-preview"].includes(runMode)) throw new Error("CALAI_RUN_MODE must be local or hosted-preview");
  const hostname = overrides.hostname ?? process.env.CALAI_HOST ?? "127.0.0.1";
  const port = Number(overrides.port ?? process.env.CALAI_PORT ?? (runMode === "hosted-preview" ? process.env.PORT : undefined) ?? 4310);
  const nodeEnv = overrides.nodeEnv ?? process.env.NODE_ENV ?? "development";
  if (nodeEnv === "production" && runMode !== "hosted-preview") throw new Error("NODE_ENV=production requires hosted-preview mode");
  if (runMode === "local" && hostname !== "127.0.0.1" && hostname !== "::1" && hostname !== "localhost") throw new Error("CALAI_HOST must be loopback in local mode");
  if (runMode === "hosted-preview" && !["0.0.0.0", "::", "127.0.0.1", "::1", "localhost"].includes(hostname)) throw new Error("CALAI_HOST is invalid for hosted preview");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("CALAI_PORT is invalid");
  const configuredOrigin = overrides.origin ?? process.env.CALAI_ORIGIN;
  if (runMode === "hosted-preview" && !configuredOrigin) throw new Error("CALAI_ORIGIN is required for hosted preview");
  const origin = configuredOrigin ?? `http://${hostname === "::1" ? "[::1]" : hostname}:${port}`;
  const parsed = new URL(origin);
  if (origin !== parsed.origin || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("CALAI_ORIGIN must be a normalized origin without a path");
  if (runMode === "local" && (parsed.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname))) throw new Error("CALAI_ORIGIN must be loopback HTTP in local mode");
  if (runMode === "hosted-preview" && parsed.protocol !== "https:") throw new Error("CALAI_ORIGIN must use HTTPS for hosted preview");
  const orderExpiryMinutes = overrides.orderExpiryMinutes ?? Number(process.env.CALAI_ORDER_EXPIRY_MINUTES ?? 15);
  if (!Number.isInteger(orderExpiryMinutes) || orderExpiryMinutes < 1 || orderExpiryMinutes > 1440) throw new Error("CALAI_ORDER_EXPIRY_MINUTES must be an integer from 1 to 1440");
  const healthcheckHost = overrides.healthcheckHost ?? process.env.CALAI_HEALTHCHECK_HOST ?? null;
  if (healthcheckHost && (runMode !== "hosted-preview" || healthcheckHost !== "healthcheck.railway.app")) throw new Error("CALAI_HEALTHCHECK_HOST is invalid");
  return {
    hostname,
    runMode,
    port,
    origin: parsed.origin,
    expectedHost: parsed.host,
    secureCookies: runMode === "hosted-preview",
    demoShortcuts: runMode === "local",
    healthcheckHost,
    dbPath: overrides.dbPath ?? process.env.CALAI_DB_PATH ?? path.resolve("data/calai-eats.sqlite"),
    sessionHours: overrides.sessionHours ?? 24,
    bodyLimit: overrides.bodyLimit ?? 16 * 1024,
    orderExpiryMinutes,
    mockCapture: overrides.mockCapture,
    now: overrides.now ?? (() => new Date()),
    rateLimit: overrides.rateLimit ?? { attempts: 8, windowMs: 60_000 }
  };
}
