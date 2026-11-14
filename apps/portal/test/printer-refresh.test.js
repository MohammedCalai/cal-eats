import assert from "node:assert/strict";
import { test } from "node:test";
import { refreshPrinterSnapshot, printerRefreshState } from "../src/printer-refresh.js";

test("a brief service restart recovers the printer snapshot automatically", async () => {
  let calls = 0; const waits = [];
  const snapshot = [{ id: "home", status: "online" }];
  const value = await refreshPrinterSnapshot(async () => {
    if (++calls < 3) throw Object.assign(new Error("private deployment response"), { status: 503 });
    return snapshot;
  }, { sleep: async delay => { waits.push(delay); } });
  assert.equal(value, snapshot); assert.equal(calls, 3); assert.deepEqual(waits, [500, 1000]);
});

test("persistent interruptions stop after three reads and authentication is not retried", async () => {
  let calls = 0;
  await assert.rejects(refreshPrinterSnapshot(async () => { calls++; throw new TypeError("Failed to fetch"); }, { sleep: async () => {} }));
  assert.equal(calls, 3); calls = 0;
  const denied = Object.assign(new Error("private auth response"), { status: 401 });
  await assert.rejects(refreshPrinterSnapshot(async () => { calls++; throw denied; }), error => error === denied);
  assert.equal(calls, 1); assert.equal(printerRefreshState(denied), "sign_in");
  assert.equal(printerRefreshState(new TypeError("private network error")), "reconnecting");
});

test("request timeout retries and unmount cancellation stops further reads", async () => {
  let calls = 0;
  const value = await refreshPrinterSnapshot(signal => {
    if (++calls === 2) return Promise.resolve([]);
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Timeout", "AbortError")), { once: true }));
  }, { timeoutMs: 10, sleep: async () => {} });
  assert.deepEqual(value, []); assert.equal(calls, 2);
  const controller = new AbortController(); calls = 0;
  await assert.rejects(refreshPrinterSnapshot(async () => { calls++; controller.abort(); throw new TypeError("offline"); }, { signal: controller.signal }), /offline/);
  assert.equal(calls, 1);
});
