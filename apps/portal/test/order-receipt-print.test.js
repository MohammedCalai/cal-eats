import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createReceiptPrintRequests } from "../src/order-receipt-print.js";

const scope = () => ({ businessId: randomUUID(), restaurantId: randomUUID(), orderId: randomUUID() });
const queued = () => ({ id: randomUUID(), manualReprint: true, status: "queued" });
const one = id => () => [{ id, name: "Receipt printer" }];
function tab() {
  const records = new Map();
  const options = { storage: () => ({
    getItem: key => records.get(key),
    setItem: (key, value) => records.set(key, value),
    removeItem: key => records.delete(key),
  }) };
  return { reload: () => createReceiptPrintRequests(options) };
}

test("two mounted buttons share one request while the printer lookup is still pending", async () => {
  const requests = tab().reload(), order = scope(), printer = randomUUID();
  let finish, showPrinters, sentToQueue;
  const queuedByServer = new Promise(resolve => { finish = resolve; });
  const lookup = new Promise(resolve => { showPrinters = resolve; });
  const started = new Promise(resolve => { sentToQueue = resolve; });
  const sent = [];
  const first = requests.submit(order, () => lookup, (printerId, id) => {
    assert.equal(printerId, printer);
    sent.push(id); sentToQueue(); return queuedByServer;
  });
  const second = requests.submit(order, () => assert.fail("Printer was looked up twice"), () => assert.fail("Receipt was queued twice"));
  assert.strictEqual(first, second);
  assert.equal(sent.length, 0);
  showPrinters(one(printer)());
  await started;
  assert.equal(sent.length, 1);
  assert.deepEqual(requests.read(order), { printerId: printer, requestId: sent[0] });
  finish(queued());
  await first;
  assert.equal(requests.read(order), null);
});

test("lost queue confirmation survives a page reload and pins the exact receipt and printer", async () => {
  const browser = tab(), order = scope(), printer = randomUUID(), initial = browser.reload();
  const original = queued();
  let firstId;
  await assert.rejects(initial.submit(order, one(printer), (_, id) => {
    firstId = id;
    throw Object.assign(new Error("Lost response"), { status: 0 });
  }), /Lost response/);
  const reloaded = browser.reload();
  assert.deepEqual(reloaded.read(order), { printerId: printer, requestId: firstId });
  await assert.rejects(reloaded.submit(order, one(randomUUID()), () => assert.fail("Printer changed")), /could not be confirmed/);
  await assert.rejects(reloaded.submit(order, one(printer), (_, id) => {
    assert.equal(id, firstId);
    throw Object.assign(new Error("Permission changed"), { status: 403 });
  }), /Permission changed/);
  await assert.rejects(reloaded.submit(order, one(printer), async (_, id) => {
    assert.equal(id, firstId);
    return { ...original, manualReprint: false };
  }), /could not be confirmed/);
  assert.equal(reloaded.read({ ...order, restaurantId: randomUUID() }), null);
  assert.equal(reloaded.read(order).requestId, firstId);
  const result = await reloaded.submit(order, () => [...one(randomUUID())(), ...one(printer)()], async (printerId, id) => {
    assert.equal(printerId, printer, "the saved destination must be reused");
    assert.equal(id, firstId);
    return { ...original, replay: true };
  });
  assert.equal(result.id, original.id);
  assert.equal(reloaded.read(order), null);
});

test("a refusal before sending any copy releases the request and unavailable tab storage blocks sending", async () => {
  const order = scope(), printer = randomUUID();
  const requests = tab().reload();
  await assert.rejects(requests.submit(order, one(printer), () => {
    throw Object.assign(new Error("Order not confirmed"), { status: 409, code: "ORDER_NOT_CONFIRMED" });
  }), /not confirmed/);
  assert.equal(requests.read(order), null);
  await assert.rejects(requests.submit(order, one(printer), () => {
    throw Object.assign(new Error("The printer needs a paired device"), { status: 409, code: "PRINTER_DEVICE_REQUIRED" });
  }), /paired device/);
  assert.equal(requests.read(order), null);

  const unavailable = createReceiptPrintRequests({ storage: () => { throw new Error("blocked"); } });
  await assert.rejects(unavailable.submit(order, one(printer), () => assert.fail("A receipt was sent")), /keep track/);
});

test("a tablet proof or session rejection can follow a queued job and keeps the first request ID", async () => {
  for (const [status, code] of [[403, "TABLET_WINDOW_PROOF_REQUIRED"], [409, "TABLET_SESSION_CHANGED"]]) {
    const browser = tab(), order = scope(), printer = randomUUID(), jobs = new Map();
    const first = browser.reload();
    await assert.rejects(first.submit(order, one(printer), (_, id) => {
      jobs.set(id, queued());
      throw Object.assign(new Error("Local proof changed"), { status, code });
    }), /Local proof changed/);
    await browser.reload().submit(order, one(printer), (_, id) => {
      assert.ok(jobs.has(id), "the existing job ID must be reused");
      return { ...jobs.get(id), replay: true };
    });
    assert.equal(jobs.size, 1);
  }
});

test("multiple printers require a destination, and choosing one queues only that copy", async () => {
  const order = scope(), requests = tab().reload();
  const printers = [{ id: randomUUID(), name: "Kitchen" }, { id: randomUUID(), name: "Front counter" }];
  assert.deepEqual(await requests.submit(order, () => printers, () => assert.fail("Printer guessed")),
    { printerChoices: printers });
  assert.equal(requests.read(order), null);
  const result = await requests.submit(order, () => printers, printer => {
    assert.equal(printer, printers[1].id);
    return queued();
  }, printers[1].id);
  assert.equal(result.printerName, printers[1].name);
});
