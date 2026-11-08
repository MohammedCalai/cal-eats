# Customer legal and privacy release

The owner reviewed the customer Terms and authorised CALAI LTD’s full registered office. The Privacy Notice was prepared from tested application behaviour, a source audit and current primary provider sources on 8 November 2026. Packaged text is in apps/api/legal-documents. A committed file does not activate a policy.

## Implemented locally

- Immutable actual-text legal archives, exact SHA-256 checking and public pre-login HTML/text routes when activated.
- One unticked Terms acceptance checkbox. Privacy provision, marketing and optional allergy consent remain separate.
- Atomic signup acceptance and new-order gating. Login, existing history, support, privacy requests and original idempotent order recovery remain available.
- Per-order applicable legal snapshots, receipt references and the actual accepted Terms in confirmation emails.
- Password-confirmed in-app deletion intake, optional reason, internal administrator review, real eligible-data erasure, revoked login and encrypted completion notification. Active orders, payment/support work, uncertain dispatch and legal holds block completion. Monetary records and minimal legal evidence remain.
- Policy-controlled retention/minimisation and a separate default-off approval gate for health-note collection.
- Restore clearance requires an authoritative external, pinned suppression ledger. Integrity-only checks do not clear a restored copy for service.

## Configuration

CALAI_CUSTOMER_LEGAL_ENABLED and CALAI_CUSTOMER_PRIVACY_ENABLED both default to false. Activate them together only after the release gates below pass.

CALAI_CUSTOMER_LEGAL_MANIFEST_JSON contains documents.terms and documents.privacy. Each needs version, sha256, canonical same-origin URL, canonical UTC approvedAt/effectiveAt, approvalReference and exactly one of text or a safe packaged archiveFile filename. Text bytes must match the hash; existing versions cannot be replaced.

CALAI_CUSTOMER_PRIVACY_MANIFEST_JSON contains the matching version, canonical UTC approvedAt, approvalReference, retention and the one-calendar-month deletion target. Health collection additionally requires explicit supplier-scope approval; customer consent cannot expand a processor contract.

The proposed schedule is chat bodies 30 days from creation; eligible terminal-order allergy notes 30 days; terminal-order contacts 90 days; resolved support content 12 calendar months. Necessary accounting records have a six-year minimum, not a blanket retention of all personal information. Financial records are not automatically purged by the retention worker.

## Before activation and store submission

1. Review the final notice and exact operational retention commitments. An instruction to write a notice is not evidence of a supplier contract.
2. Confirm processor and UK transfer arrangements in the actual supplier accounts. Railway’s public DPA requires execution and lists no special-category data. Keep optional health collection off until appropriate coverage is confirmed.
3. Confirm Expo’s binding push-processing terms, Microsoft tenant/product coverage, and Postcodes.io precise-location processing scope/location/safeguard. Public privacy pages alone do not prove account contract coverage.
4. Record actual backup/log expiry and protect a current authoritative erasure-suppression ledger outside restorable backups. Apply deletion restrictions before a restored copy returns to service.
5. Operate a safe expiry/review process for private local mail spools and independent operational copies. Delivered emails and restaurant paper receipts cannot be recalled by an app migration; explain relevant exceptions in deletion responses.
6. Review App Store privacy answers against the final native build and provider facts. No inference of no tracking is made solely from the absence of an advertising SDK.
7. Coordinate hosted migrations, legal/privacy activation and native release. Verify legal links, signup, existing-user acceptance and deletion using temporary fixtures only.

No live customer erasure, financial changes, provider-key changes, hosted activation or store submission is performed by this local phase. The owner phone app remains on hold.

New customer signup also queues a welcome/verification service email. Verification is required for new orders from newly registered accounts; pre-existing accounts keep their existing access. Login, browsing, support and privacy requests stay available while verification is pending. This is separate from marketing consent.
