import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ApiError } from "../src/api-client.js";
import { readCredential, writeCredential } from "../src/credential-store.js";
import { ensureCredential } from "../src/setup.js";
import { removeWorkspace, temporaryWorkspace } from "./helpers.js";

const restaurantId = "a1111111-1111-4111-8111-111111111111";
const printerId = "b2222222-2222-4222-8222-222222222222";
const clock = () => new Date("2026-11-14T10:00:00Z");

async function workspace(t, overrides = {}) {
  const directory = await temporaryWorkspace("setup");
  t.after(() => removeWorkspace(directory));
  const config = { deviceName: "Test kitchen printer", credentialPath: path.join(directory, "var", "device-credential.json") };
  const setupPath = path.join(directory, "setup.json");
  const setup = { schemaVersion: 1, product: "cal-eats", restaurantId, printerId, code: "one-use-test-setup-code", expiresAt: "2026-11-21T10:00:00Z", ...overrides };
  await fs.writeFile(setupPath, JSON.stringify(setup));
  return { directory, config, setupPath, setup, pendingPath: `${config.credentialPath}.pairing-pending.json`, clock };
}

function identity(token, overrides = {}) { return { deviceId: "device_test_00000001", restaurantId, printerId, token, ...overrides }; }

test("first start saves its generated secret before pairing and discards setup only after authenticated confirmation", async (t) => {
  const state = await workspace(t);
  const stages = [];
  const api = { pair: async (code, name, token) => {
    stages.push("pair");
    const pending = JSON.parse(await fs.readFile(state.pendingPath, "utf8"));
    assert.equal(code, state.setup.code);
    assert.equal(name, state.config.deviceName);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(pending.token, token);
    assert.equal(pending.restaurantId, restaurantId);
    assert.equal(pending.printerId, printerId);
    assert.equal(Object.hasOwn(pending, "code"), false);
    return identity(token);
  } };
  const saved = await ensureCredential({ ...state, api, verify: async (credential) => {
    stages.push("verify");
    assert.equal((await readCredential(state.config.credentialPath)).token, credential.token);
    await fs.access(state.setupPath);
  } });
  assert.deepEqual(stages, ["pair", "verify"]);
  assert.equal(saved.printerId, printerId);
  await assert.rejects(fs.access(state.setupPath), { code: "ENOENT" });
  await assert.rejects(fs.access(state.pendingPath), { code: "ENOENT" });
});

test("lost pairing response and process restart reuse the same durable token without creating a second identity", async (t) => {
  const state = await workspace(t);
  let firstToken;
  let calls = 0;
  const api = { pair: async (_code, _name, token) => {
    calls += 1;
    if (calls === 1) { firstToken = token; throw new ApiError("Device API response was interrupted", { retryable: true }); }
    assert.equal(token, firstToken);
    return identity(token);
  } };
  await assert.rejects(ensureCredential({ ...state, api, verify: async () => {} }), /interrupted/);
  await fs.access(state.pendingPath);
  // A retry after expiry can recover an already-consumed code with its same secret.
  const afterExpiry = () => new Date("2026-11-22T10:00:00Z");
  const saved = await ensureCredential({ ...state, clock: afterExpiry, api, verify: async () => {} });
  assert.equal(saved.token, firstToken);
  assert.equal(calls, 2);
});

test("reinstall preserves working credentials and journal, even if the downloaded setup has expired", async (t) => {
  const state = await workspace(t, { expiresAt: "2026-11-01T00:00:00Z" });
  const credential = await writeCredential(state.config.credentialPath, identity("existing_abcdefghijklmnopqrstuvwxyz"), clock());
  const journalPath = path.join(state.directory, "var", "print-journal.json");
  const journal = '{"product":"cal-eats","jobs":{"existing":"do-not-reprint"}}';
  await fs.writeFile(journalPath, journal);
  const api = { pair: async () => assert.fail("A working installation must not pair again") };
  const saved = await ensureCredential({ ...state, api, verify: async (value) => assert.deepEqual(value, credential) });
  assert.deepEqual(saved, credential);
  assert.equal(await fs.readFile(journalPath, "utf8"), journal);
});

