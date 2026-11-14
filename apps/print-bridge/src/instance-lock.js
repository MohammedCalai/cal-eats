import fs from "node:fs/promises";
import path from "node:path";

export async function acquireLock(journalPath) {
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
