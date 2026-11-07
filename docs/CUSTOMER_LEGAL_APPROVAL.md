# Customer legal review scaffold — not activated

The customer terms and privacy notice are awaiting owner review. This change contains no operative legal document, active version, approval reference or public policy page. `CALAI_CUSTOMER_LEGAL_ENABLED` defaults to false and the manifest is deliberately absent. No live database or hosting setting was changed.

## Implemented locally

- Migration 46 adds approved-document metadata and append-only application acceptance history. Evidence records the authenticated customer, exact version and SHA-256, server time, web/native channel and signup/new-order context. Ordinary retries do not rewrite that evidence.
- An active manifest must explicitly include both documents, canonical UTC approval/effective dates, approval reference, exact string versions/hashes, and dedicated same-origin `/legal/` URLs. Existing approved versions cannot be replaced with different metadata.
- New account creation checks affirmative Terms acceptance and the provided Privacy Notice version. User and evidence creation share one transaction.
- Existing customers can sign in and use existing orders, conversations, support, account summary and deletion requests. Only a **new** order requires the current Terms and notice. Original idempotent order recovery does not require a later version.
- Customer UI has one mandatory, unticked Terms checkbox. Privacy notice provision is acknowledged with the signup/new-order confirmation action, using the displayed version/hash; it is not consent to all processing. A privacy-only revision does not ask customers to accept unchanged Terms again.
- Optional marketing stays separate and defaults remain off. No health-data/allergy consent is inferred from accepting the Terms.

## Required before activation

1. Owner approves the exact final customer terms and privacy text, controller/contact/supplier facts, retention schedule and implementation commitments. Do not use the fictional document metadata in tests.
2. Publish the approved versions at immutable, version-specific public URLs and keep archived copies of the **actual text**. The current ledger stores metadata, not the text itself: a hash plus a mutable URL is not a completed durable-contract-copy solution.
3. Add a per-order reference/snapshot of the applicable terms and deliver the accepted terms and order confirmation in a durable form, such as the confirmation email with the actual terms copy or a stable downloadable attachment. The current acceptance ledger alone does not implement that delivery.
4. Verify the manifest-driven Account and guest/signup links against the actual approved public documents. The read-only UI now selects approved links when enabled and keeps development notices only for an explicitly disabled manifest. Public `/legal/` document text is deliberately not served by this scaffold.
5. Implement and verify the genuine in-app deletion flow and permitted retention/minimisation, including processors/backups, before claiming deletion is complete. The existing support-verified action closes login access only.
6. Resolve the optional allergy-note health-data treatment and provide just-in-time information/any required consent separately. Complete the factual App Store privacy answers and declaration review.
7. Only after these items pass, create the approved manifest in private hosting configuration and deliberately enable the feature. Run a focused native/web new-account and existing-user/version-update acceptance check. A server rollout should coordinate the active manifest so older instances cannot apply a superseded policy.

## Configuration shape

`CALAI_CUSTOMER_LEGAL_MANIFEST_JSON` is an operator-approved JSON object with `documents.terms` and `documents.privacy`. Each contains `version`, `sha256`, `url`, `approvedAt`, `approvalReference` and `effectiveAt`. There are intentionally no copyable live/example versions here. Public hosted origins are HTTPS; loopback HTTP is allowed only through the existing local development configuration. A document that is not yet effective fails closed for legal review/new orders; sign-in and existing-account rights remain available.

Account-erasure retention and any eventual evidence purge must follow the approved retention policy. Acceptance history has no dependency on ephemeral login sessions and survives a sanitized backup. No erasure operation is provided or run by this scaffold.
