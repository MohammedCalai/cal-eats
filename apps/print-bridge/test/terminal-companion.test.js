import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { TerminalClient, merchantRequestAllowed } from "../src/terminal-client.js";
import { createCompanionServer } from "../src/terminal-companion.js";
import { WindowsTerminalKey, pairingCanonical, requestCanonical, sha256 } from "../src/terminal-signing.js";
import { temporaryWorkspace, removeWorkspace } from "./helpers.js";

const terminalId = "b2222222-2222-4222-8222-222222222222", restaurantId = "a1111111-1111-4111-8111-111111111111";
function memoryKey() {
  const keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = { publicKeySpki: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"), provider: "Microsoft Software Key Storage Provider", machineKey: true, nonExportable: true, aclVerified: true };
  return { keys, publicKey, factory: () => ({ publicKey: async () => publicKey, sign: async canonical => crypto.sign("sha256", Buffer.from(canonical), { key: keys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") }) };
}
test("Windows key adapter accepts only verified P256/P1363 and rejects exportable-key policy", async () => {
  const memory = memoryKey();
  const helper = async (_name, request) => ({ ...memory.publicKey, ...(request.action === "sign" ? { signature: crypto.sign("sha256", Buffer.from(request.messageBase64, "base64"), { key: memory.keys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") } : {}) });
  const key = new WindowsTerminalKey(terminalId, { helper });
  assert.equal((await key.publicKey({ create: true })).nonExportable, true);
  const canonical = pairingCanonical({ terminalId, challenge: "c".repeat(43), publicKeySpki: memory.publicKey.publicKeySpki });
  assert.equal((await key.sign(canonical)).length, 86);
  await assert.rejects(key.sign("arbitrary browser string"), /context/);
  await assert.rejects(new WindowsTerminalKey(terminalId, { helper: async () => ({ ...memory.publicKey, nonExportable: false }) }).publicKey(), /policy/);
  await assert.rejects(new WindowsTerminalKey(terminalId, { helper: async () => ({ ...memory.publicKey, aclVerified: false }) }).publicKey(), /policy/);
  await assert.rejects(new WindowsTerminalKey(terminalId, { helper, provider: "tpm" }).publicKey(), /provider changed/);
});
test("exact raw body and query are signed with a fresh nonce per request; USER delegation stays only in memory", async t => {
  const directory = await temporaryWorkspace("terminal-client"); t.after(() => removeWorkspace(directory));
  const key = memoryKey(), calls = [];
  const client = new TerminalClient({ baseUrl: "http://127.0.0.1:4310", identityPath: path.join(directory, "terminal.json"), keyFactory: key.factory, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), ...options });
    let data = {};
    if (url.pathname.endsWith("/pair")) data = { terminalId, restaurantId };
    if (url.pathname.endsWith("/session")) data = { sessionToken: "s".repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString(), user: { id: "owner" } };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  await client.pair({ terminalId, code: "one-use-test-code", challenge: "c".repeat(43), deviceName: "Unit test terminal" });
  const connected = await client.connectSession({ terminalId, handoffToken: "h".repeat(43) });
  assert.equal(JSON.stringify(connected).includes("s".repeat(43)), false);
  const target = `/api/restaurant/restaurants/${restaurantId}/orders?scope=live&limit=9`;
  await client.signed("GET",target,{}, {session:true}); await client.signed("GET",target,{}, {session:true});
  await client.forward({method:"GET",path:`/api/restaurant/restaurants/${restaurantId}/operations-health`},{userProof:connected.userProof});
  assert.equal(calls.at(-1).body,undefined,"The actual signed HTTP GET has no JSON body");
  const signed = calls.slice(1);
  assert.equal(new Set(signed.map(call => call.headers["X-Cal-Eats-Terminal-Nonce"])).size, signed.length);
  for (const call of signed) {
    const canonical = requestCanonical({ terminalId, timestamp: call.headers["X-Cal-Eats-Terminal-Timestamp"], nonce: call.headers["X-Cal-Eats-Terminal-Nonce"], method: call.method, target: new URL(call.url).pathname + new URL(call.url).search, body: call.body || "" });
    assert.equal(crypto.verify("sha256", Buffer.from(canonical), { key: key.keys.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(call.headers["X-Cal-Eats-Terminal-Signature"], "base64url")), true);
  }
  assert.equal(calls.at(-1).headers["X-Cal-Eats-Terminal-Session"], "s".repeat(43));
  const fs = await import("node:fs/promises");
  assert.equal((await fs.readFile(client.identityPath, "utf8")).includes("s".repeat(43)), false);
  assert.equal((await fs.readFile(client.identityPath, "utf8")).includes(connected.userProof), false);
  assert.equal(sha256("a"), sha256(Buffer.from("a")));
});
test("merchant forwarder rejects off-origin, encoded, other-restaurant, auth and unrestricted signing targets", () => {
  for (const target of ["https://evil.invalid/api/x", "/api/auth/login", "/api/admin/users", `/api/restaurant/restaurants/${terminalId}/printers`, `/api/restaurant/restaurants/${restaurantId}/printers`, `/api/restaurant/restaurants/${restaurantId}/printers/printer_id_123/setup-package`, `/api/restaurant/restaurants/${restaurantId}/%2e%2e/terminal`, `/api/restaurant/restaurants/${restaurantId}/terminal/revoke`]) assert.equal(merchantRequestAllowed("POST", target, restaurantId), false, target);
  assert.equal(merchantRequestAllowed("PATCH", "/api/restaurant/orders/order_test_123/status", restaurantId), true);
  assert.equal(merchantRequestAllowed("GET",`/api/restaurant/restaurants/${restaurantId}/operations-health`,restaurantId),true);
  for(const target of [`/api/restaurant/restaurants/${terminalId}/operations-health`,`/api/restaurant/restaurants/${restaurantId}/operations-health?all=true`,`/api/restaurant/restaurants/${restaurantId}/orders`,`/api/restaurant/restaurants/${restaurantId}/finance/stripe/banking`])assert.equal(merchantRequestAllowed("GET",target,restaurantId),false,target);
  assert.equal(merchantRequestAllowed("PATCH","/api/restaurant/incidents/incident_test_123/read",restaurantId),true);
  assert.equal(merchantRequestAllowed("POST","/api/restaurant/incidents/incident_test_123/read",restaurantId),false);
});
function callLocal(server, { origin = "https://eats.calai.info", host, method = "GET", path = "/v1/bootstrap", token, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port: server.address().port, method, path, headers: { ...(origin === null ? {} : { origin }), ...(host ? { host } : {}), ...(token ? { "X-Cal-Eats-CSRF": token } : {}), ...(body ? { "content-type": "application/json" } : {}) } }, response => { let text = ""; response.on("data", chunk => text += chunk); response.on("end", () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : {}, headers: response.headers })); });
    request.on("error", reject); request.end(body ? JSON.stringify(body) : undefined);
  });
}
test("loopback interface denies arbitrary/missing Origin, DNS rebinding, CSRF and a signing oracle", async t => {
  let calls = 0;
  const client = { identity: null, paired: false, session: null, pair: async () => { calls++; return { paired: true }; } };
  const server = createCompanionServer({ client, port: 0 }); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  for (const options of [{ origin: "https://evil.invalid" }, { origin: null }, { host: "evil.invalid" }]) assert.equal((await callLocal(server, options)).status, 403);
  const bootstrap = await callLocal(server); assert.equal(bootstrap.status, 200); assert.equal(bootstrap.body.csrfToken.length, 43);
  assert.equal(bootstrap.headers["access-control-allow-origin"], "https://eats.calai.info");
  assert.equal((await callLocal(server, { method: "POST", path: "/v1/pair", body: {} })).status, 403);
  assert.equal((await callLocal(server, { method: "POST", path: "/v1/pair", token: "é".repeat(43), body: {} })).status, 403);
  assert.equal((await callLocal(server, { method: "POST", path: "/v1/sign", token: bootstrap.body.csrfToken, body: { message: "bad" } })).status, 404);
  assert.equal(calls, 0);
  assert.equal((await callLocal(server, { method: "POST", path: "/v1/pair", token: bootstrap.body.csrfToken, body: {} })).status, 200);
  assert.equal(calls, 1);
});
