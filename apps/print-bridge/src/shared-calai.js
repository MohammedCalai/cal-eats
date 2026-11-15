import path from "node:path";
import { ApiClient } from "./api-client.js";
import { PrintBridge } from "./bridge.js";
import { loadConfig } from "./config.js";
import { Journal } from "./journal.js";
import { Logger } from "./logger.js";
import { ensureCredential } from "./setup.js";
import { TcpEscPosTransport, TransportError } from "./transports.js";
import { startTerminalRuntime } from "./terminal-runtime.js";

// Invoked inside the existing native Calai bridge. Both queues use its original
// printer routine and one dispatch queue; no second Windows launcher is needed.
export function sharedPrinterTransport(calaiConfig, config, sendToNetworkPrinter) {
  if (calaiConfig.PRINTER_TYPE !== "NETWORK" || config.transport.kind !== "tcp-escpos" ||
      calaiConfig.PRINTER_IP !== config.transport.host ||
      Number(calaiConfig.PRINTER_PORT) !== config.transport.port) {
    throw new Error("Cal-Eats must use the same network printer as this Calai bridge");
  }
  const probe = new TcpEscPosTransport(config.transport);
  return {
    kind: "tcp-escpos", recovery: "ambiguous",
    probe: () => probe.probe(),
    inspect: async () => null,
    async send(entry) {
      try {
        await sendToNetworkPrinter(calaiConfig.PRINTER_IP, Number(calaiConfig.PRINTER_PORT), entry.receiptText);
        return { outcome: "submitted", detail: "Existing Calai bridge accepted the receipt; physical paper output is unverified" };
      } catch {
        throw new TransportError("Existing Calai printer dispatch failed; check paper before reprinting", { ambiguous: true });
      }
    },
  };
}

export async function startSharedCalai({ configPath, calaiConfig, sendToNetworkPrinter, signal, acquireLock }) {
  const config = await loadConfig(configPath);
  if (typeof globalThis.fetch !== "function") throw new Error("The existing Calai runtime needs Node.js 20 or later");
  const transport = sharedPrinterTransport(calaiConfig, config, sendToNetworkPrinter);
  const release = await acquireLock(config.journalPath);
  let terminal;
  try {
    const logger = new Logger(config.logPath);
    const journal = await new Journal(config.journalPath).load();
    terminal = await startTerminalRuntime({ config, transport, journal, logger, signal });
    const apiFor = (token = null) => new ApiClient({ baseUrl: config.apiBaseUrl, token, timeoutMs: config.requestTimeoutMs, retry: config.retry, terminal });
    const credential = await ensureCredential({
      config, setupPath: path.join(path.dirname(config.configPath), "setup.json"), api: apiFor(),
      verify: saved => apiFor(saved.token).heartbeat({ printerReachable: false, transport: transport.kind }),
    });
    const api = apiFor(credential.token);
    const heartbeat = api.heartbeat.bind(api);
    api.heartbeat = async () => heartbeat({ printerReachable: await transport.probe(), transport: transport.kind });
    const bridge = new PrintBridge({ api, journal, transport, logger });
    await logger.info("shared_calai_bridge_started");
    await bridge.start({ signal, heartbeatIntervalMs: config.heartbeatIntervalMs, idlePollMs: config.idlePollMs });
  } finally { terminal?.stop?.(); await release(); }
}
