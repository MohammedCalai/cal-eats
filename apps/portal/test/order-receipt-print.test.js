import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createReceiptPrintRequests } from "../src/order-receipt-print.js";

const scope = () => ({ businessId: randomUUID(), restaurantId: randomUUID(), orderId: randomUUID() });
const queued = () => ({ id: randomUUID(), manualReprint: true, status: "queued" });
function tab() {
  const records = new Map();
  const options = { storage: () => ({
    getItem: key => records.get(key),
    setItem: (key, value) => records.set(key, value),
    removeItem: key => records.delete(key),
  }) };
  return { reload: () => createReceiptPrintRequests(options) };
}

test("two mounted buttons share one pending queue request", async () => {
  const requests = tab().reload(), order = scope(), printer = randomUUID();
  let finish;
  const queuedByServer = new Promise(resolve => { finish = resolve; });
  const sent = [];
  const first = requests.submit(order, printer, id => { sent.push(id); return queuedByServer; });
  const second = requests.submit(order, printer, id => { sent.push(id); return queued(); });
  assert.strictEqual(first, second);
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
  await assert.rejects(initial.submit(order, printer, id => {
    firstId = id;
    throw Object.assign(new Error("Lost response"), { status: 0 });
  }), /Lost response/);
  const reloaded = browser.reload();
  assert.deepEqual(reloaded.read(order), { printerId: printer, requestId: firstId });
  await assert.rejects(reloaded.submit(order, randomUUID(), () => assert.fail("Printer changed")), /could not be confirmed/);
  await assert.rejects(reloaded.submit(order, printer, id => {
    assert.equal(id, firstId);
    throw Object.assign(new Error("Permission changed"), { status: 403 });
  }), /Permission changed/);
  await assert.rejects(reloaded.submit(order, printer, async id => {
    assert.equal(id, firstId);
    return { ...original, manualReprint: false };
  }), /could not be confirmed/);
  assert.equal(reloaded.read({ ...order, restaurantId: randomUUID() }), null);
  assert.equal(reloaded.read(order).requestId, firstId);
  const result = await reloaded.submit(order, printer, async id => {
    assert.equal(id, firstId);
    return { ...original, replay: true };
  });
  assert.equal(result.id, original.id);
  assert.equal(reloaded.read(order), null);
});

test("a refusal before sending any copy releases the request and unavailable tab storage blocks sending", async () => {
  const order = scope(), printer = randomUUID();
  const requests = tab().reload();
  await assert.rejects(requests.submit(order, printer, () => {
    throw Object.assign(new Error("Order not confirmed"), { status: 409 });
  }), /not confirmed/);
  assert.equal(requests.read(order), null);

  const unavailable = createReceiptPrintRequests({ storage: () => { throw new Error("blocked"); } });
  await assert.rejects(unavailable.submit(order, printer, () => assert.fail("A receipt was sent")), /keep track/);
});
