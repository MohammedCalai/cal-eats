# Cal-Eats source reuse and marketplace expansion

Received 25 October 2026. The full user brief is preserved in CAL_EATS_NEXT_PHASE_REQUEST.txt. This phase is **not complete**; the earlier schema-v9 local milestone remains available.

## Source and isolation status

- Existing writable project: this Calai-Eats folder, branch `codex/local-app`, baseline `4400813bef39a41d13436bdda6220810ad6968c3`. Preserve its history and useful work.
- Original Calai URL: **not supplied**; the attached brief contains a placeholder. Connected GitHub repository search did not locate the original project. The current local project has no configured Git remote.
- Original source commit: **unknown**. No reference checkout or duplicate of original Calai has been created. Do not label the current prototype as that duplicate.
- Dashboard screenshot and any separate Thermal Print Bridge repository: **not supplied**.
- Original Calai source, live APIs, production data, tablets, printers and infrastructure remain untouched. No original secrets or data were read or copied.

When source arrives, inspect it read-only at a recorded commit. Download an inspection reference without running project scripts there. Inspect manifests, routes, jobs, hooks and deployment connections before allowing execution in a separate sanitized writable copy. Exclude source Git history/hooks, secrets, dumps, logs, recordings, tokens and infrastructure state. Preserve licences. Never configure original Calai as a push destination. Establish the current prototype's API/domain mapping before restructuring it.

## Evidence-based reuse map

| Area | Existing local implementation | New work still required |
| --- | --- | --- |
| Architecture | Node 24 HTTP API, built-in SQLite/WAL, plain browser modules and PWA assets | Confirm original React/Laravel versions and integration boundaries from source |
| Accounts and tenancy | Customer/owner/staff/admin access, server-side memberships, sessions, recovery, addresses and exports | Map original auth and native-client access; production hardening |
| Menus and orders | Delivery/collection, modifiers, availability, photo upload, CSV import, idempotent checkout, order snapshots/statuses | Reuse original models where suitable; preparation estimates and native iPhone client |
| Contracts and finance | Integer-pence commission, historical rate/policy snapshots, demo 24-month agreement, commission/refund entries, manual cash settlement records | Explicit contract start/end lifecycle; provider-backed earnings, fees, transfers, payouts, reconciliation and exception handling |
| Refunds | Admin simulated-card/manual-cash refunds, amount caps, idempotency and historical-rate reversals | Customer complaint cases, private evidence, restaurant responses, decisions, reminders, monthly flags/goodwill policy and confirmed provider execution |
| Printing | Escaped 80mm HTML receipts and browser handoff/reprint records | Inspect/adapt isolated Windows bridge; pairing, heartbeats, durable jobs, uncertain-print handling and hardware testing |
| Scale | Single-instance SQLite preview, local expiry/outbox workers | Multi-instance database/queue strategy, pagination, background reports, metrics and measured load tests |
| Branding | Original Calai artwork preserved; browser surfaces renamed Cal-Eats | Match original restaurant dashboard after screenshot/source inspection |

Evidence: `apps/api/src/journey.js`, `operations.js`, `product.js`, `polish.js`, `auth/authorization.js`, `db/migrations.js`, `payments/mock.js`, `packages/contracts/src/index.js`, and `apps/web/`. Existing contract and security tests are reusable acceptance cases; language/framework reuse remains unverified. Current Stripe and Apple Pay adapters deliberately throw. Browser print acknowledgement is not proof of paper output. No 10,000-account dataset or load test has run.

## Proposed financial direction — not implemented or activated

These are development design notes, not approved live terms. Existing historical orders retain their current food-only, delivery-excluded commission policy. The new brief's phrase “order value” requires an explicit versioned base before a new calculation is introduced. Keep 700 basis points, exact pence, no additional platform fees and provider costs borne by Cal-Eats. Do not invent VAT or change snapshots retroactively.

Evaluate separate charges and transfers for the marketplace: the platform can retain its commission when transferring restaurant earnings, but refunds and transfer reversals are separate operations. A reversal can fail when recoverable funds are unavailable; record recovery separately and do not indefinitely block the customer's remedy. This is a candidate pending the actual backend/account configuration, not a claim of provider integration. [Stripe charge/transfer documentation](https://docs.stripe.com/connect/separate-charges-and-transfers?locale=es-ES), [transfer reversals](https://docs.stripe.com/api/transfer_reversals).

Proposed development flow: authorise at checkout, capture on restaurant acceptance, cancel on rejection/expiry, and make completed non-refunded earnings eligible for transfer subject to provider fund availability and a specific order hold. Validate authorisation expiry and capture failures in sandbox. Persist durable intents before external calls and reconcile ambiguous outcomes before retrying. Preserve separate earnings, pending, available, transfer and payout states.

Use one bank-payout mechanism: provider automatic weekly payouts as the development default, with app workers responsible for eligible transfers and reconciliation rather than also creating scheduled bank payouts. Actual configuration depends on the platform's controls and account type. [Stripe payout schedules](https://docs.stripe.com/connect/manage-payout-schedule).

Use provider-hosted business onboarding and refresh capabilities/requirements from the provider. Returning to our page cannot establish approval. Account configuration and liability allocation still need resolution. [Stripe hosted onboarding](https://docs.stripe.com/connect/hosted-onboarding).

Cash sales never become restaurant payout funds. A potential separate commission-collection path is Bacs Direct Debit from the restaurant to Cal-Eats, conditional on provider eligibility and an explicit mandate. Bacs is asynchronous and requires mandate/notification handling; do not treat a submitted debit as collected. No mandate, debit or offset is authorised or implemented here. A revoked mandate or failed collection must remain an exception with retry-safe references. [Stripe Bacs documentation](https://docs.stripe.com/payments/bacs-debit).

Complaint submission must only create a case. Reserve approved refundable amounts transactionally; enforce cumulative caps across cases and financial operations. Record each admin decision separately from execution. Provider outcomes drive processing/refunded/failed states. Keep cross-restaurant complaint history admin-only; a London-calendar-month repeat flag or goodwill limit must never automatically reject a claim. Evidence stays private and tenant-scoped. Exact implementation contracts follow the source inspection.

## Next executable steps

1. Obtain the original repository URL, dashboard screenshot and bridge source if separate; inspect and record the original commit.
2. Complete the reuse/removal map, select backend and native-client boundaries, and create a sanitized isolated source copy without overwriting this prototype.
3. Freeze shared APIs/schema, then delegate backend/financial foundations, portal/refund cases and iPhone client to gpt-5.6-sol agents with separate file ownership.
4. Build locally with explicit simulations until separate sandbox credentials/hardware are available. Verify real provider/hardware paths separately. No push, hosted build, live money, deployment or device changes are authorised.

Commercial assumptions can remain configurable for local development. Live activation requires explicit policies and provider verification. Do not use missing commercial choices to stop unrelated implementation. The present source-dependent blocker is the missing original repository, not approval to perform safe local work.

## Work performed in this intake

Two existing gpt-5.6-sol agents handled the current-code audit and independent branding changes. Updated browser titles/copy, header, offline page, manifest and icon framing; the original PNG is unchanged. Local mail subjects and startup copy also use Cal-Eats. Internal package/configuration/storage names remain unchanged for compatibility. The current browser preview was restarted and visually inspected at 390 by 844 pixels; screenshot 32 records the new single-line wordmark. The temporary viewport override was reset afterwards.

Changed JavaScript syntax, manifest JSON and whitespace checks passed. No functional suite, provider sandbox, native build, load test or physical printer test was run during this branding/intake change. Original-source inspection and the expanded marketplace implementation remain outstanding.
