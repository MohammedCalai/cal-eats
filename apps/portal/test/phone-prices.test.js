import test from "node:test";
import assert from "node:assert/strict";
import { poundsInputMinor } from "../src/model.js";
test("phone price entry preserves exact pence and accepts decimal keyboards", () => {
  assert.equal(poundsInputMinor("12.50"), 1250); assert.equal(poundsInputMinor("12,50"), 1250);
  assert.equal(poundsInputMinor("0"), 0); assert.equal(poundsInputMinor("3.5"), 350);
  for (const value of ["", "1.234", "1e3", "-1", "Infinity", "100000.01"]) assert.throws(() => poundsInputMinor(value));
});
