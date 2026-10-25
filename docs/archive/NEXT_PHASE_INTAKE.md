# Cal-Eats source reuse and marketplace expansion

Received 25 October 2026. The full user brief is preserved in CAL_EATS_NEXT_PHASE_REQUEST.txt. Substantial local implementation is complete, but the phase is **not production-accepted** because provider sandbox, signed native-device, physical printer, deployment and legal/commercial gates remain. See EXPANSION_ACCEPTANCE.md and SOURCE_TEST_DISCOVERY_INCIDENT.md; all 364 reference files subsequently matched the source archive.

## Source and isolation status

The user reinforced on 25 October: create nothing in the original Calai GitHub account. Future publication must use the other account and a separate Cal-Eats repository, after the exact destination is agreed. There is currently no configured remote and no remote repository, branch, pull request or workflow has been created by this build. Local development continues; publication remains deferred.

- Existing writable project: this Calai-Eats folder, branch `codex/local-app`, baseline `4400813bef39a41d13436bdda6220810ad6968c3`. Preserve its history and useful work.
- Original Calai URL: **https://github.com/calai-operation/calai-platform**. Located after the user signed into the browser as calai-operation; the connector and terminal Git connection could not access this private repository. The current local project has no configured Git remote.
- Original source commit: **ab138fd17c9ac4fc6e0b34ef5044754be643056c**. A commit-pinned ZIP was downloaded through the authenticated browser. A filtered read-only source snapshot is stored in ignored `reference/calai-platform-ab138fd`; this is not a Git clone. SOURCE_PROVENANCE.json records archive hash, selected files and exclusions. The original application was not started; accidental discovery executed reference unit tests as documented in SOURCE_TEST_DISCOVERY_INCIDENT.md. The existing prototype is independently written, not a duplicate of this source.
- Dashboard screenshot remains unavailable; the source establishes its layout. The Thermal Print Bridge was found in the same repository under backend/print-bridge.js and backend/intune.
- Original Calai source, live APIs, production data, tablets, printers and infrastructure remain untouched. No original secrets or data were read or copied.

Inspect the reference without running project scripts there. Audit manifests, routes, jobs, hooks and deployment connections before allowing execution in a separate sanitized writable copy. Exclude source Git history/hooks, secrets, dumps, logs, recordings, tokens and infrastructure state. Preserve licences and source attribution. Never configure original Calai as a push destination. SOURCE_BACKEND_AUDIT.md, SOURCE_FRONTEND_AUDIT.md and SOURCE_PRINTER_AUDIT.md record the completed static inspection.

## Evidence-based reuse map

| Area | Existing local implementation | New work still required |
| --- | --- | --- |
| Architecture | Node 24 HTTP API, built-in SQLite/WAL, plain browser modules and PWA assets | Original source confirmed React 19 / Express 4 / Prisma 6 / PostgreSQL / Redis, not Laravel; adapt source patterns into isolated React portal |
| Accounts and tenancy | Customer/owner/staff/admin access, server-side memberships, sessions, recovery, addresses and exports | Map original auth and native-client access; production hardening |
| Menus and orders | Delivery/collection, modifiers, availability, photo upload, CSV import, idempotent checkout, order snapshots/statuses | Reuse original models where suitable; preparation estimates and native iPhone client |
| Contracts and finance | Integer-pence commission, historical rate/policy snapshots, demo 24-month agreement, commission/refund entries, manual cash settlement records | Explicit contract start/end lifecycle; provider-backed earnings, fees, transfers, payouts, reconciliation and exception handling |
| Refunds | Admin simulated-card/manual-cash refunds, amount caps, idempotency and historical-rate reversals | Customer complaint cases, private evidence, restaurant responses, decisions, reminders, monthly flags/goodwill policy and confirmed provider execution |
| Printing | Escaped 80mm HTML receipts and browser handoff/reprint records | Inspect/adapt isolated Windows bridge; pairing, heartbeats, durable jobs, uncertain-print handling and hardware testing |
| Scale | Single-instance SQLite preview, local expiry/outbox workers | Multi-instance database/queue strategy, pagination, background reports, metrics and measured load tests |
| Branding | Original Calai artwork preserved; browser surfaces renamed Cal-Eats | Match original restaurant dashboard after screenshot/source inspection |

Evidence: `apps/api/src/journey.js`, `operations.js`, `product.js`, `polish.js`, `auth/authorization.js`, `db/migrations.js`, `payments/mock.js`, `packages/contracts/src/index.js`, and `apps/web/`. Source audits now establish the original architecture and selective reuse boundaries. Existing contract and security tests are reusable acceptance cases. Marketplace and native payment adapters are under construction; no provider sandbox or native Apple Pay verification has occurred. Browser print acknowledgement is not proof of paper output. A 10,001-account load harness is prepared in `scripts/load-marketplace.js`; results remain pending integration.

## Current local expansion status

