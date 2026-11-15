import crypto from "node:crypto";
import { runWindowsHelper } from "./windows-helper.js";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
export function requestCanonical({ terminalId, timestamp, nonce, method, target, body = "" }) {
  if (!UUID.test(terminalId) || !/^\d{13}$/.test(String(timestamp)) || !/^[A-Za-z0-9_-]{22,100}$/.test(nonce)) throw new Error("Invalid terminal signing envelope");
  if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(method) || !/^\/api\//.test(target) || /[\r\n#\\]/.test(target)) throw new Error("Invalid signed request target");
  return `CAL-EATS-TERMINAL-V1\n${terminalId}\n${timestamp}\n${nonce}\n${method}\n${target}\n${sha256(body)}`;
}
export function pairingCanonical({ terminalId, challenge, publicKeySpki }) {
  if (!UUID.test(terminalId) || typeof challenge !== "string" || !/^[A-Za-z0-9_-]{20,300}$/.test(challenge)) throw new Error("Invalid terminal pairing challenge");
  return `CAL-EATS-PAIR-V1\n${terminalId}\n${challenge}\n${sha256(Buffer.from(publicKeySpki, "base64"))}`;
}
export function validatePublicKey(result) {
  if (result?.nonExportable !== true || result.machineKey !== true || result.aclVerified !== true || !new Set(["Microsoft Software Key Storage Provider", "Microsoft Platform Crypto Provider"]).has(result.provider)) throw new Error("Windows terminal key policy could not be confirmed");
  const key = crypto.createPublicKey({ key: Buffer.from(result.publicKeySpki, "base64"), type: "spki", format: "der" });
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("Terminal key must be P256");
  return result;
}
export class WindowsTerminalKey {
  constructor(terminalId, { helper = runWindowsHelper, provider = "software" } = {}) {
    if (!UUID.test(terminalId)) throw new Error("Invalid terminal identity");
    if (!["software", "tpm"].includes(provider)) throw new Error("Unsupported Windows key provider");
    this.terminalId = terminalId; this.helper = helper; this.provider = provider;
  }
  _validate(result) { validatePublicKey(result); if (result.provider !== (this.provider === "software" ? "Microsoft Software Key Storage Provider" : "Microsoft Platform Crypto Provider")) throw new Error("The terminal key provider changed; owner-approved re-enrollment is required"); return result; }
  async publicKey({ create = false } = {}) { return this._validate(await this.helper("terminal-key.ps1", { action: create ? "create" : "public", terminalId: this.terminalId, provider: this.provider })); }
  async sign(canonical) {
    // The HTTP server never exposes this operation. Its callers construct only
    // pairing or allowlisted API envelopes, never caller-provided signing bytes.
    if (typeof canonical !== "string" || !/^CAL-EATS-(PAIR|TERMINAL)-V1\n/.test(canonical)) throw new Error("Unsupported signing context");
    const result = this._validate(await this.helper("terminal-key.ps1", { action: "sign", terminalId: this.terminalId, provider: this.provider, messageBase64: Buffer.from(canonical).toString("base64") }));
    if (!/^[A-Za-z0-9_-]{86}$/.test(result.signature || "") || !crypto.verify("sha256", Buffer.from(canonical), { key: crypto.createPublicKey({ key: Buffer.from(result.publicKeySpki, "base64"), format: "der", type: "spki" }), dsaEncoding: "ieee-p1363" }, Buffer.from(result.signature, "base64url"))) throw new Error("Windows signature could not be verified");
    return result.signature;
  }
}
