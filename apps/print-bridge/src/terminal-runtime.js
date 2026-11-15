import { TerminalClient } from "./terminal-client.js";
import { startCompanion } from "./terminal-companion.js";
import { deviceHealth } from "./windows-printer.js";
import { WindowsTerminalKey } from "./terminal-signing.js";

export async function startTerminalRuntime({ config, transport, journal, logger, signal }) {
  if (!config.terminal) return null;
  const terminal = await new TerminalClient({ baseUrl: config.apiBaseUrl, identityPath: config.terminal.identityPath, timeoutMs: config.requestTimeoutMs, keyFactory: id => new WindowsTerminalKey(id, { provider: config.terminal.keyProvider }) }).load();
  const companion = await startCompanion({ client: terminal, port: config.terminal.port, allowedOrigins: config.terminal.allowedOrigins, heartbeatIntervalMs: config.terminal.heartbeatIntervalMs, signal, logger, diagnostics: () => deviceHealth({ transport, journal, printerId: config.terminal.printerId }) });
  terminal.stop = companion.stop;
  await logger.info("terminal_companion_started", { paired: terminal.paired });
  // Enrollment happens on the authenticated business screen. Keep serving the
  // local enrollment interface, but never claim a Cal-Eats job before pairing.
  while (!terminal.paired && !signal.aborted) await new Promise(resolve => { const done = () => { clearTimeout(timeout); signal.removeEventListener("abort", done); resolve(); }; const timeout = setTimeout(done, 500); signal.addEventListener("abort", done, { once: true }); });
  if (signal.aborted) throw new Error("The terminal companion stopped before enrollment");
  return terminal;
}
