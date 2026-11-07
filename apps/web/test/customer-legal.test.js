import assert from "node:assert/strict";
import test from "node:test";
import { customerLegalHtml, customerLegalPayload } from "../customer-legal.js";
const status = { enabled: true, terms: { version: "fictional-terms-1", sha256: "a".repeat(64), url: "https://eats.calai.info/legal/terms/fictional-terms-1" }, privacy: { version: "fictional-privacy-2", sha256: "b".repeat(64), url: "https://eats.calai.info/legal/privacy/fictional-privacy-2" }, termsAcceptanceRequired: true, privacyAcknowledgementRequired: true };
test("legal form presents one unticked Terms checkbox, informational privacy, and no marketing consent", () => {
  const html = customerLegalHtml(status, "https://eats.calai.info");
  assert.equal((html.match(/type="checkbox"/g) || []).length, 1); assert.doesNotMatch(html, /checked|name=".*consent|I consent/);
  assert.match(html, /Read Customer Terms/); assert.match(html, /not general consent to processing/);
  assert.throws(() => customerLegalPayload(status, false));
  assert.equal(customerLegalPayload(status, true).privacyNoticeAcknowledged, true);
  const privacyOnly = { ...status, termsAcceptanceRequired: false };
  assert.doesNotMatch(customerLegalHtml(privacyOnly, "https://eats.calai.info"), /type="checkbox"/);
  assert.equal("termsAccepted" in customerLegalPayload(privacyOnly, false), false);
  assert.equal(customerLegalHtml({ enabled: false }, "https://eats.calai.info"), "");
  assert.throws(() => customerLegalHtml({ ...status, terms: { ...status.terms, url: "https://unrelated.invalid/legal/v1" } }, "https://eats.calai.info"));
});
