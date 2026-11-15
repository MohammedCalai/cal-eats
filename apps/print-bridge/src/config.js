import fs from "node:fs/promises";
import path from "node:path";

const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "product",
  "deviceName",
  "apiBaseUrl",
  "credentialPath",
  "journalPath",
  "logPath",
  "transport",
  "requestTimeoutMs",
  "heartbeatIntervalMs",
  "idlePollMs",
  "retry",
  "terminal",
]);

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new Error(`${label} has unknown field: ${unexpected[0]}`);
}

function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function relativeFile(baseDirectory, value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return path.resolve(baseDirectory, value);
}

function validateApiBaseUrl(value, transportKind) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("apiBaseUrl must be a valid URL");
  }
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("apiBaseUrl must be a plain HTTP(S) origin/path without credentials, query or fragment");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const loopback = new Set(["127.0.0.1", "[::1]", "localhost"]).has(hostname);
  if (!loopback && url.protocol !== "https:") {
    throw new Error("A remote device API must use HTTPS to protect device credentials");
  }
  if (hostname !== "eats.calai.info" && (hostname === "calai.info" || hostname.endsWith(".calai.info"))) {
    throw new Error("Original Calai API hosts are forbidden");
  }
  if (transportKind === "file-sink" && !loopback) {
    throw new Error("The file-sink simulator only accepts a loopback API origin");
  }
  return url.toString().replace(/\/$/, "");
}

function validateRetry(value) {
  exactKeys(value, new Set(["maxAttempts", "baseDelayMs", "maxDelayMs", "jitterRatio"]), "retry");
  const result = {
    maxAttempts: integer(value.maxAttempts, 1, 5, "retry.maxAttempts"),
    baseDelayMs: integer(value.baseDelayMs, 10, 10_000, "retry.baseDelayMs"),
    maxDelayMs: integer(value.maxDelayMs, 10, 60_000, "retry.maxDelayMs"),
    jitterRatio: value.jitterRatio,
  };
  if (typeof result.jitterRatio !== "number" || result.jitterRatio < 0 || result.jitterRatio > 0.5) {
    throw new Error("retry.jitterRatio must be from 0 to 0.5");
  }
  if (result.maxDelayMs < result.baseDelayMs) throw new Error("retry.maxDelayMs must not be below baseDelayMs");
  return result;
}

function validateTransport(value, baseDirectory) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("transport must be an object");
  if (value.kind === "file-sink") {
    exactKeys(value, new Set(["kind", "outputDirectory"]), "transport");
    return { kind: "file-sink", outputDirectory: relativeFile(baseDirectory, value.outputDirectory, "transport.outputDirectory") };
  }
  if (value.kind === "tcp-escpos") {
    exactKeys(value, new Set(["kind", "enabled", "host", "port", "connectTimeoutMs"]), "transport");
    if (value.enabled !== true) throw new Error("TCP ESC/POS transport requires transport.enabled=true");
    if (typeof value.host !== "string" || !value.host.trim() || value.host.length > 255) throw new Error("transport.host is invalid");
    return {
      kind: "tcp-escpos",
      enabled: true,
      host: value.host.trim(),
      port: integer(value.port, 1, 65535, "transport.port"),
      connectTimeoutMs: integer(value.connectTimeoutMs ?? 5000, 500, 30_000, "transport.connectTimeoutMs"),
    };
  }
  if (value.kind === "windows-spooler") {
    exactKeys(value, new Set(["kind", "enabled", "printerName", "timeoutMs"]), "transport");
    if (value.enabled !== true || typeof value.printerName !== "string" || !value.printerName.trim() || value.printerName.length > 200 || /[\x00-\x1f]/.test(value.printerName)) throw new Error("Windows printing requires an explicit enabled printer name");
    return { kind: value.kind, enabled: true, printerName: value.printerName, timeoutMs: integer(value.timeoutMs ?? 10_000, 1000, 30_000, "transport.timeoutMs") };
  }
  throw new Error("transport.kind must be file-sink, tcp-escpos or windows-spooler");
}

function terminalConfig(value, baseDirectory) {
  if (value === undefined || value === null) return null; // old local simulators
  exactKeys(value, new Set(["enabled", "port", "identityPath", "allowedOrigins", "heartbeatIntervalMs", "printerId", "keyProvider"]), "terminal");
  if (value.enabled !== true) throw new Error("terminal.enabled must be true when configured");
  const allowedOrigins = value.allowedOrigins ?? ["https://eats.calai.info"];
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length < 1 || allowedOrigins.length > 3 || allowedOrigins.some(origin => typeof origin !== "string" || !(/^https:\/\/eats\.calai\.info$/.test(origin) || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)))) throw new Error("terminal.allowedOrigins must contain exact Cal-Eats or loopback origins");
  if (value.printerId != null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.printerId)) throw new Error("Invalid terminal.printerId");
  if (value.keyProvider !== undefined && !["software", "tpm"].includes(value.keyProvider)) throw new Error("Invalid terminal.keyProvider");
  return { enabled: true, port: integer(value.port ?? 17863, 1024, 65535, "terminal.port"), identityPath: relativeFile(baseDirectory, value.identityPath ?? "./var/terminal-identity.json", "terminal.identityPath"), allowedOrigins, heartbeatIntervalMs: integer(value.heartbeatIntervalMs ?? 15_000, 5000, 30_000, "terminal.heartbeatIntervalMs"), printerId: value.printerId ?? null, keyProvider: value.keyProvider ?? "software" };
}

export async function loadConfig(configPath) {
  const absolutePath = path.resolve(configPath);
  const baseDirectory = path.dirname(absolutePath);
  let input;
  try {
    input = JSON.parse(await fs.readFile(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read configuration: ${error.message}`);
  }
  exactKeys(input, TOP_LEVEL_KEYS, "configuration");
  if (input.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  if (input.product !== "cal-eats") throw new Error("product must be cal-eats");
  if (typeof input.deviceName !== "string" || input.deviceName.trim().length < 2 || input.deviceName.trim().length > 80) {
    throw new Error("deviceName must contain 2 to 80 characters");
  }
  const transport = validateTransport(input.transport, baseDirectory);
  return Object.freeze({
    schemaVersion: 1,
    product: "cal-eats",
    deviceName: input.deviceName.trim(),
    configPath: absolutePath,
    apiBaseUrl: validateApiBaseUrl(input.apiBaseUrl, transport.kind),
    credentialPath: relativeFile(baseDirectory, input.credentialPath, "credentialPath"),
    journalPath: relativeFile(baseDirectory, input.journalPath, "journalPath"),
    logPath: relativeFile(baseDirectory, input.logPath, "logPath"),
    transport,
    requestTimeoutMs: integer(input.requestTimeoutMs, 500, 30_000, "requestTimeoutMs"),
    heartbeatIntervalMs: integer(input.heartbeatIntervalMs, 5000, 300_000, "heartbeatIntervalMs"),
    idlePollMs: integer(input.idlePollMs, 500, 60_000, "idlePollMs"),
    retry: validateRetry(input.retry),
    terminal: terminalConfig(input.terminal, baseDirectory),
  });
}