test("an offline credential check preserves its connection and bootstrap instead of replacing them", async (t) => {
  const state = await workspace(t);
  await writeCredential(state.config.credentialPath, identity("existing_abcdefghijklmnopqrstuvwxyz"), clock());
  const original = await fs.readFile(state.config.credentialPath, "utf8");
  await assert.rejects(ensureCredential({ ...state, api: { pair: async () => assert.fail("No pairing on network failure") }, verify: async () => { throw new ApiError("Device API is unavailable", { retryable: true }); } }), /unavailable/);
  assert.equal(await fs.readFile(state.config.credentialPath, "utf8"), original);
  await fs.access(state.setupPath);
});

test("revoked credentials can be replaced by a fresh bound setup without clearing the print journal", async (t) => {
  const state = await workspace(t);
  await writeCredential(state.config.credentialPath, identity("revoked_abcdefghijklmnopqrstuvwxyz"), clock());
  let checks = 0;
  const saved = await ensureCredential({ ...state, api: { pair: async (_code, _name, token) => identity(token) }, verify: async () => { if (++checks === 1) throw new ApiError("Not authorised", { status: 401 }); } });
  assert.equal(checks, 2);
  assert.notEqual(saved.token, "revoked_abcdefghijklmnopqrstuvwxyz");
});

test("new expired setup is rejected with a safe actionable error and no API request", async (t) => {
  const state = await workspace(t, { expiresAt: "2026-11-01T00:00:00Z" });
  await assert.rejects(ensureCredential({ ...state, api: { pair: async () => assert.fail("Expired setup must not pair") }, verify: async () => {} }), (error) => error.code === "SETUP_EXPIRED" && /Download a fresh printer setup/.test(error.message) && !error.message.includes(state.setup.code));
});

test("another product's saved connection is never reused or overwritten", async (t) => {
  const state = await workspace(t);
  await fs.mkdir(path.dirname(state.config.credentialPath), { recursive: true });
  const original = JSON.stringify({ product: "calai", token: "original-product-secret" });
  await fs.writeFile(state.config.credentialPath, original);
  await assert.rejects(ensureCredential({ ...state, api: { pair: async () => assert.fail("Wrong product must not pair") }, verify: async () => assert.fail("Wrong product must not authenticate") }), { code: "WRONG_PRODUCT" });
  assert.equal(await fs.readFile(state.config.credentialPath, "utf8"), original);
});

test("pairing response identity mismatch does not overwrite a saved connection", async (t) => {
  const state = await workspace(t);
  await writeCredential(state.config.credentialPath, identity("revoked_abcdefghijklmnopqrstuvwxyz"), clock());
  const original = await fs.readFile(state.config.credentialPath, "utf8");
  await assert.rejects(ensureCredential({ ...state, api: { pair: async (_code, _name, token) => identity(token, { printerId: "c3333333-3333-4333-8333-333333333333" }) }, verify: async () => { throw new ApiError("Revoked", { status: 401 }); } }), { code: "PRINTER_IDENTITY_MISMATCH" });
  assert.equal(await fs.readFile(state.config.credentialPath, "utf8"), original);
});

test("failed confirmation keeps durable identity and setup for safe recovery without another pairing", async (t) => {
  const state = await workspace(t);
  let pairCalls = 0;
  const api = { pair: async (_code, _name, token) => { pairCalls += 1; return identity(token); } };
  await assert.rejects(ensureCredential({ ...state, api, verify: async () => { throw new ApiError("Response interrupted", { retryable: true }); } }), /interrupted/);
  await fs.access(state.setupPath);
  await fs.access(state.pendingPath);
  await readCredential(state.config.credentialPath);
  await ensureCredential({ ...state, api, verify: async () => {} });
  assert.equal(pairCalls, 1);
});

test("rejected setup and unexpected server token stop safely without disclosing secrets", async (t) => {
  const state = await workspace(t);
  await assert.rejects(ensureCredential({ ...state, api: { pair: async () => { throw new ApiError(state.setup.code, { status: 409 }); } }, verify: async () => {} }), (error) => error.code === "SETUP_REJECTED" && !error.message.includes(state.setup.code));
  await assert.rejects(ensureCredential({ ...state, api: { pair: async () => identity("unexpected_abcdefghijklmnopqrstuvwxyz") }, verify: async () => assert.fail("Unexpected token must not authenticate") }), { code: "INVALID_PAIR_RESPONSE" });
  await assert.rejects(fs.access(state.config.credentialPath), { code: "ENOENT" });
});
