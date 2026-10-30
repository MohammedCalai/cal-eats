# Payment, settlement and printer audit / developer handover

Audit date: 30 October 2026. Source baseline: `b94092ee4657b01d93466a4ddf282155f76a0fa2`. This report adds documentation only. It does not enable payments, send mail, contact a printer, install software, or change an existing database. Paths and line references below refer to that source baseline.

## Evidence and boundaries

**Confirmed by source:** this checkout supports `local_simulator`, `stripe_test` and explicitly gated `stripe_live`; the implementation is not exclusively a mock/test adapter. The file name `payments/stripe-test.js` is misleading because it also exports `createStripeAdapter`. Live activation requires matching credentials, platform account binding, two webhook secrets, HTTPS production hosting and explicit enablement (`apps/api/src/config.js:27-40`). Live checkout also rejects demo commercial terms (`journey.js:383`). These safeguards do not prove production readiness.

**Historical evidence, not independently repeated:** [the 29 October Stripe trial](../STRIPE_TEST_TRIAL.md) records two genuine £6 sandbox Checkout authorizations/captures and full refunds, including recovery of one refund after an adapter error and normal worker completion of the second. It records Monday payout configuration and an empty payout history. It explicitly does not establish transfer execution, reversal execution, real bank payout settlement or live payment readiness. Older README statements that there has been no deployment or that live code never reads credentials conflict with the newer implementation/trial record; developers must distinguish source, documented deployment history and actual deployed configuration.

**Executed during this audit:** one isolated temporary fixture reproduced the expired-printer-claim defect below using the real API and `PrintBridge` class with an in-memory counting transport. The existing local/hosted databases, device credentials and physical printer were not used. The parent audit records the broader test run separately.

**Unverified:** currently deployed commit/configuration, Stripe account permission state, external webhook subscriptions, provider rate limits, platform liability arrangements, bank settlement, Surface/Intune configuration, printer model/code page, network stability, device installation and paper output. Existing documents are useful handover evidence but are not substitutes for these checks.

## Findings ranked by action priority

Priority P1 means resolve before the affected live-payment/physical-printer rollout or scale milestone. P2 means planned operational hardening. No code fix is included here.

