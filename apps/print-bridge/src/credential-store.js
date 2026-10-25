import fs from "node:fs/promises";
import path from "node:path";

function text(value, min, max, label) {
  if (typeof value !== "string" || value.length < min || value.length > max) throw new Error(`${label} is invalid`);
  return value;
}

export function validateCredential(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Device credential is invalid");
  if (value.schemaVersion !== 1 || value.product !== "cal-eats") throw new Error("Device credential belongs to another product or version");
  return Object.freeze({
    schemaVersion: 1,
    product: "cal-eats",
    deviceId: text(value.deviceId, 8, 100, "deviceId"),
    restaurantId: text(value.restaurantId, 8, 100, "restaurantId"),
    printerId: text(value.printerId, 8, 100, "printerId"),
    token: text(value.token, 24, 500, "device token"),
    pairedAt: text(value.pairedAt, 20, 40, "pairedAt"),
  });
}

export async function readCredential(filePath) {
  try {
    return validateCredential(JSON.parse(await fs.readFile(filePath, "utf8")));
  } catch (error) {
    throw new Error(`Cannot read device credential: ${error.message}`);
  }
}

export async function writeCredential(filePath, paired, now = new Date()) {
  const credential = validateCredential({
    schemaVersion: 1,
    product: "cal-eats",
    deviceId: paired.deviceId,
    restaurantId: paired.restaurantId,
    printerId: paired.printerId,
    token: paired.token,
    pairedAt: now.toISOString(),
  });
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(credential, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(temporary, filePath);
  try { await fs.chmod(filePath, 0o600); } catch { /* Windows ACLs are applied by the installer. */ }
  return credential;
}
