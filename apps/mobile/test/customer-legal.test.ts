import assert from "node:assert/strict";
import test from "node:test";
import { customerLegalPayload, customerLegalReady, inactiveCustomerLegal, type CustomerLegalStatus } from "../src/customer-legal.ts";
const current: CustomerLegalStatus = { enabled: true, terms: { version: "fictional-terms-1", sha256: "a".repeat(64), url: "https://eats.calai.info/legal/terms/fictional-terms-1", effectiveAt: "2026-01-01T00:00:00.000Z" }, privacy: { version: "fictional-privacy-2", sha256: "b".repeat(64), url: "https://eats.calai.info/legal/privacy/fictional-privacy-2", effectiveAt: "2026-01-01T00:00:00.000Z" }, termsAcceptanceRequired: true, privacyAcknowledgementRequired: true };
test("customer legal confirmation has one affirmative Terms choice and keeps marketing independent", () => {
  assert.equal(customerLegalReady(null, { termsAccepted: true }), false);
  assert.equal(customerLegalPayload(inactiveCustomerLegal, { termsAccepted: false }), undefined);
  assert.equal(customerLegalReady(current, { termsAccepted: false }), false);
  assert.throws(() => customerLegalPayload(current, { termsAccepted: false }));
  const payload = customerLegalPayload(current, { termsAccepted: true })!;
  assert.equal(payload.termsAccepted, true); assert.equal(payload.privacyNoticeAcknowledged, true);
  assert.equal("marketing" in payload, false); assert.equal("processingConsent" in payload, false);
  const privacyOnly = customerLegalPayload({ ...current, termsAcceptanceRequired: false }, { termsAccepted: false })!;
  assert.equal("termsAccepted" in privacyOnly, false); assert.equal(privacyOnly.privacyVersion, "fictional-privacy-2");
});