| ID | Priority / evidence | Finding and impact | Recommendation and regression gate |
| --- | --- | --- | --- |
| PP-01 | P1 / reproduced | An expired print claim can be dispatched by two bridges. `marketplace.js:377` reassigns expired jobs, `:378` accepts any historically issued token, while `print-bridge/src/bridge.js:82` resumes a journal entry in `claimed` without checking lease or current server ownership. Multiple devices can pair to one printer. A sleeping/crashed bridge can resume after another bridge has already sent the receipt. | Introduce an explicit dispatch authorization/fencing protocol and an uncertainty state before reassignment. Check ownership before physical dispatch, but do not assume a lease check alone gives exactly-once paper. Keep ambiguous jobs out of automatic reprint. Test two devices, expired claims, network partitions, resume before/after dispatch and lost acknowledgements. |
| PP-02 | P1 / source-derived bound | The main process invokes financial reconciliation and statement workers once per minute, serially, with overlap suppression (`main.js:35-49,64`). Provider event reconciliation, Stripe movements and weekly statements each default to 25 items (`provider-events.js:51`, `stripe-connect.js:201`, `business-weekly-statements.js:142`). A queue can grow indefinitely above nominal 25 items/minute per process; slow upstream calls delay later queues. | Extract existing worker functions into separately supervised processes with bounded concurrency and continuous queue draining. Add queue-age/depth metrics, fairness and measured provider throttling. Keep database ownership/lease invariants. Validate at target arrival rate and failure conditions before adding replicas. |
| PP-03 | P1 before live / confirmed source gap | Out-of-band Stripe refunds/chargebacks are not financially reconciled. `provider-events.js:378` maps `charge.*` and `refund.*` to a PaymentIntent; `:276-285` updates payment state, not refund amounts, disputes, ledger recovery or transfer reversals. `stripe-test.js:153` normalizes a captured PaymentIntent without refund totals. The existing test deliberately asserts that a refund event does not finalize a refund (`test/provider-events.test.js:20-40`). | Retain the safeguard against fabricating refunds from an unverified event, but add authoritative refund/dispute retrieval, unique provider-object records, explicit accounting and exception workflows. Test Stripe Dashboard-originated partial/full refunds, disputes, failed refunds and late/replayed events against local initiated refunds. This is a confirmed coverage gap, not evidence that money has been lost. |
| PP-04 | P1 before live / confirmed source gap | Held transfers have no normal recovery action in the reviewed API. Ineligible/mismatched transfers are marked `held`, with the worker job `completed` (`stripe-connect.js:264-268`). Future eligibility scanning excludes any existing merchant transfer (`stripe-settlement.js:24`). Admin exceptions are readable (`marketplace.js:105`), but there is no corresponding reviewed release/requeue endpoint. A transient account restriction or changed refund snapshot can leave restaurant funds awaiting engineering intervention. | Provide an authorized, audited reconciliation/review command that first retrieves provider truth, recomputes eligibility and explicitly versions any changed operation. Preserve the old history. Add alerts and an accountable finance owner. Do not repair by deleting operation keys or blindly submitting a fresh transfer. |
| PP-05 | P2 before tablet install / confirmed | The Windows installer generates `start --config config.json` without `--allow-physical-transport` (`print-bridge/windows/install.ps1:37`). Physical transport requires that flag (`print-bridge/src/transports.js:118`). A TCP configuration installed through this script fails at startup. This conservative default is safe, but the supplied installer is not a complete physical rollout path. | Add a separately reviewed, explicit physical-mode deployment option after hardware acceptance. Validate exact scheduled-task command and account permissions on a spare Surface, with the original Calai bridge untouched. |
| PP-06 | P2 / confirmed | Manual reprint creation has no request idempotency key (`marketplace.js:379-389`). Every retry creates a distinct job and operation key, so a lost HTTP response/double click can create extra copies. Original acceptance jobs already have unique order/printer keys (`marketplace.js:50`). | Add actor/tenant/printer/order/request-key deduplication for one intentional reprint action; allow a new key for a genuinely new copy. Keep the visible manual-reprint label and audit reason. |
| PP-07 | P2 / confirmed implementation, failure risk unmeasured | Journal/credential files use temporary writes and rename but no explicit flush-to-disk (`print-bridge/src/journal.js:38-46`, `credential-store.js:41-46`). A process-local lock protects only the same journal path (`index.js:23-48`). Power loss, filesystem durability and multiple installations are not covered by the simulator tests. Unresolved entries are retained without a limit; the installer redirects console output to an unrotated file (`windows/install.ps1:37`), although the main JSON logger rotates at 5 MiB. | Test power interruption and disk-full recovery on the approved filesystem/device. Review durable write protocol, restricted ACLs, unresolved-job retention, capacity alarms and console log rotation. Do not delete a journal/lock as a generic recovery step. |
| PP-08 | P2 / confirmed | Every successful raw TCP write is reported `uncertain` (`transports.js:109`): the transport cannot confirm paper, cutter or readability. Unsupported receipt characters become `?` (`receipt.js:100-108`). These honest semantics avoid a false printed claim but require an operational workflow and hardware-specific acceptance. | Preserve `uncertain` until evidence supports a stronger state. Test required scripts/characters, allergens, long modifiers, paper-out, cutter fault and offline restart. Consider a supported printer status protocol only after model validation. |

### PP-01 isolated reproduction

