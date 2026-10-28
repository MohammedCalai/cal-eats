import fs from "node:fs";
import { mailAttachments } from "./mail-attachments.js";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const MAIL_SEND_SCOPES = ["https://graph.microsoft.com/Mail.Send"];
export const graphMailScopes = settings => settings.signInUser.toLowerCase() === settings.sender.toLowerCase() ? MAIL_SEND_SCOPES : ["https://graph.microsoft.com/Mail.Send.Shared"];
export function loadGraphMailConfig(overrides = {}, dbPath, env = process.env) {
  const folder = path.dirname(path.resolve(dbPath));
  const settings = {
    tenantId: overrides.tenantId ?? env.CALAI_MAIL_GRAPH_TENANT_ID ?? "",
    clientId: overrides.clientId ?? env.CALAI_MAIL_GRAPH_CLIENT_ID ?? "",
    sender: overrides.sender ?? env.CALAI_ORDER_ALERT_FROM ?? "caleats-support@calai.info",
    signInUser: overrides.signInUser ?? env.CALAI_MAIL_GRAPH_SIGN_IN_USER ?? overrides.sender ?? env.CALAI_ORDER_ALERT_FROM ?? "caleats-support@calai.info",
    enabled: overrides.enabled ?? env.CALAI_MAIL_GRAPH_ENABLED === "true",
    cacheFile: path.resolve(overrides.cacheFile ?? env.CALAI_MAIL_GRAPH_CACHE_FILE ?? path.join(folder, "cal-eats-mail.cache")),
    keyFile: path.resolve(overrides.keyFile ?? env.CALAI_MAIL_GRAPH_KEY_FILE ?? path.join(folder, ".cal-eats-mail-key")),
    encryptionKey: overrides.encryptionKey ?? env.CALAI_MAIL_GRAPH_ENCRYPTION_KEY
  };
  if ((settings.tenantId && !GUID.test(settings.tenantId)) || (settings.clientId && !GUID.test(settings.clientId)) || typeof settings.enabled !== "boolean") throw new Error("Microsoft mail connection settings are invalid");
  if (![settings.sender, settings.signInUser].every(value => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value))) throw new Error("Microsoft mail sender and sign-in account must be email addresses");
  if (settings.cacheFile === settings.keyFile) throw new Error("Microsoft mail cache and encryption key require separate files");
  return settings;
}

function encryptionKey(settings, allowCreate) {
  let encoded = settings.encryptionKey;
  if (!encoded) {
    try { encoded = fs.readFileSync(settings.keyFile, "utf8").trim(); }
    catch (error) {
      if (error.code !== "ENOENT" || !allowCreate) throw new Error("MAIL_CACHE_KEY_UNAVAILABLE");
      fs.mkdirSync(path.dirname(settings.keyFile), { recursive: true });
      encoded = randomBytes(32).toString("base64");
      try { fs.writeFileSync(settings.keyFile, encoded, { flag: "wx", mode: 0o600 }); }
      catch (writeError) { if (writeError.code !== "EEXIST") throw writeError; encoded = fs.readFileSync(settings.keyFile, "utf8").trim(); }
    }
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("MAIL_CACHE_KEY_INVALID");
  return key;
}

export function createEncryptedMailCache(settings, { allowCreateKey = false } = {}) {
  const aad = Buffer.from(`cal-eats-mail:v1|${settings.tenantId}|${settings.clientId}|${settings.sender.toLowerCase()}|${settings.signInUser.toLowerCase()}`);
  return {
    async beforeCacheAccess(context) {
      let file;
      try { file = fs.readFileSync(settings.cacheFile, "utf8"); }
      catch (error) { if (error.code === "ENOENT") return; throw new Error("MAIL_CACHE_READ_FAILED"); }
      try {
        const saved = JSON.parse(file);
        if (saved.version !== 1) throw new Error();
        const decipher = createDecipheriv("aes-256-gcm", encryptionKey(settings, allowCreateKey), Buffer.from(saved.nonce, "base64"));
        decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(saved.tag, "base64"));
        context.tokenCache.deserialize(Buffer.concat([decipher.update(Buffer.from(saved.ciphertext, "base64")), decipher.final()]).toString("utf8"));
      } catch { throw new Error("MAIL_CACHE_DECRYPT_FAILED"); }
    },
    async afterCacheAccess(context) {
      if (!context.cacheHasChanged) return;
      const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", encryptionKey(settings, allowCreateKey), nonce);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(context.tokenCache.serialize(), "utf8"), cipher.final()]);
      const content = JSON.stringify({ version: 1, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") });
      fs.mkdirSync(path.dirname(settings.cacheFile), { recursive: true });
      const temporary = `${settings.cacheFile}.${randomBytes(8).toString("hex")}.tmp`;
      try { fs.writeFileSync(temporary, content, { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, settings.cacheFile); }
      finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; } }
    }
  };
}

export function graphMailReadiness(settings) {
  return Boolean(settings?.enabled && GUID.test(settings.tenantId) && GUID.test(settings.clientId) && fs.existsSync(settings.cacheFile) && (settings.encryptionKey || fs.existsSync(settings.keyFile)));
}

export async function createGraphMailClient(settings, { allowCreateKey = false } = {}) {
  if (!GUID.test(settings.tenantId) || !GUID.test(settings.clientId)) throw new Error("MAIL_GRAPH_APP_NOT_CONFIGURED");
  const { PublicClientApplication } = await import("@azure/msal-node");
  return new PublicClientApplication({
    auth: { clientId: settings.clientId, authority: `https://login.microsoftonline.com/${settings.tenantId}` },
    cache: { cachePlugin: createEncryptedMailCache(settings, { allowCreateKey }) },
    system: { loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} } }
  });
}

