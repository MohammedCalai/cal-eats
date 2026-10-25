# Cal-Eats expansion — current local state

Updated 25 October 2026. The original request is preserved in `CAL_EATS_NEXT_PHASE_REQUEST.txt`; the former intake narrative is archived at `archive/NEXT_PHASE_INTAKE.md`. The requirement-level map is `EXPANSION_ACCEPTANCE.md`.

## Source isolation

Original Calai commit `ab138fd17c9ac4fc6e0b34ef5044754be643056c` was inspected from an immutable filtered reference. Backend, frontend and printer audits are complete. Cal-Eats is independently written; calling, agents, telephony, subscriptions, production URLs, credentials and live data were not imported.

The original Calai GitHub account/repository is permanently no-write. Future publication requires a separate account/repository, destination TBD. The accidental reference test discovery and subsequent 364/364 hash verification are recorded in `SOURCE_TEST_DISCOVERY_INCIDENT.md`.

## Implemented locally

- Landing page at `http://127.0.0.1:4310/`, with working postcode discovery, restaurant application and business sign-in links. Planned independent host: `eats.calai.info` using the user's existing domain; no DNS or deployment changes. See `LANDING_AND_DOMAIN.md`.
- Customer browser/PWA at `http://127.0.0.1:4310/order/`: accounts, Luton discovery, menu/modifiers, delivery/collection, mock-card/cash checkout, history/status, offers, support, refund cases, addresses and account controls.
- React owner/admin portal at `http://127.0.0.1:4310/business/`; Vite development at `http://127.0.0.1:4311/business/`. It covers orders, menu/photos/CSV/hours, offers/customers, printers, finance/payout reporting, refunds, restaurant administration, operations and governance.
- API schema through v18: marketplace finance/refunds/printers/native auth, governance v16, durable Stripe-test provider events v17 and per-waiting-episode refund deadlines v18.
- Native Expo/React Native source. A connected runtime exercise completed two mock checkouts and a refund enquiry. It remains unsigned and untested on an iPhone.
- Independent print bridge with scoped credentials, leases, crash journal and file-sink default. An isolated API-to-real-CLI run paired, claimed, wrote three artifacts and acknowledged once. No physical printer was used.
- Test-only Stripe adapter and signed event reconciliation boundary. No Stripe request, credential, endpoint registration or provider money movement occurred.
- Synthetic load evidence in `LOAD_RESULTS_2026-10-25.json`: 10,001 accounts, 100 restaurants, 20 concurrent clients and 120/120 completed orders with zero HTTP errors in a short one-host SQLite WAL run.

## Financial truth

Integer-pence journal, commission snapshots, settlement eligibility, cash receivables/collections, refunds, transfer recovery, payout batches, reports and exceptions are implemented as local simulator behaviour. The simulator can progress its own payout batch to a clearly labelled simulated `paid` state; that is not a provider-confirmed bank payout.

Provider-event v17 can safely ingest and retrieve supported Stripe-test object state, but no authorised sandbox has exercised provider-created charges, captures, transfers, refunds, reversals, mandates or payouts. Simulator and provider truth must remain visibly distinct.

## Evidence limits

- Phone screenshots are responsive browser captures, not native-device screenshots.
- The load result proves only its short isolated workload, not multi-node or production capacity.
- Docker packaging exists but Docker was unavailable, so no image or mounted volume was verified.
- File-sink output proves the local device protocol, not paper, cutter, Windows installation or hardware recovery.

## Remaining local software work

1. Complete provider-backed orchestration for charge/capture/cancel, transfers, refunds/reversals, mandates/collections, payout reconciliation and unknown outcomes once an authorised Stripe sandbox is available.
2. Add provider-backed failed-refund and post-bank-payout recovery/negative-balance operations; approve evidence retention/deletion rules.
3. Add general user-profile mutation only if required; audited account access and restaurant permissions already exist.
4. Run longer failure-oriented load exercises and design PostgreSQL-compatible persistence/multi-instance coordination before horizontal-scale claims.
5. Complete accessibility, recovery, monitoring, rollback, retention and production-security work without importing original Calai connections.

## Genuine external, native and hardware gates

- Stripe test account/key, Connect eligibility, hosted onboarding, webhook endpoint and sandbox matrix.
- Apple Developer ownership, signing/provisioning, iPhone checks, Apple Pay entitlement/sandbox and store review.
- Separately authorised Windows tablet and physical printer tests.
- Approved commercial, tax, consumer-remedy, Bacs notice, privacy and retention decisions.
- Separately authorised hosting, HTTPS/domain, secrets, storage/backups and incident operations.

No GitHub push, Expo EAS build, Railway/provider activation, DNS change, paid infrastructure action or live deployment is authorised by this document.