1. Create a fresh temporary database through the existing test fixture, using only fictional seed accounts and simulator payment mode.
2. Create one virtual printer and pair devices A and B to it with separate single-use codes.
3. Place and accept one fictional order, creating one original server job.
4. Run A until its claim is journaled, then simulate a pause before dispatch.
5. Advance the fixture clock by 31 seconds, beyond the server's 30-second lease.
6. Run B: it reclaims and dispatches the job to the counting transport, then acknowledges `uncertain`.
7. Resume A from its old journal: it dispatches the same job again, then successfully acknowledges the same outcome.

Observed output on 30 October: `sameJobDispatchedTwice=true`, `dispatchCount=2`, `finalJobStatus=uncertain`. No HTTP network server, payment provider or physical transport was involved. The server and bridge code paths were real; the journal was an in-memory equivalent to isolate the ownership defect. This demonstrates a duplicate dispatch decision, not physical paper duplication on a device.

## Payment and order flow to preserve

```mermaid
sequenceDiagram
  participant C as Customer app
  participant A as Cal-Eats API
  participant D as Cal-Eats database
  participant S as Stripe
  participant R as Restaurant dashboard
  participant W as Workers
  C->>A: Create order with idempotency key
  A->>D: Reprice; snapshot items/terms; reserve offer; pending card order
  C->>A: Create/recover checkout for saved order
  A->>S: Hosted Checkout, manual capture, fixed server key
  S-->>C: Authorization and return URL
  S->>A: Signed platform/Connect webhook
  A->>D: Durable deduplicated event intake
  W->>S: Retrieve authoritative payment facts
  W->>D: Authorized payment; restaurant notification
  R->>A: Accept with ETA
  A->>D: Claim durable acceptance decision
  A->>S: Capture using fixed order key; retrieve result
  A->>D: Accepted order, commission/journal, one original printer job
  R->>A: Preparation / ready / delivery / completion
  A->>D: Completion / settlement eligibility
  W->>S: Source-charge-bound restaurant transfer
  S->>S: Weekly connected-account bank payout schedule
  S->>A: Payout event; retrieve and record result
```

Source map:

| Responsibility | Existing implementation | Handover detail |
| --- | --- | --- |
| Basket/order creation | `journey.js:298-402` | Server prices menu/options, checks availability/offer eligibility, snapshots commercial terms and stores `UNIQUE(customer_id,idempotency_key)` plus request hash. Client totals are not trusted. |
| Checkout | `payments/stripe-connect.js:111-140` | Saved order ownership is required. Provider key is fixed as `checkout:<mode>:<orderId>`, independent of a changing browser retry key. Preserve the exact Stripe Checkout origin check and return fragments. |
| Authoritative binding | `stripe-connect.js:29-34` | Amount, GBP currency, order ID, restaurant ID, manual capture and saved PaymentIntent must match. Return-URL query parameters are not proof of payment. |
| Accept/reject | `payments/stripe-transitions.js:11-67`; `journey.js:410-456` | Two-minute decision claim prevents opposing capture/cancel actions. Provider I/O happens outside the database transaction. Final facts and order state are applied transactionally. Unknown results remain for reconciliation. |
| Commission | `marketplace.js:37-58` | Existing 7% policy and food/food-plus-delivery basis depend on the saved agreement. Use immutable snapshots and integer pence; do not impose a new commercial basis during refactoring. Provider cost is separate from platform commission. |
| Settlement eligibility | `payments/stripe-settlement.js:6-54` | Completed captured card orders only; ready account, no unresolved blocking refund case, net refund/commission snapshot, unique operation key. Cash is excluded. |
| Refund and reversal | `marketplace.js:252,289`; `stripe-connect.js:220-271` | Case approval queues refund execution; a verified provider result finalizes it. Merchant transfer reversal is a distinct bounded operation after refund. Financial operations/journal postings must not be summed as separate sales. |
| Expiry | `stripe-connect.js:335-377` | Cancels/expires unresolved card flows authoritatively before release. Captured money discovered during expiry is preserved, not cancelled/refunded blindly. A stuck captured/placed order needs explicit operational review. |
| Provider event intake | `payments/provider-events.js:14-47,120-137` | Raw body signature verification, timestamp tolerance, exact mode, durable deduplication by provider/event. Processing retrieves current provider truth and checks tenant/account mappings. |
| Provider adapter | `payments/stripe-test.js` | Built-in fetch adapter; no Stripe SDK dependency. Pinned API `2025-06-30.basil`, bounded timeout, idempotency keys on mutations, redirects rejected, mode checks. The repeated `Stripe-Account` assignment at lines 30-31 is harmless duplication to remove only during a reviewed edit. |

