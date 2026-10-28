import test from "node:test";
import assert from "node:assert/strict";
import { caseEvidencePath, minorUnits, validateBase } from "../src/model.ts";

test("business credentials can target the separate Cal-Eats API but never original Calai", () => {
  assert.equal(validateBase("https://eats.calai.info/"), "https://eats.calai.info");
  assert.equal(validateBase("http://127.0.0.1:4313"), "http://127.0.0.1:4313");
  for (const address of ["https://www.calai.info", "https://calai.info", "https://api.calai.info", "https://calai.info./", "http://eats.calai.info", "https://user:pass@eats.calai.info", "https://eats.calai.info/owner", "https://eats.calai.info?token=secret"]) assert.throws(() => validateBase(address));
});

test("menu prices and offers use exact minor units and reject malformed money", () => {
  assert.equal(minorUnits("9.29"), 929);
  assert.equal(minorUnits("0.05"), 5);
  assert.equal(minorUnits("10"), 1000);
  for (const value of ["-1", "1.001", "£10", "NaN", "1e3", "100000.01"]) assert.throws(() => minorUnits(value));
});

test("refund evidence must match its case before adding an authenticated image request", () => {
  assert.equal(caseEvidencePath("case-1", { id: "photo-1", url: "/api/refund-cases/case-1/evidence/photo-1" }), "/api/refund-cases/case-1/evidence/photo-1");
  for (const url of ["https://other.example/photo-1", "/api/refund-cases/case-2/evidence/photo-1", "/api/refund-cases/case-1/evidence/photo-1?next=https://other.example"]) assert.equal(caseEvidencePath("case-1", { id: "photo-1", url }), null);
  assert.equal(caseEvidencePath("../case-1", { id: "photo-1", url: "/api/refund-cases/../case-1/evidence/photo-1" }), null);
});