- The connected React owner/admin portal is served by the API at `http://127.0.0.1:4310/business/`; Vite development is `http://127.0.0.1:4311/business/`.
- Marketplace finance/refund/printer APIs, native bearer auth, unsigned Expo/React Native source and the independent print bridge are present locally.
- Governance v16 provides audited account state, session revocation, restaurant permissions and refund-response reminders/escalations. Provider-event v17 provides signed test-event intake, durable deduplication and retrieval-based reconciliation while leaving the simulator untouched. Registered v18 gives each distinct waiting request its own deadline and notification identity.
- Stripe remains test-only and unactivated. Native source is unsigned/unverified on iPhone. File-sink printing is verified; physical printing is not. Docker packaging is unbuilt.
- `LOAD_RESULTS_2026-10-25.json` records a synthetic 10,001-account dataset: 20 concurrent clients completed 120/120 orders with zero HTTP errors in a short single-host SQLite WAL run. This is not 10,000 concurrent users or production capacity evidence.

## Proposed financial direction — not implemented or activated

These are development design notes, not approved live terms. Existing historical orders retain their current food-only, delivery-excluded commission policy. The new brief's phrase “order value” requires an explicit versioned base before a new calculation is introduced. Keep 700 basis points, exact pence, no additional platform fees and provider costs borne by Cal-Eats. Do not invent VAT or change snapshots retroactively.

Evaluate separate charges and transfers for the marketplace: the platform can retain its commission when transferring restaurant earnings, but refunds and transfer reversals are separate operations. A reversal can fail when recoverable funds are unavailable; record recovery separately and do not indefinitely block the customer's remedy. This is a candidate pending the actual backend/account configuration, not a claim of provider integration. [Stripe charge/transfer documentation](https://docs.stripe.com/connect/separate-charges-and-transfers?locale=es-ES), [transfer reversals](https://docs.stripe.com/api/transfer_reversals).

Proposed development flow: authorise at checkout, capture on restaurant acceptance, cancel on rejection/expiry, and make completed non-refunded earnings eligible for transfer subject to provider fund availability and a specific order hold. Validate authorisation expiry and capture failures in sandbox. Persist durable intents before external calls and reconcile ambiguous outcomes before retrying. Preserve separate earnings, pending, available, transfer and payout states.

Use one bank-payout mechanism: provider automatic weekly payouts as the development default, with app workers responsible for eligible transfers and reconciliation rather than also creating scheduled bank payouts. Actual configuration depends on the platform's controls and account type. [Stripe payout schedules](https://docs.stripe.com/connect/manage-payout-schedule).

Use provider-hosted business onboarding and refresh capabilities/requirements from the provider. Returning to our page cannot establish approval. Account configuration and liability allocation still need resolution. [Stripe hosted onboarding](https://docs.stripe.com/connect/hosted-onboarding).

Cash sales never become restaurant payout funds. A potential separate commission-collection path is Bacs Direct Debit from the restaurant to Cal-Eats, conditional on provider eligibility and an explicit mandate. Bacs is asynchronous and requires mandate/notification handling; do not treat a submitted debit as collected. No mandate, debit or offset is authorised or implemented here. A revoked mandate or failed collection must remain an exception with retry-safe references. [Stripe Bacs documentation](https://docs.stripe.com/payments/bacs-debit).

Complaint submission must only create a case. Reserve approved refundable amounts transactionally; enforce cumulative caps across cases and financial operations. Record each admin decision separately from execution. Provider outcomes drive processing/refunded/failed states. Keep cross-restaurant complaint history admin-only; a London-calendar-month repeat flag or goodwill limit must never automatically reject a claim. Evidence stays private and tenant-scoped. Exact implementation contracts follow the source inspection.

## Next executable steps

1. Completed: locate original source, record commit, create read-only filtered reference and audit backend, frontend and printer integration.
2. In progress: preserve the independent API's stronger order/auth/financial invariants; selectively adapt the source React portal and printer code into new app folders. Original backend has call-owned orders, Float money and unsafe authentication/webhook/device boundaries, so it is not transplanted wholesale.
3. In progress: additive MARKETPLACE_PHASE_CONTRACT.md and MARKETPLACE_API.md govern finance, refund cases, device API and source portal adaptation. gpt-5.6-sol agents own distinct code areas. Native iPhone work follows in the next available slot.
4. Build locally with explicit simulations until separate sandbox credentials/hardware are available. Verify real provider/hardware paths separately. No push, hosted build, live money, deployment or device changes are authorised.

Commercial assumptions can remain configurable for local development. Live activation requires explicit policies and provider verification. Do not use missing commercial choices to stop unrelated implementation. Browser source access is now available; the earlier missing-repository blocker is resolved.

## Work performed in this intake

Two existing gpt-5.6-sol agents handled the current-code audit and independent branding changes. Updated browser titles/copy, header, offline page, manifest and icon framing; the original PNG is unchanged. Local mail subjects and startup copy also use Cal-Eats. Internal package/configuration/storage names remain unchanged for compatibility. The current browser preview was restarted and visually inspected at 390 by 844 pixels; screenshot 32 records the new single-line wordmark. The temporary viewport override was reset afterwards.

Changed JavaScript syntax, manifest JSON and whitespace checks passed. No functional suite, provider sandbox, native build, load test or physical printer test was run during this branding/intake change. Original-source inspection and the expanded marketplace implementation remain outstanding.