Stripe explicitly permits duplicate/reordered webhook delivery and recommends signed raw-body verification with prompt acknowledgement; use the existing durable intake as the foundation, then improve processing throughput and observability. [Stripe webhook guidance](https://docs.stripe.com/webhooks).

Provider idempotency is not permanent deduplication: Stripe documents API v1 key pruning after at least 24 hours. Keep the durable local operation record and retrieve provider truth before replaying an old ambiguous mutation. Do not replace a failed operation's key as a generic retry strategy. [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests).

## Weekly restaurant payouts and statements are different

1. **Merchant earnings** are calculated from the original accepted order, discounts, commission basis and verified refunds.
2. **A transfer to the restaurant's connected Stripe balance** occurs through the settlement worker only after completion/eligibility. This is not a bank payout.
3. **A bank payout** is scheduled by Stripe. Owner onboarding calls `configureWeeklyPayouts` for Monday (`stripe-connect.js:146-154`; `stripe-test.js:78-82`). Cal-Eats has no competing live bank-payout scheduler. The returned schedule DTO is a constant, not a fresh provider schedule read, so operational verification must check Stripe configuration rather than treating that UI label as proof.
4. **The weekly statement** is a reporting/email snapshot. It defaults to Monday 09:00 Europe/London for the previous Monday-Sunday (`business-weekly-statements.js:16-38,100`). It does not move money. Cash, transfers, payouts and recorded sales are separate metrics.

The pinned Balance Settings API has version-specific request fields. Do not replace the current `payouts[schedule][weekly_anchor]` request with fields from the newest API documentation during unrelated refactoring. The repository trial reports that the pinned request was verified against Stripe. Revalidate the request and read-back when an approved provider API upgrade is planned. [Pinned Balance Settings API](https://docs.stripe.com/api/balance-settings/update?api-version=2025-06-30.basil).

Monday is the configured payout day, not a guarantee of bank arrival or available funds. Availability, verification, reserves and bank processing remain provider-dependent. [Stripe payout scheduling](https://docs.stripe.com/connect/manage-payout-schedule).

Statement data: `business_statement_preferences` records owner/user subscription and next due time; `business_weekly_statement_outbox` stores recipient, immutable summary/CSV, mode, status, dispatch marker and lease. Creation is deduplicated; the owner can download only their own restaurant/user statement. A send that may have occurred becomes `unknown` rather than being blindly resent (`business-weekly-statements.js:144-175`). CSV formula-like values are escaped. Statements cap activity rows at 50,000 and generated CSV at 10 MiB, with email attachment only at or below 1 MiB. These limits should produce actionable failures, not silent missing financial reports.

For 10,000 recipients becoming due together, 25 per minute implies approximately 400 cycles, or 6 hours 40 minutes nominal drain time before upstream/snapshot cost. This is arithmetic from scheduling parameters, not a benchmark. Multiple owners increase recipient count. The synchronous generation includes period queries and a legacy per-order lookup (`business-weekly-statements.js:43-94`), so realistic history sizes and worst-case Monday load must be measured.

## Payment/finance API and authorization map

Global browser Origin/session protections still apply in addition to the route checks below. Native bearer session and device bearer credentials are separate mechanisms.

| Method / route | Access and purpose |
| --- | --- |
| `GET /api/payments/config` | Public configuration summary; no secrets. Advertised configuration is not proof of account readiness. |
| `POST /api/orders/:id/checkout` | Owning customer; empty JSON body and bounded `Idempotency-Key`; server-owned provider key. |
| `POST /api/orders/:id/payment/refresh` | Owning customer; authoritative provider refresh. |
| `PATCH /api/restaurant/orders/:id/status` | Restaurant membership, state-transition checks; owner/staff finance visibility differs. |
| `GET /api/restaurant/restaurants/:id/finance/stripe` | Restaurant owner; configured account/readiness summary. |
| `POST .../finance/stripe/onboarding`, `/refresh`, `/dashboard` | Restaurant owner; onboarding/dashboard mutations require idempotency headers where checked; returns provider URL/status. |
| `GET .../finance/stripe/banking` | Restaurant owner; masked bank information only. Editing occurs on Stripe. |
| `GET .../finance/stripe/payouts?pageSize=&startingAfter=` | Restaurant owner; provider-backed pagination, persisted cursor must belong to that restaurant/account. |
| `GET /api/admin/finance/stripe/readiness`, `/payouts` | Platform administrator; readiness/payout visibility. |
| `POST /api/provider-events/stripe-test` and `/connect` | Signature-authenticated endpoints, distinct platform/Connect signing secrets, enabled mode only. Live equivalents use `stripe-live`. |
| `GET /api/restaurant/restaurants/:id/weekly-statements` | Restaurant owner; paged historical statements for current owner. |
| `GET/PATCH .../weekly-statements/settings` | Restaurant owner; view/toggle delivery preference. |
| `GET .../weekly-statements/:statementId.csv` | Matching restaurant and owner/user only. |

For refund-case decision endpoints and existing commercial rules, retain [marketplace API](../MARKETPLACE_API.md), [dispute API](../DISPUTE_RESOLUTION_API.md) and [finance details](../BUSINESS_FINANCE_DETAILS.md). Native, web and portal clients must continue using the same backend calculations.

## Printer handover

### Current components and protocol

`apps/print-bridge` is an independent Node client using built-in networking/filesystem modules. There is no USB/default-Windows-printer implementation. `file-sink` is a deterministic simulator; `tcp-escpos` writes raw network ESC/POS and is separately gated. Original Calai hosts are explicitly rejected; the simulator accepts only loopback (`config.js:48-62`). This is intentional product isolation and must be considered when choosing the future Cal-Eats/staging hostname.

| Endpoint | Authentication / state |
| --- | --- |
| `POST /api/restaurant/restaurants/:restaurantId/printers` | Owner creates printer; settings update is owner/tenant scoped. |
| `POST .../printers/:printerId/pairing-code` | Owner; short-lived single-use pairing code. |
| `POST /api/devices/pair` | Valid single-use code; server stores token hash and returns opaque credential once. |
| `POST /api/devices/heartbeat` | Device bearer token; device must be active and printer enabled/not revoked. |
| `POST /api/devices/jobs/claim` | Device bearer; printer-scoped job; 30-second claim with token and attempt. |
| `POST /api/devices/jobs/:id/ack` | Device bearer and issued claim token; outcome `printed`, `failed` or `uncertain`. See PP-01 ownership defect. |
| `POST .../printers/:printerId/reprints` | Owner; confirmed-or-later order and enabled printer required; creates explicitly labelled manual copy. See PP-06. |

Data relationships: restaurant -> `restaurant_printers` -> pairing codes and `printer_devices`; accepted order + printer -> `device_print_jobs`; issued claims -> `printer_job_claim_tokens`. Original job uniqueness is the order/printer/`original` operation key. The legacy browser `print_jobs` table records browser receipt attempts and is distinct from device jobs; opening a receipt does not prove physical printing. Preserve this distinction in reporting and during Calai integration.

Local journal states are `claimed`, `dispatching`, `ack_pending`, `acked`, `ack_rejected`. Receipt and claim token remain locally for recovery until a successful acknowledgement clears them; completed history is pruned to 250 entries. Physical `dispatching` recovery becomes `uncertain` rather than resending. Network retry uses bounded backoff/jitter; request timeouts and redirected-request rejection prevent uncontrolled waits/credential redirection. File logger redacts token/receipt/address/phone/name keys and rotates. These existing components should be reused after correcting ownership semantics.

The sample bridge polls every 3 seconds and heartbeats every 30 seconds (`config.example.json`). Therefore 10,000 continuously connected idle bridges imply approximately 3,333 claim requests/second plus 333 heartbeat requests/second, before receipts/acknowledgements and dashboard traffic. This is a workload estimate, not measured capacity. Long-polling or event notification with durable pull fallback, jittered reconnect and bounded fleet configuration should be assessed on staging.

### Windows / Surface configuration checklist

- Inventory the actual printer model, transport, firmware, supported code page, IP/port and Surface network policy through an authorized device administrator. Keep identifiers in protected device configuration, not Git.
- Record the working original Calai service/task, installation path, kiosk constraints and Intune assignment. The new `CalEatsPrintBridge` task and `C:\ProgramData\CalEats\PrintBridge` path are separate; do not overwrite original Calai files.
- Use the repository-pinned/approved Node runtime from a trusted source. Installer accepts an existing explicit Node path and never downloads a runtime.
- Validate configuration with the CLI before pairing; give the installed task account access only to the required config/journal/log/credential paths. Absolute paths outside the installation directory require explicit ACL review.
- Pair using the one-time code in a transient environment variable; clear it after pairing. Never log the opaque device token. Windows file modes alone are not an ACL guarantee; inspect installed access permissions.
- Validate the scheduled task's executable, flags, working directory, startup condition, network availability, battery/sleep behavior and restart policy on a spare Surface. The supplied installer installs but does not start the task, and physical mode is incomplete as described in PP-05.
- Keep one active output owner for each physical printer in the integrated design. Logical original job deduplication does not stop two unrelated backends from each printing the same business order.
- Capture operator-approved paper samples for modifiers, delivery address, allergy notes, GBP, language characters, 80mm layout/cut and manual-reprint marker. Confirm no sensitive receipt remains in publicly readable folders.

### Troubleshooting / controlled rollback

| Symptom | First read-only checks | Controlled recovery |
| --- | --- | --- |
| Printer offline | Last authenticated heartbeat, task status, reviewed local log, API reachability, enabled/revoked state. Heartbeat means API contact, not paper readiness. | Restore network/task configuration. Keep queued jobs and journal. Do not create copies merely because the UI says offline. |
| `claimed` beyond lease | Device identity, current owner/attempt and both bridge journals. | Treat possible output as uncertain; apply PP-01 fix before automatic failover. Operator decides whether a labelled reprint is required. |
| `ack_pending` | API connectivity and matching token/outcome history. | Replay the same acknowledgement; do not redispatch receipt. |
| `ack_rejected` | Revoked device, conflicting terminal outcome or token/job ownership. | Investigate with job IDs, not receipt/token dumps. Retain journal for reconciliation. |
| `uncertain` | Physical paper and printer status, whether transport sent bytes. | Operator records result and requests one labelled manual copy only if needed. |
| Corrupt journal/disk full | Preserve protected journal/temp/lock files and inspect disk capacity. | Do not wipe to restart; reconcile server/device state, then restore a verified protected copy under change control. |
| Payment/refund unknown | Provider mode/account, operation ID/key, authoritative provider object and worker exception. | Retrieve and reconcile exact object; never infer success from UI or retry with a fresh key. |
| Funds not transferred | Completed order, captured payment, ready account, active cases, held operation, queue age. | Finance owner reviews eligibility and provider truth; use approved recovery tooling, not direct deletions. |
| Weekly statement missing | Next due time, preference, queued status/last error, local-vs-send mode and worker lag. | Preserve immutable snapshot; reconcile ambiguous send before any resend. |

Rollback must stop a new printer consumer before restoring a previous consumer and reconcile all in-flight jobs so both do not output. Retain the journal and credentials securely; uninstall is not the default rollback. Payment rollback is generally a forward reconciliation of provider facts with the previous compatible application version, not restoring an old database over money that already moved. Preserve signed event intake during an application rollback, verify schema compatibility, and replay safely only after mapping/amount checks. No rollback or installation was performed in this audit.

## Access, monitoring and acceptance gates

Ask the Cal-Eats service owner for named, least-privileged access to the correct GitHub repository and staging deployment, the isolated Stripe sandbox/Workbench and separate platform/Connect event configuration, and the approved device/Intune test group. Use a managed secret store for key material; record names, scopes, owner and rotation procedure only. Production/live/physical access is a separate change-control step under the user's instruction. Do not reuse original Calai tokens or copy production databases/customer receipts into a testing repository.

Stripe configuration names: `CALAI_PAYMENT_PROVIDER`, `CALAI_LIVE_PAYMENTS_ENABLED`, `CALAI_STRIPE_ACCOUNT_ID`, mode-specific secret key and platform/Connect webhook-secret variables. Statement sending depends on the separate service-mail adapter and explicit send enablement. The adapter exposes a Bacs boundary, but the actual mandate/notice/collection product flow is not activated according to the payment handover. Do not claim automatic cash commission collection from its presence alone.

Minimum operational metrics: oldest pending/claimed payment and print job; queue depth/arrival/drain rate by kind; decision/worker lease expiry; failed/held/unmatched provider events; provider timeout/429 counts; reconciliation delta between charges/refunds/transfers/payouts and local journal; connected-account readiness changes; print `uncertain`/`ack_rejected` counts; per-device last seen; statement due/sent/unknown/failed; disk usage and journal/log age. Use tenant/order/operation/job correlation IDs without card data, credentials, receipt text or message bodies. Current console logs and database status screens do not establish centralized alerts or an on-call response.

Required regression and acceptance scenarios before approved implementation is released:

- Existing card/cash/mock order, commission, discount, offer, ETA, refund and print-trigger tests remain passing; do not alter business rules to simplify the integration.
- Real sandbox: onboarding restrictions, card authentication/decline, interrupted checkout, duplicate create requests, authorization expiry, competing accept/reject, lost capture response, partial/full refund, insufficient transfer funds, transfer reversal and bank-payout failure. Use fictional tenants and provider test data only.
- Replay: duplicate/out-of-order signed events, event before local mapping, wrong tenant/account/currency/amount, signature expiry, secret rotation, long outage beyond normal retry horizon, external refund/dispute and operator reconciliation.
- Worker load: target arrival rates, provider throttling/latency, backlog drain, fairness under hot tenants, restart at each external-I/O boundary, and no ledger duplication after recovery.
- Printer fleet: at least two paired clients per logical printer in failure tests; expired claim before dispatch; sleep/reboot; paper/network failure before and after bytes; lost acknowledgements; duplicate manual-reprint submission; token revocation; disk-full/corrupt journal; Surface startup under intended identity.
- Integration: one authoritative order/financial source, one physical print owner, durable source-prefixed IDs and explicit print routing. Test online/phone crossover and retries so both backends cannot independently print or count the same order.

Existing relevant suites include `stripe-flows`, `stripe-config`, `stripe-checkout-api`, `stripe-transitions`, `stripe-settlement`, `provider-events`, `dispute-stripe-refund`, `marketplace`, `confirmation-printing`, `business-weekly-statements`, and `apps/print-bridge/test`. Fake-provider and file-sink passing results establish local invariants only; physical paper and bank settlement require separate acceptance evidence.
