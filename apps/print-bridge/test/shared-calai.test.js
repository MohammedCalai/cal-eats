import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { patchCalaiBridge } from "../src/patch-calai.js";
import { sharedPrinterTransport } from "../src/shared-calai.js";
import { acquireLock } from "../src/instance-lock.js";
import { temporaryWorkspace, removeWorkspace } from "./helpers.js";

test("shared printer uses the existing routine and refuses a different printer", async () => {
  const native = { PRINTER_TYPE: "NETWORK", PRINTER_IP: "192.0.2.40", PRINTER_PORT: 9100 };
  const config = { transport: { kind: "tcp-escpos", host: native.PRINTER_IP, port: 9100, connectTimeoutMs: 500 } };
  const sent = [];
  const transport = sharedPrinterTransport(native, config, async (...args) => { sent.push(args); });
  assert.equal((await transport.send({ receiptText: "Cal-Eats test £1.00" })).outcome, "uncertain");
  assert.deepEqual(sent, [[native.PRINTER_IP, 9100, "Cal-Eats test £1.00"]]);
  assert.throws(() => sharedPrinterTransport(native, { transport: { ...config.transport, host: "192.0.2.41" } }, () => {}), /same network printer/);
  const failed = sharedPrinterTransport(native, config, async () => { throw new Error("private error"); });
  await assert.rejects(failed.send({ receiptText: "private receipt" }), error => error.ambiguous && !error.message.includes("private"));
});

for (const fixture of ["calai-native.js.txt", "calai-native-current.js.txt", "calai-native-managed.js.txt"]) test(`native source ${fixture} preserves polling and serializes both queues`, async () => {
  const directory = await temporaryWorkspace("shared-calai");
  try {
    const source = await fs.readFile(new URL(`fixtures/${fixture}`, import.meta.url), "utf8");
    const patched = patchCalaiBridge(source);
    assert.equal(patchCalaiBridge(patched), patched);
    assert.match(patched, /async function pollServer/);
    assert.match(patched, /config\.BACKEND_URL.*printer\/poll/);
    assert.throws(() => patchCalaiBridge(source + "// unexpected update"), /not been reviewed/);
    const target = path.join(directory, "print-bridge.mjs");
    await fs.writeFile(target, patched);
    await promisify(execFile)(process.execPath, ["--check", target]);
    // Disable both polling entry points in this harness. Only the generated
    // dispatch wrapper executes; no network/printer/API operation is possible.
    const isolated = patched.replace(/\npollServer\(\);/, "\n// original poll disabled for test").replace(/\nconnectCalEats\(\);/, "\n// new poll disabled for test");
    const harness = isolated + `
let active = 0, maximum = 0, order = [];
calaiOriginalNetworkPrinter = async (_ip, _port, text) => {
  maximum = Math.max(maximum, ++active); order.push(text);
  await new Promise(resolve => setTimeout(resolve, 5)); active--;
  if (text === "failed Calai job") throw new Error("simulated failure");
};
const results = await Promise.allSettled([
  sendToNetworkPrinter("192.0.2.40", 9100, "failed Calai job"),
  sendToNetworkPrinter("192.0.2.40", 9100, "Cal-Eats job"),
  sendToNetworkPrinter("192.0.2.40", 9100, "next Calai job"),
]);
if (maximum !== 1 || order.join("|") !== "failed Calai job|Cal-Eats job|next Calai job" || results[1].status !== "fulfilled") process.exitCode = 1;
`;
    await fs.writeFile(target, harness);
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({ BACKEND_URL: "http://127.0.0.1:1", PRINTER_TYPE: "NETWORK", PRINTER_IP: "192.0.2.40", PRINTER_PORT: 9100 }));
    await promisify(execFile)(process.execPath, [target], { cwd: directory, timeout: 10000 });
  } finally { await removeWorkspace(directory); }
});

test("shared bridge refuses a second consumer using its journal", async () => {
  const directory = await temporaryWorkspace("shared-lock");
  try {
    const journal = path.join(directory, "journal.json");
    const release = await acquireLock(journal);
    await assert.rejects(acquireLock(journal), /Another Cal-Eats/);
    await release();
    await (await acquireLock(journal))();
  } finally { await removeWorkspace(directory); }
});

test("Windows managed installation produces the reviewed source without executing native code", { skip: process.platform !== "win32" }, async () => {
  const directory = await temporaryWorkspace("shared-windows-install");
  try {
    const source = await fs.readFile(new URL("fixtures/calai-native-current.js.txt", import.meta.url), "utf8");
    const native = path.join(directory, "print-bridge.js");
    await fs.writeFile(native, source);
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({ BACKEND_URL: "https://api.calai.info/api", PRINTER_TYPE: "NETWORK", PRINTER_IP: "192.0.2.40", PRINTER_PORT: 9100, PRINTER_TOKEN: "synthetic-native-identity" }));
    const configuration = JSON.parse(await fs.readFile(new URL("../config.example.json", import.meta.url), "utf8"));
    Object.assign(configuration, { apiBaseUrl: "https://eats.calai.info", transport: { kind: "tcp-escpos", enabled: true, host: "192.0.2.99", port: 9100, connectTimeoutMs: 5000 } });
    const configPath = path.join(directory, "download.json"), setupPath = path.join(directory, "setup.json");
    await fs.writeFile(configPath, JSON.stringify(configuration));
    await fs.writeFile(setupPath, JSON.stringify({ schemaVersion: 1, product: "cal-eats", printerId: "11111111-1111-4111-8111-111111111111", restaurantId: "22222222-2222-4222-8222-222222222222", code: "synthetic-setup-code", expiresAt: "2099-01-01T00:00:00Z" }));
    const installed = await promisify(execFile)(path.join(process.env.WINDIR, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("../windows/connect-shared-calai.ps1", import.meta.url)), "-ConfigPath", configPath, "-SetupPath", setupPath, "-CalaiBridgePath", native, "-NodePath", path.join(process.env.ProgramFiles, "nodejs/node.exe")], { timeout: 20000, env: { ...process.env, PSModulePath: [path.join(process.env.WINDIR, "System32/WindowsPowerShell/v1.0/Modules"), path.join(process.env.ProgramFiles, "WindowsPowerShell/Modules")].join(";") } });
    assert.match(installed.stdout, /True/);
    assert.equal(await fs.readFile(native, "utf8"), patchCalaiBridge(source));
    assert.equal(await fs.readFile(`${native}.before-cal-eats`, "utf8"), source);
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, "cal-eats/config.json"), "utf8")).transport.host, "192.0.2.40");
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, "config.json"), "utf8")).PRINTER_TOKEN, "synthetic-native-identity");
    assert.equal(await fs.readFile(path.join(directory, "cal-eats/runtime/src/shared-calai.js"), "utf8"), await fs.readFile(new URL("../src/shared-calai.js", import.meta.url), "utf8"));
  } finally { await removeWorkspace(directory); }
});
