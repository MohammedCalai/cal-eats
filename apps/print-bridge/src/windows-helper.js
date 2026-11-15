import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function runWindowsHelper(name, input, { timeoutMs = 10_000, spawnImpl = spawn, platform = process.platform } = {}) {
  if (platform !== "win32") throw new Error("This operation requires the Windows companion service");
  if (!new Set(["terminal-key.ps1", "printer-adapter.ps1"]).has(name)) throw new Error("Unsupported Windows helper");
  const payload = JSON.stringify(input);
  if (Buffer.byteLength(payload) > 512 * 1024) throw new Error("Windows helper input is too large");
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = fileURLToPath(new URL(`../windows/${name}`, import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawnImpl(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", bytes = 0, settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(new Error("Windows helper timed out; any print submission must be treated as uncertain")); }, timeoutMs);
    child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 256 * 1024) { child.kill(); finish(new Error("Windows helper returned too much data")); } else output += chunk; });
    // Native error output can contain local paths or driver details. Do not log it.
    child.stderr.resume();
    child.once("error", () => finish(new Error("Windows helper could not be started")));
    child.once("close", code => {
      if (code !== 0) return finish(new Error("Windows helper failed; inspect the protected local service"));
      try { finish(null, JSON.parse(output.replace(/^\uFEFF/, ""))); }
      catch { finish(new Error("Windows helper returned an invalid result")); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(payload);
  });
}
