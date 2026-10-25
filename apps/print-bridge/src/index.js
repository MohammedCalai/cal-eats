import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { ApiClient } from "./api-client.js";
import { PrintBridge } from "./bridge.js";
import { loadConfig } from "./config.js";
import { readCredential, writeCredential } from "./credential-store.js";
import { Journal } from "./journal.js";
import { Logger } from "./logger.js";
import { createTransport } from "./transports.js";

function argumentsFor(argv) {
  const result = { command: argv[0] || "start", config: process.env.CAL_EATS_PRINT_BRIDGE_CONFIG || null, allowPhysicalTransport: false };
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "--config") result.config = argv[++index];
    else if (argv[index] === "--allow-physical-transport") result.allowPhysicalTransport = true;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!result.config) throw new Error("Provide --config or CAL_EATS_PRINT_BRIDGE_CONFIG");
  return result;
}

async function acquireLock(journalPath) {
  const lockPath = `${journalPath}.lock`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ product: "cal-eats", pid: process.pid, startedAt: new Date().toISOString() })}\n`);
      return async () => { await handle.close(); await fs.rm(lockPath, { force: true }); };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let existing;
      try { existing = JSON.parse(await fs.readFile(lockPath, "utf8")); }
      catch { throw new Error("The Cal-Eats bridge lock is malformed; inspect it before removal"); }
      if (existing.product !== "cal-eats" || !Number.isSafeInteger(existing.pid) || existing.pid < 1) {
        throw new Error("The Cal-Eats bridge lock is malformed; inspect it before removal");
      }
      try {
        process.kill(existing.pid, 0);
        throw new Error("Another Cal-Eats print bridge instance is using this journal");
      } catch (probeError) {
        if (!new Set(["ESRCH", "EINVAL"]).has(probeError.code)) throw probeError;
        await fs.rm(lockPath, { force: true });
      }
    }
  }
  throw new Error("Could not acquire the Cal-Eats print bridge lock");
}

function apiFor(config, token = null) {
  return new ApiClient({ baseUrl: config.apiBaseUrl, token, timeoutMs: config.requestTimeoutMs, retry: config.retry });
}

async function main() {
  const args = argumentsFor(process.argv.slice(2));
  const config = await loadConfig(args.config);
  if (args.command === "validate") {
    process.stdout.write("Cal-Eats print bridge configuration is valid.\n");
    return;
  }
  if (args.command === "pair") {
    const code = process.env.CAL_EATS_PAIRING_CODE;
    if (!code || code.length < 6 || code.length > 200) throw new Error("Set the short-lived CAL_EATS_PAIRING_CODE environment variable");
    const paired = await apiFor(config).pair(code, config.deviceName);
    await writeCredential(config.credentialPath, paired);
    process.stdout.write(`Paired Cal-Eats device ${paired.deviceId}; the opaque token was stored and was not printed.\n`);
    return;
  }
  if (!new Set(["start", "once"]).has(args.command)) throw new Error("Command must be validate, pair, once or start");
  const releaseLock = await acquireLock(config.journalPath);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const credential = await readCredential(config.credentialPath);
    const journal = await new Journal(config.journalPath).load();
    const logger = new Logger(config.logPath);
    const transport = createTransport(config.transport, { allowPhysicalTransport: args.allowPhysicalTransport });
    const bridge = new PrintBridge({ api: apiFor(config, credential.token), journal, transport, logger });
    await logger.info("bridge_started", { deviceId: credential.deviceId, transport: transport.kind });
    if (args.command === "once") await bridge.runOnce();
    else await bridge.start({ signal: controller.signal, heartbeatIntervalMs: config.heartbeatIntervalMs, idlePollMs: config.idlePollMs });
  } finally {
    await releaseLock();
  }
}

main().catch((error) => {
  process.stderr.write(`Cal-Eats print bridge stopped: ${error.message}\n`);
  process.exitCode = 1;
});
