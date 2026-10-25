# Cal-Eats expansion acceptance map

Updated 25 October 2026. This maps `CAL_EATS_NEXT_PHASE_REQUEST.txt` to the current local workspace. “Verified” means there is specific local automated or recorded browser evidence; it does not mean production, provider, device or legal acceptance.

## Safety and provenance

- **Accepted:** original Calai commit `ab138fd17c9ac4fc6e0b34ef5044754be643056c` was inspected as an immutable reference. The Cal-Eats implementations are separate under `apps/` and exclude calling/agent/subscription integrations. See `SOURCE_FRONTEND_AUDIT.md`, `SOURCE_BACKEND_AUDIT.md`, `SOURCE_PRINTER_AUDIT.md` and `SOURCE_PROVENANCE.json`.
- **Permanent restriction:** do not create or modify anything in the original Calai GitHub account or repository—no branch, commit, pull request, workflow, setting, secret, deployment or API write. Any eventual publication must use a separate account/repository expressly authorised by the user. No remote write has been authorised or performed.
- **Recorded exception:** an inherited unrestricted test command accidentally discovered dependency-free tests inside the read-only reference. It did not modify the reference; all 364 selected files subsequently matched their archive hashes. Those results are not Cal-Eats verification. See [SOURCE_TEST_DISCOVERY_INCIDENT.md](./SOURCE_TEST_DISCOVERY_INCIDENT.md).

## Implemented and locally verified

| Area | Accepted local evidence | Limit |
| --- | --- | --- |
| Existing customer browser journey | Registration/login, postcode discovery, menu/modifiers, delivery/collection basket, server-priced checkout, mock-card/cash choices, history/status, offers, saved addresses, account/support and refund-case UI exist in `apps/web`. Recorded 390 px browser walkthroughs cover the principal order and offer journey. | Responsive browser/PWA only; not App Store evidence. |
| Core API and tenant rules | Cookie auth, customer/restaurant/admin roles, menu/order lifecycle, offers, notifications, operational settings, account access and final-polish routes have focused API tests. Marketplace routes add owner-scoped finance/refunds/printers and admin views. | The newest marketplace wiring needs a final bounded full Cal-Eats run after current financial review changes land. |
| Commercial snapshots | Orders persist integer-pence totals, the agreed rate/policy snapshot and historical commission. Existing local policy is a clearly labelled 7%, 24-month development assumption. | This is not an executed restaurant contract or legal approval. |
| Refund cases | Customer ownership, item snapshots, optional private evidence, role-scoped access, admin decisions, cash confirmation separation, durable execution jobs, cumulative caps and configurable per-episode response reminders/escalations are implemented. | Reminder operation is accepted locally; real provider refund/reversal and approved retention policy remain incomplete. |
| Printer protocol and simulator | Scoped pairing, hashed device tokens, leases, replay-safe acknowledgement, explicit uncertain output and manual reprint are implemented. Tests cover restart semantics, and an isolated real API/bridge/file-sink run paired, claimed, wrote exactly three artifacts and acknowledged one job. | File output is not physical printer success; Windows-tablet installation, paper/cutter/rendering and hardware failure paths remain untested. |
| Repository/local operations | Explicit test discovery, release checks, backup/restore verification tooling, guarded hosted-preview mode and local runbooks exist. | No deployment, disaster-recovery drill on hosted infrastructure or production monitoring acceptance. |
| Governance | Schema v16 adds audited account enable/disable, session revocation, lockout safeguards, tenant-scoped memberships and configurable reminders/escalations. Registered v18 keys each distinct waiting episode so a later request to the same party receives a new deduplicated notification. Focused governance tests passed. | Reminders are in-app only and never decide cases. |
| Synthetic load | `LOAD_RESULTS_2026-10-25.json` records 10,001 accounts, 100 restaurants, 20 concurrent clients and 120/120 completed orders with zero HTTP errors on one host/shared SQLite WAL. | Short 13.8-second synthetic run; not 10,000 concurrent users, multi-node, provider, hardware or production capacity evidence. |

## Implemented but not yet accepted as end-to-end verified

