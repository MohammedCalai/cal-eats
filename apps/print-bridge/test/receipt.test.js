import assert from "node:assert/strict";
import test from "node:test";
import { escPosBytes, formatReceipt } from "../src/receipt.js";
import { receipt } from "./helpers.js";

test("formats integer-GBP receipt and removes injected control characters", () => {
  const result = formatReceipt(receipt({ restaurantName: "Kitchen\u001b[2J", items: [{ name: "Fish\u0000 & chips", quantity: 1, unitPriceMinor: 999, totalMinor: 999 }], subtotalMinor: 999, totalMinor: 1199 }), { manualReprint: true });
  assert.match(result.text, /CAL-EATS/);
  assert.match(result.text, /MANUAL REPRINT/);
  assert.match(result.text, /£9\.99/);
  assert.doesNotMatch(result.text, /\u001b|\u0000/);
  const bytes = escPosBytes(result.text);
  assert.deepEqual([...bytes.subarray(0, 5)], [0x1b, 0x40, 0x1b, 0x74, 0x00]);
});

test("rejects non-integer money and non-GBP receipts", () => {
  assert.throws(() => formatReceipt(receipt({ totalMinor: 12.5 })), /integer pence/);
  assert.throws(() => formatReceipt(receipt({ currency: "USD" })), /must be GBP/);
});
