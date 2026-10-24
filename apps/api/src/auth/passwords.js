import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
const DUMMY_SALT = Buffer.from("e3f241badb5345e4e0c088371c6f5fc8", "hex");
let active = 0;
const waiters = [];

async function limitedScrypt(password, salt) {
  if (active >= 4) await new Promise((resolve) => waiters.push(resolve));
  active += 1;
  try { return await scrypt(password, salt, 64, PARAMS); }
  finally { active -= 1; waiters.shift()?.(); }
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await limitedScrypt(password, salt);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(password, encoded) {
  let salt = DUMMY_SALT;
  let expected = Buffer.alloc(64);
  try {
    const [algorithm, n, r, p, saltHex, hashHex] = String(encoded ?? "").split("$");
    if (algorithm !== "scrypt" || Number(n) !== PARAMS.N || Number(r) !== PARAMS.r || Number(p) !== PARAMS.p) throw new Error();
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
    if (salt.length !== 16 || expected.length !== 64) throw new Error();
  } catch { /* retain dummy values so missing users still pay the same scrypt cost */ }
  const actual = await limitedScrypt(password, salt);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