| Area | Current implementation | Required acceptance evidence |
| --- | --- | --- |
| React restaurant/admin portal | `apps/portal` provides the retained operational surfaces plus audited account access, restaurant membership and deadline controls. It is served at `/business/` on API 4310; Vite development uses 4311 `/business/`. | Complete owner, staff and admin browser journeys against final migrations. Profile fields in the general user directory remain read-only; access state is governed separately. |
| Native iPhone client | `apps/mobile` implements native bearer auth, discovery/menu/basket, addresses, checkout, order history, offers, refund evidence and account flows. A connected runtime exercise completed two mock checkouts and a refund enquiry through the native API. | Source/runtime API success is not a signed iOS build or physical-device proof. Keychain, camera permissions, redirects, VoiceOver and Apple Pay remain device gates. |
| Marketplace accounting and reports | Journal/operations, settlement eligibility, payout batches, cash receivable/collection, London reporting and scoped background CSV reports are wired with focused integration coverage. The simulator may advance a batch through its explicit simulated lifecycle, including simulated `paid`. | A simulated `paid` batch is not a provider-confirmed bank payout. Real provider funds, arrival status and reconciliation require sandbox evidence. |
| Provider adapter/events | The test-key-only adapter covers onboarding, PaymentIntents, transfers/reversals, refunds, weekly payout configuration and Bacs boundaries. Schema v17 adds signed raw-event intake, durable deduplication/leasing and retrieval-based test reconciliation. | No Stripe request, credential or endpoint exists. The event boundary does not create charges/transfers/refunds/payouts and does not turn simulator rows into provider-paid money. Complete the authorised sandbox matrix. |
| Portal/PWA installation | Customer and business manifests/service workers are present; caching is intentionally limited to public/offline assets. | Confirm install/update/offline behaviour on target iPhone and Windows tablet over reviewed HTTPS. |
| Container/hosted preview | Non-root Node container and single-instance SQLite preview guidance exist. | Docker was unavailable locally; build, volume permissions, proxy/HTTPS, backup and shutdown behaviour need environment verification. This is not production readiness. |

## Missing local implementation or integration

These are software tasks, not external blockers:

1. **Connect provider-created money operations.** Provider-event v17 can ingest/retrieve state, but charge/capture/transfer/refund/reversal/payout route orchestration and unknown-outcome recovery still need authorised sandbox integration. Do not label an adapter/event/simulator record as money movement.
2. **Complete refund operations.** Response targets/reminders/escalation now exist. Remaining work is provider-backed failed-refund recovery, post-payout recovery/negative-balance handling and approved evidence retention/deletion policy.
3. **Complete cash-commission operations.** Integrate a reviewed test-mode mandate confirmation flow and asynchronous collection reconciliation, including revoked mandates, failures and retries. Recording a receivable is not collection.
4. **Admin breadth.** Account state and restaurant permissions are implemented and audited. General profile editing and any additional device-fleet actions still require explicit APIs; do not describe the read-only profile directory as full profile management.
5. **Persistence/scale work.** A measured local scenario now exists, but multi-instance database/queue coordination, longer runs and production-like observability remain. Evaluate PostgreSQL-compatible persistence before horizontal-scale claims.
6. **Release-quality product work.** Finalise approved terms/privacy/support copy, retention rules, accessibility/device QA, error monitoring, recovery exercises and production configuration without importing original Calai connections.

## Genuine external, native and hardware gates

These cannot be truthfully accepted by local code alone:

- Separate Stripe test account/key, Connect eligibility and authorised sandbox exercise; provider-hosted business verification and bank details; verified webhook endpoint; confirmed automatic weekly bank payout statuses and arrival data.
- Commercial/legal decisions for commission base, delivery/tax/discount treatment, consumer remedies, Bacs mandate notices, privacy/retention and the 24-month agreement.
- Apple Developer ownership, Merchant ID/entitlements, signing/provisioning, TestFlight/App Store review, Apple Pay sandbox and supported physical iPhone testing.
- A separately authorised Windows tablet and printer for installation, pairing, paper/cutter/legibility, restart and network-failure tests. Browser/socket success must not be described as printed paper.
- Independently authorised hosting, HTTPS/domain, secrets, persistent database/storage, backups, monitoring and incident response. No original Calai service or account may be reused.

## Acceptance language

Use these descriptions until the relevant gates pass:

- **Payments:** “local simulator” or “Stripe test adapter available; sandbox integration pending.”
- **Payouts:** use the stored state plus provenance: “simulated paid” is valid for the local worker; use unqualified/provider “paid” only after provider confirmation.
- **Printing:** “job queued/claimed/uncertain/file-sink simulated”; never “printed” without the explicit physical acknowledgement model and hardware evidence.
- **Mobile:** “native source and local bundle/type checks” until a signed build runs on a supported iPhone.
- **Scale:** “single-instance local/hosted-preview SQLite” until measured multi-instance durable persistence exists.

## Recommended local acceptance sequence

1. Run the explicit Cal-Eats test globs only; never unrestricted recursive discovery from the repository root.
2. Complete portal and mobile device/accessibility checks using the locked workspace.
3. Exercise one final simulator journey across customer, restaurant, admin, refund and payout/report surfaces.
4. Record remaining results without upgrading simulated, scheduled or unverified states.
