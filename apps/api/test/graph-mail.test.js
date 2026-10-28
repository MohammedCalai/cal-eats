import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEncryptedMailCache, createGraphMailAdapter, loadGraphMailConfig } from "../src/graph-mail.js";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cal-eats-mail-"));
  t.after(() => { const target = fs.realpathSync(directory), parent = fs.realpathSync(os.tmpdir()); assert.equal(path.dirname(target), parent); fs.rmSync(target, { recursive: true, force: true }); });
  return loadGraphMailConfig({ tenantId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", clientId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", sender: "sender@example.invalid", enabled: true }, path.join(directory, "test.sqlite"), {});
}
test("mail token cache is encrypted, mailbox-bound and fails closed on tampering", async t => {
  const settings = fixture(t), plugin = createEncryptedMailCache(settings, { allowCreateKey: true });
  let restored;
  await plugin.afterCacheAccess({ cacheHasChanged: true, tokenCache: { serialize: () => "PRIVATE_TEST_TOKEN" } });
  assert.ok(!fs.readFileSync(settings.cacheFile, "utf8").includes("PRIVATE_TEST_TOKEN"));
  await plugin.beforeCacheAccess({ tokenCache: { deserialize: value => { restored = value; } } });
  assert.equal(restored, "PRIVATE_TEST_TOKEN");
  await assert.rejects(createEncryptedMailCache({ ...settings, sender: "other@example.invalid" }).beforeCacheAccess({ tokenCache: { deserialize() {} } }), /MAIL_CACHE_DECRYPT_FAILED/);
  const cache = JSON.parse(fs.readFileSync(settings.cacheFile)); cache.tag = Buffer.alloc(16).toString("base64"); fs.writeFileSync(settings.cacheFile, JSON.stringify(cache));
  await assert.rejects(plugin.beforeCacheAccess({ tokenCache: { deserialize() {} } }), /MAIL_CACHE_DECRYPT_FAILED/);
});
test("Graph mail validates sender, checks cancellation after auth and preserves uncertain outcomes", async t => {
  const settings = fixture(t); fs.writeFileSync(settings.cacheFile, "test fixture"); fs.writeFileSync(settings.keyFile, "test fixture");
  let calls = 0, responseStatus = 202, throwNetwork = false;
  const adapter = createGraphMailAdapter(settings, {
    clientFactory: async () => ({ getTokenCache: () => ({ getAllAccounts: async () => [{ username: settings.sender }] }), acquireTokenSilent: async () => ({ accessToken: "TEST_ONLY", scopes: ["Mail.Send"] }) }),
    fetchImpl: async (url, request) => {
      calls++; assert.equal(url, "https://graph.microsoft.com/v1.0/me/sendMail"); assert.equal(request.redirect, "error");
      const payload = JSON.parse(request.body); assert.equal(payload.message.toRecipients.length, 1); assert.equal(payload.message.toRecipients[0].emailAddress.address, "customer@example.invalid"); assert.equal(payload.saveToSentItems, true);
      if (throwNetwork) throw new Error("sensitive provider details must not leak");
      return { status: responseStatus };
    }
  });
  const message = { id: "event-1", from: settings.sender, to: "customer@example.invalid", subject: "Order confirmed", text: "Open the app" };
  assert.equal((await adapter({ ...message, from: "wrong@example.invalid" })).errorCode, "GRAPH_SENDER_MISMATCH");
  assert.equal((await adapter(message, { beforeSend: () => false })).status, "cancelled"); assert.equal(calls, 0);
  assert.equal((await adapter(message)).status, "sent");
  responseStatus = 403; assert.equal((await adapter(message)).status, "failed");
  responseStatus = 503; assert.equal((await adapter(message)).status, "unknown");
  throwNetwork = true; assert.deepEqual(await adapter(message), { status: "unknown", errorCode: "GRAPH_NETWORK_OUTCOME_UNKNOWN" });
});
test("shared mailbox connection authenticates its approved member and requests only shared sending", async t => {
  const settings = { ...fixture(t), signInUser: "operator@example.invalid", sender: "caleats-support@example.invalid" };
  fs.writeFileSync(settings.cacheFile, "fixture"); fs.writeFileSync(settings.keyFile, "fixture");
  const adapter = createGraphMailAdapter(settings, {
    clientFactory: async () => ({ getTokenCache: () => ({ getAllAccounts: async () => [{ username: settings.signInUser }, { username: "unrelated@example.invalid" }] }), acquireTokenSilent: async request => {
      assert.equal(request.account.username, settings.signInUser); assert.deepEqual(request.scopes, ["https://graph.microsoft.com/Mail.Send.Shared"]);
      return { accessToken: "TEST_ONLY", scopes: ["Mail.Send.Shared"] };
    } }),
    fetchImpl: async (url, request) => { assert.equal(url, "https://graph.microsoft.com/v1.0/me/sendMail"); assert.equal(JSON.parse(request.body).message.from.emailAddress.address, settings.sender); return { status: 202 }; }
  });
  assert.equal((await adapter({ id: "shared-check", from: settings.sender, to: "owner@example.invalid", subject: "Connection check", text: "Test fixture" })).status, "sent");
});
