import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ApiError } from "./api-client.js";
import { validateCredential, writeCredential } from "./credential-store.js";

const freshSetup = "Download a fresh printer setup from Cal-Eats printer settings and run its installer again.";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PrinterSetupError extends Error {
  constructor(message, code = "PRINTER_SETUP_REQUIRED") {
    super(message);
    this.name = "PrinterSetupError";
    this.code = code;
  }
}

async function readJson(filePath) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new PrinterSetupError("Printer setup data is damaged. " + freshSetup, "INVALID_SETUP_DATA");
    throw error;
  }
}

export function validateSetup(value) {
  if (!value || value.schemaVersion !== 1 || value.product !== "cal-eats") {
    throw new PrinterSetupError("This setup belongs to another product or version. " + freshSetup, "WRONG_PRODUCT");
  }
  if (!uuid.test(value.restaurantId) || !uuid.test(value.printerId) || typeof value.code !== "string" || value.code.length < 6 || value.code.length > 200 || !Number.isFinite(Date.parse(value.expiresAt))) {
    throw new PrinterSetupError("Printer setup data is invalid. " + freshSetup, "INVALID_SETUP_DATA");
  }
  return value;
}

async function atomicJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, filePath);
    try { await fs.chmod(filePath, 0o600); } catch { /* The Windows installer applies directory ACLs. */ }
  } finally { await fs.rm(temporary, { force: true }); }
}

function assertBinding(value, setup) {
  if (setup && (value.restaurantId !== setup.restaurantId || value.printerId !== setup.printerId)) {
    throw new PrinterSetupError("Printer identity does not match this restaurant setup. No existing credentials were replaced. " + freshSetup, "PRINTER_IDENTITY_MISMATCH");
  }
}

async function discardBootstrap(setupPath, pendingPath) {
  // The credential is durable before either bootstrap secret is removed.
  await fs.rm(setupPath, { force: true });
  await fs.rm(pendingPath, { force: true });
}

export async function ensureCredential({ config, setupPath, api, verify, clock = () => new Date() }) {
  const pendingPath = `${config.credentialPath}.pairing-pending.json`;
  const raw = await readJson(config.credentialPath).catch((error) => {
    if (error.code === "INVALID_SETUP_DATA") return null;
    throw error;
  });
  if (raw && raw.product !== "cal-eats") throw new PrinterSetupError("The saved credential belongs to another product. It was left unchanged.", "WRONG_PRODUCT");
  const setupInput = await readJson(setupPath);
  const setup = setupInput ? validateSetup(setupInput) : null;
  let credential = null;
  if (raw) {
    try { credential = validateCredential(raw); } catch { /* Fresh setup can repair malformed Cal-Eats credentials. */ }
  }
  if (credential) {
    assertBinding(credential, setup);
    try {
      await verify(credential);
      if (setup) await discardBootstrap(setupPath, pendingPath);
      return credential;
    } catch (error) {
      // An offline API is not evidence that a working credential should be replaced.
      if (!(error instanceof ApiError) || ![401, 403].includes(error.status)) throw error;
    }
  }
  if (!setup) throw new PrinterSetupError("This printer has no valid Cal-Eats connection. " + freshSetup);
  const pendingInput = await readJson(pendingPath);
  const codeHash = crypto.createHash("sha256").update(setup.code).digest("hex");
  let pending = null;
  if (pendingInput) {
    if (pendingInput.product !== "cal-eats" || pendingInput.schemaVersion !== 1) throw new PrinterSetupError("The pending printer connection belongs to another product. It was left unchanged.", "WRONG_PRODUCT");
    assertBinding(pendingInput, setup);
    if (!/^[A-Za-z0-9_-]{43,64}$/.test(pendingInput.token) || !/^[a-f0-9]{64}$/.test(pendingInput.codeHash)) throw new PrinterSetupError("The pending printer connection is damaged. " + freshSetup, "INVALID_SETUP_DATA");
    if (pendingInput.codeHash === codeHash) pending = pendingInput;
  }
  // Replay an already-started setup even after local expiry: its first response may
  // have been lost, and only the server can confirm that the same token consumed it.
  if (!pending && Date.parse(setup.expiresAt) <= clock().valueOf()) throw new PrinterSetupError("This printer setup has expired. " + freshSetup, "SETUP_EXPIRED");
  if (!pending) {
    pending = { schemaVersion: 1, product: "cal-eats", restaurantId: setup.restaurantId, printerId: setup.printerId, codeHash, token: crypto.randomBytes(32).toString("base64url") };
    await atomicJson(pendingPath, pending);
  }
  let paired;
  try { paired = await api.pair(setup.code, config.deviceName, pending.token); }
  catch (error) {
    if (error instanceof ApiError && !error.retryable && [400, 401, 403, 404, 409, 410, 422].includes(error.status)) {
      throw new PrinterSetupError("This printer setup is expired, revoked or already used by another installation. " + freshSetup, "SETUP_REJECTED");
    }
    throw error;
  }
  assertBinding(paired, setup);
  if (paired.token !== pending.token) throw new PrinterSetupError("The printer connection response could not be verified. Existing setup data was preserved.", "INVALID_PAIR_RESPONSE");
  credential = await writeCredential(config.credentialPath, paired, clock());
  await verify(credential);
  await discardBootstrap(setupPath, pendingPath);
  return credential;
}
