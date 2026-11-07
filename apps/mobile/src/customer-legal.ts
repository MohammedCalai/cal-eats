export type CustomerLegalDocument = { version: string; sha256: string; url: string; effectiveAt: string };
export type CustomerLegalStatus = { enabled: boolean; terms: CustomerLegalDocument | null; privacy: CustomerLegalDocument | null; termsAcceptanceRequired: boolean; privacyAcknowledgementRequired: boolean };
export type CustomerLegalChoices = { termsAccepted: boolean };
export const inactiveCustomerLegal: CustomerLegalStatus = { enabled: false, terms: null, privacy: null, termsAcceptanceRequired: false, privacyAcknowledgementRequired: false };

export function customerLegalReady(status: CustomerLegalStatus | null, choices: CustomerLegalChoices) {
  return Boolean(status && (!status.enabled || (!status.termsAcceptanceRequired || choices.termsAccepted)));
}

export function customerLegalPayload(status: CustomerLegalStatus | null, choices: CustomerLegalChoices) {
  if (!customerLegalReady(status, choices)) throw new Error("Please review the current Terms and Privacy Notice before continuing.");
  if (!status?.enabled) return undefined;
  return {
    ...(status.termsAcceptanceRequired && status.terms ? { termsVersion: status.terms.version, termsSha256: status.terms.sha256, termsAccepted: true } : {}),
    ...(status.privacyAcknowledgementRequired && status.privacy ? { privacyVersion: status.privacy.version, privacySha256: status.privacy.sha256, privacyNoticeAcknowledged: true } : {})
  };
}
