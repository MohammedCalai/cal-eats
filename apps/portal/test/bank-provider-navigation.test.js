import assert from "node:assert/strict";
import test from "node:test";
import { bankProviderDestination } from "../src/bank-provider-navigation.js";

test("secure provider links preserve the embedded workspace and the ordinary bank redirect", () => {
  const calls = [], approved = ["bank.example.invalid"];
  const url = "https://bank.example.invalid/onboarding/sample";
  const standalone = {location: {assign: value => calls.push(value)}};
  standalone.parent = standalone;
  const embedded = {parent: standalone, location: standalone.location};
  assert.equal(bankProviderDestination(url, approved, embedded), url);
  assert.equal(calls.length, 0);
  assert.equal(bankProviderDestination(url, approved, standalone), null);
  assert.deepEqual(calls, [url]);
  for (const invalid of ["https://other.example.invalid/x", "https://bank.example.invalid:8080/x",
    "http://bank.example.invalid/x", "https://other@bank.example.invalid/x", "javascript:void(0)"]) {
    for (const view of [standalone, embedded]) assert.throws(() => bankProviderDestination(invalid, approved, view));
  }
  assert.deepEqual(calls, [url]);
});
