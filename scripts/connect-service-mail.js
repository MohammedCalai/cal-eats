import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createGraphMailClient, graphMailScopes } from "../apps/api/src/graph-mail.js";
import { loadConfig } from "../apps/api/src/config.js";

// This command connects one explicitly approved mailbox. It never sends an email.
async function main() {
const config = loadConfig(), settings = config.orderAlertEmail.graph;
const scopes = graphMailScopes(settings), permission = scopes[0].split("/").at(-1);
const connect = process.argv.includes("--connect");
if (connect && !process.argv.includes("--confirm-send-only-mailbox")) throw new Error("Confirm the send-only mailbox connection before signing in");
const client = await createGraphMailClient(settings, { allowCreateKey: connect });
if (connect) {
  const pendingFile = path.join(path.dirname(settings.cacheFile), "mail-sign-in.private.txt");
  try {
    await client.acquireTokenInteractive({ scopes, loginHint: settings.signInUser, nonce: randomBytes(24).toString("base64url"), state: randomBytes(24).toString("base64url"), preferredPort: 4389, successTemplate: "<h1>Cal-Eats mail sign-in complete</h1><p>You can return to Cal-Eats. No email has been sent by this sign-in.</p>", errorTemplate: "<h1>Cal-Eats mail sign-in was not completed</h1><p>Return to the project to review the connection status.</p>", openBrowser: async url => {
      fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
      fs.writeFileSync(pendingFile, JSON.stringify({ url, signInUser: settings.signInUser, sender: settings.sender, permission }), { mode: 0o600, flag: "w" });
      console.log(`Complete Microsoft sign-in using the private instructions at ${pendingFile}. No email will be sent.`);
    } });
  } finally { try { fs.unlinkSync(pendingFile); } catch (error) { if (error.code !== "ENOENT") throw error; } }
}
const accounts = (await client.getTokenCache().getAllAccounts()).filter(account => account.username?.toLowerCase() === settings.signInUser.toLowerCase());
if (accounts.length !== 1) throw new Error("The approved sender mailbox must sign in before mail can be enabled");
const result = await client.acquireTokenSilent({ account: accounts[0], scopes });
if (!result?.accessToken || !result.scopes.some(scope => scope.split("/").at(-1).toLowerCase() === permission.toLowerCase())) throw new Error("Send-only permission was not granted");
console.log(JSON.stringify({ connected: true, sender: settings.sender, signInUser: settings.signInUser, permission, encryptedCache: true, emailSent: false, realSendingEnabled: config.orderAlertEmail.mode === "graph" && settings.enabled }));
}
main().catch(error => { const code = String(error?.errorCode || error?.code || "MAIL_CONNECTION_FAILED"); console.error(/^[A-Za-z][A-Za-z0-9_-]{0,70}$/.test(code) ? code : "MAIL_CONNECTION_FAILED"); process.exitCode = 1; });
