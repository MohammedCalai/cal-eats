import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HttpError } from "./http.js";

const KEY_FILE = ".cal-eats-message-key";
const VERSION = "v1";
const cached = new Map();

function decodeKey(value) {
  try {
    const key = Buffer.from(String(value ?? ""), "base64");
    return key.length === 32 ? key : null;
  } catch { return null; }
}

function localKey(config) {
  const filename = path.resolve(config.messageKeyFile ?? path.join(path.dirname(path.resolve(config.dbPath)), KEY_FILE));
  if (cached.has(filename)) return cached.get(filename);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  let encoded;
  try { encoded = fs.readFileSync(filename, "utf8").trim(); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    encoded = randomBytes(32).toString("base64");
    try { fs.writeFileSync(filename, `${encoded}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }); }
    catch (writeError) {
      if (writeError.code !== "EEXIST") throw writeError;
      encoded = fs.readFileSync(filename, "utf8").trim();
    }
  }
  const key = decodeKey(encoded);
  if (!key) throw new Error("Local message encryption key is invalid");
  cached.set(filename, key);
  return key;
}

export function messageEncryptionKey(config) {
  const explicit = config.messageEncryptionKey ?? process.env.CALAI_MESSAGE_ENCRYPTION_KEY;
  const key = decodeKey(explicit);
  if (explicit && !key) throw new HttpError(503, "MESSAGING_UNAVAILABLE", "Order messaging is unavailable");
  if (key) return { key, version: config.messageEncryptionKeyVersion ?? VERSION };
  if (config.runMode === "local") return { key: localKey(config), version: VERSION };
  throw new HttpError(503, "MESSAGING_UNAVAILABLE", "Order messaging is unavailable");
}

const aad = (meta) => Buffer.from([meta.id, meta.orderId, meta.senderUserId, meta.createdAt, meta.expiresAt, meta.keyVersion].join("|"));

export async function encryptMessage(config, plaintext, meta) {
  const { createCipheriv } = await import("node:crypto");
  const { key, version } = messageEncryptionKey(config);
  const nonce = randomBytes(12);
  const full = { ...meta, keyVersion: version };
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad(full));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), nonce: nonce.toString("base64"), authTag: cipher.getAuthTag().toString("base64"), keyVersion: version };
}

export async function decryptMessage(config, row) {
  try {
    const { createDecipheriv } = await import("node:crypto");
    const { key, version } = messageEncryptionKey(config);
    if (row.key_version !== version) throw new Error("Unknown message key version");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row.nonce, "base64"));
    decipher.setAAD(aad({ id: row.id, orderId: row.order_id, senderUserId: row.sender_user_id, createdAt: row.created_at, expiresAt: row.expires_at, keyVersion: row.key_version }));
    decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(row.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(500, "MESSAGE_DECRYPTION_FAILED", "Message content could not be read");
  }
}

export const messageFingerprint = (config, orderId, message) => {
  const { key } = messageEncryptionKey(config);
  return createHmac("sha256", key).update("cal-eats:order-message:idempotency:v1\0").update(orderId).update("\0").update(message).digest("hex");
};
export const MESSAGE_KEY_FILE = KEY_FILE;