export function createGraphMailAdapter(settings, { fetchImpl = fetch, clientFactory = createGraphMailClient } = {}) {
  let clientPromise;
  return async (message, { beforeSend = () => true } = {}) => {
    let attachments;
    try { attachments = mailAttachments(message.attachments); } catch { return { status: "failed", errorCode: "EMAIL_ATTACHMENT_INVALID" }; }
    if (!graphMailReadiness(settings)) return { status: "failed", errorCode: "GRAPH_NOT_CONFIGURED" };
    if (message.from.toLowerCase() !== settings.sender.toLowerCase()) return { status: "failed", errorCode: "GRAPH_SENDER_MISMATCH" };
    let token;
    try {
      clientPromise ??= clientFactory(settings);
      const client = await clientPromise;
      const accounts = (await client.getTokenCache().getAllAccounts()).filter(account => account.username?.toLowerCase() === settings.signInUser.toLowerCase());
      if (accounts.length !== 1) return { status: "failed", errorCode: "GRAPH_SENDER_SIGN_IN_REQUIRED" };
      const scopes = graphMailScopes(settings), required = scopes[0].split("/").at(-1).toLowerCase();
      const result = await client.acquireTokenSilent({ account: accounts[0], scopes });
      if (!result?.accessToken || !result.scopes.some(scope => scope.split("/").at(-1).toLowerCase() === required)) return { status: "failed", errorCode: "GRAPH_SEND_PERMISSION_REQUIRED" };
      token = result.accessToken;
    } catch { return { status: "failed", errorCode: "GRAPH_SIGN_IN_REQUIRED" }; }
    if (!beforeSend()) return { status: "cancelled" };
    try {
      // The approved member sends as the fixed mailbox. Exchange enforces Send As.
      const response = await fetchImpl("https://graph.microsoft.com/v1.0/me/sendMail", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: { subject: message.subject, from: { emailAddress: { name: "Cal-Eats", address: settings.sender } }, toRecipients: [{ emailAddress: { address: message.to } }], body: { contentType: message.html ? "HTML" : "Text", content: message.html || message.text }, ...(attachments.length ? { attachments: attachments.map(item => ({ "@odata.type": "#microsoft.graph.fileAttachment", name: item.filename, contentType: item.contentType, contentBytes: item.contentBase64 })) } : {}), internetMessageHeaders: [{ name: "x-cal-eats-event-id", value: message.id }] }, saveToSentItems: true })
      });
      if (response.status === 202) return { status: "sent" };
      let providerCode = "";
      if (typeof response.json === "function") {
        try { const code = (await response.json())?.error?.code; if (typeof code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,70}$/.test(code)) providerCode = `_${code.toUpperCase()}`; } catch {}
      }
      return response.status >= 500 ? { status: "unknown", errorCode: "GRAPH_PROVIDER_OUTCOME_UNKNOWN" } : { status: "failed", errorCode: `GRAPH_HTTP_${response.status}${providerCode}` };
    } catch { return { status: "unknown", errorCode: "GRAPH_NETWORK_OUTCOME_UNKNOWN" }; }
  };
}
