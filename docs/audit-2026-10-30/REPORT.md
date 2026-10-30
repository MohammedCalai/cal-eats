# Cal-Eats architecture, scalability and developer handover audit

**Audit date:** 30 October 2026. **Source:** `b94092ee4657b01d93466a4ddf282155f76a0fa2`, configured remote `MohammedCalai/cal-eats`. **Outcome:** preserve the existing product and reusable components, but do not approve a 10,000-business rollout or operational dependence on the proposed integration until the identified gates are satisfied.

This is a source and isolated-validation audit, with documentation deliverables. It is not a production certification. No production configuration, application source, existing database, original Calai repository or physical printer was modified. No repositories were merged, dependencies upgraded, migrations applied to existing data, commits pushed or deployments made. Only repository documentation and reproducible audit evidence were added, plus local ignored validation artifacts.

## Overall assessment

Cal-Eats has a substantial working foundation, including shared customer/business accounts, restaurant membership checks, server-authoritative checkout prices, immutable order snapshots, explicit state transitions, durable payment operations, notification/outbox records and a journalled printer bridge. Its existing tests exercise meaningful business flows and negative authorization cases. Retain these components and contracts.

Maintainability is **mixed**: workspace separation is useful, but dense route/screen modules combine too many responsibilities, older business UI remains shipped in the customer bundle, and documentation describes inconsistent stages of development. Reliability is **not yet demonstrated end to end**: a duplicate printer-dispatch path and a notification replay gap were reproduced; financial reconciliation and recovery have concrete missing cases. Security has useful safeguards, but deployment-sensitive authentication, privileged access, backup retention and an unsafe Calai reference stream need attention. No confirmed cross-tenant exploit was found in the reviewed Cal-Eats paths; that is not a comprehensive assurance of isolation.

Scalability is **not established for 10,000 businesses**. One actual discovery request at 10,000 synthetic businesses/200,000 items exceeded a 30-second budget even with in-memory storage and no order history. Current dashboards and printer defaults create large background request demand. Database query shape, worker scheduling and client polling need measured improvements before selecting infrastructure capacity. A wholesale rewrite is not justified by this audit.

The user's “approximately 90% complete” description cannot be converted into a verified readiness percentage from source alone. The current checkout has **seven workspaces, 31 migrations and 85 tables**; old documents cite fewer workspaces/schema 27 and test-only provider code. Live Stripe capability exists behind explicit gates, while a later historical trial reports sandbox payments only. Confirm deployed commits, modes and service ownership before further implementation.

## Priority findings and recommended fixes

Priority definitions: **P1** blocks the affected production/reliability/scale milestone; **P2** is important remediation in planned development; **P3** is cleanup after higher-risk work. “Confirmed” means source evidence or an explicitly described isolated reproduction. Conditional impacts and missing evidence are labelled; none is a claim of a known live incident. Detailed finding IDs and precise source locations are in the linked reviews.

| Priority | Finding / evidence | Required response and regression proof |
| --- | --- | --- |
| P1 | **Duplicate printer dispatch reproduced.** An expired claim is reassigned, then the old bridge resumes and dispatches the same job. `marketplace.js:377-378`; `print-bridge/src/bridge.js:82`; PP-01. | Fence current dispatch ownership, preserve uncertain outcomes and test two devices, restart, lease expiry, lost acknowledgements and intentional reprints before physical rollout. |
| P1 | **Discovery/query growth measured.** At 1k businesses ~1.17 s; at 10k the actual route did not finish in 30 s. Missing menu/order-child lookup indexes and unbounded/N+1 reads are confirmed by plans; BE-01/02. | Add reviewed indexes, bounded query contracts and batched reads; compare realistic-history plans/latency and preserve search, visibility and ordering semantics. |
| P1 | **Fleet demand and worker capacity mismatch.** Six dashboard reads/5 s; idle printer claim/3 s; minute workers with 25-item batches; FO-03, PP-02. | Coalesce reads, improve idle delivery, separate durable workers with measured throughput/fairness, then run the explicit 10k scenarios. |
| P1 | **Stripe external-change reconciliation and held-transfer recovery are incomplete.** Out-of-band refunds/disputes do not fully update the local financial ledger; held transfers lack a reviewed release/requeue workflow; PP-03/04. | Authoritative provider retrieval, unique financial records, audited finance-review actions, queue alerts and sandbox reconciliation tests. Do not fabricate success or bypass idempotency. |
| P1 | **Notification replay loses backlog.** 100 of 150 unseen events delivered after hub startup; BE-03. | Continue bounded replay or emit a gap/resync signal; test reconnect/restart and preserve tenant/session checks. Authoritative orders must remain independently refreshable. |
| P1 | **Backup policy/recovery mismatch.** Temporary customer conversations remain in backups; container omits advertised backup/restore scripts and uses a different DB path; FO-01/02. | Correct sanitation after policy review; package operational tooling, use the actual volume path and demonstrate off-host restore/key recovery. Review prior backups under the authorised retention policy. |
| P1 | **Startup changes schema; rollback compatibility is not enforced.** Table rebuild migrations and no maximum-schema/checksum gate; BE-07. | Controlled migration step, rehearsal on isolated copies, immutable versions/checksums and compatibility-aware rollback. Approval required before existing-data migration. |
| P1 | **Public account recovery is incomplete.** Password-reset links go only to the local mail sink, independently of hosted mode; BE-08. | Deliver through an authorised recovery sender and verify one-use/expiry/session revocation and generic responses in staging. |
| P1 | **Operational security/telemetry gaps.** Proxy-shared login quota is conditional on ingress; no admin step-up/MFA path; request errors lack structured logs; BE-05/06/11. | Verify trusted ingress, bound password work, adopt privileged-access controls and redacted metrics/alerts. Test isolation across routes, streams, exports, devices and integration. |
| P1 triage | **Lockfile advisories:** 13 affected package entries, six high/seven low, no critical. Reachability varies between build/dev/browser paths; FO-13. | Review advisory prerequisites and compatible fixes in staging; do not apply the suggested forced Expo downgrade. See [validation](VALIDATION.md). |
| P1 integration gate | **Original Calai reference stream has no tenant authorization.** Caller-supplied business-room joins can receive customer order fields in the inspected snapshot. Current deployed status unknown. | Calai's authorised team must validate/fix scoped authentication in staging before integration reuse. Do not connect the existing dashboard to this stream as-is. |
| P1 operational gate | **Unattended native alerts not proven.** Existing mobile polling operates in foreground; physical background push and hardware printing remain unverified; FO-05. | Keep the approved Surface workflow supervised; require device acceptance before treating phone/background delivery as reliable. |
| P2 | **Concurrent message retry returns 500**, though uniqueness keeps one row; BE-04. Native polling can discard slow results; FO-06. | Transactional idempotency replay checks; reuse an existing in-flight guard; regress concurrent retries, timeouts and tenant switching. |
| P2 | **Installer/manual-print limitations.** Physical-enable flag absent; manual reprints lack deduplication; journal power-loss guarantees unmeasured; PP-05..08. | Explicit reviewed physical configuration, reprint request keys, durable journal/hardware fault tests and operator recovery. |
| P2 | **Test/CI and documentation drift.** Root suite omits both native suites; no tracked CI workflow; one existing test has a stale 2020 fixture; FO-04/12, BE-12. | Complete release gates, fix fixture without weakening the 90-day rule, record current environment inventory and keep historical evidence dated. |
| P2/P3 | **Maintainability/dead-code debt.** Dense route/screens, duplicated parsers/auth validation, shadowed legacy handlers, unused old web workspaces, one redundant session index; BE-10, FO-10/11. | Small tested extractions after behavioural baselines; remove only proven unused paths/dependencies. No dependency was declared unnecessary merely because a filename looked old. |

No P0 “active compromise” is asserted. The source-reference Socket.IO issue is a serious integration blocker; it is explicitly distinguished from the reviewed Cal-Eats implementation and from unverified live deployment exposure.

## Validation summary

- Portal build, both native type checks, release packaging and all **18 native unit tests passed**.
- Root suite: **231/232 passed**. The repeatable failure is an expiry test whose 2020 terminal order is correctly hidden by the newer 90-day customer-history rule. This requires a test correction, not removal of that rule.
- Current short synthetic HTTP test: **120/120 workflows**, 1,521 requests, zero HTTP errors; no duplicate orders/operation keys, unbalanced posting groups or FK violations. This covers 100 restaurants, 20 concurrent workflows, no historical orders, simulated money and printers—not the requested fleet scale.
- Independently reproduced printer duplicate dispatch, notification backlog loss, concurrent message retry failure and backup-retention mismatch. Empty-schema integrity checks passed; production/upgrade integrity was not inspected.

Full commands, results, limitations, raw benchmark/advisory evidence and the historical Stripe sandbox distinction are in [VALIDATION.md](VALIDATION.md). [SCALABILITY.md](SCALABILITY.md) defines realistic 10k-business scenarios, proposed acceptance targets, metrics and staged measurement. Targets are proposals requiring business agreement, not existing service commitments.

## Architecture and incremental structure

The current architecture is a modular monolith with separate delivery clients and a local printer agent. Preserve its public routes and shared contracts. Move toward clearly owned identity/tenant, catalog, order, finance, messaging and printing modules **one tested extraction at a time**; keep persistence/provider clients behind narrow interfaces and make worker ownership explicit. Existing pure policies in `packages/contracts` and proven resource/refresh components should be reused before introducing alternatives.

For multi-host scale, evaluate a shared transactional database and dedicated workers in the testing repository, but do not migrate production or share one SQLite WAL file over a network filesystem. Query/read-demand improvements are needed whichever database is selected. [SQLite WAL constraints](https://www.sqlite.org/wal.html). No hardware/replica sizing recommendation is represented as measured capacity.

The [Calai integration design](CALAI_INTEGRATION.md) includes the proposed folder structure and phased plan. It keeps both backends independent, appends Calai navigation beneath Cal-Eats, provides a separate login modal, enforces server-side activation and membership, aggregates source-qualified reporting without duplicate orders or payments, and requires a single accountable delivery path per physical print job. Read-only dashboard integration precedes any printer ownership change.

## Handover package

| Required coverage | Repository document |
| --- | --- |
| Architecture, data flow, backend ownership and tenant model | [BACKEND_DATABASE.md](BACKEND_DATABASE.md) |
| Customer web/native and business portal/native folder structure | [FRONTEND_OPERATIONS.md](FRONTEND_OPERATIONS.md) |
| Exact source-derived schema, relationships, migrations and indexes | [SCHEMA_REFERENCE.md](SCHEMA_REFERENCE.md), [BACKEND_EVIDENCE.json](BACKEND_EVIDENCE.json) |
| Endpoint families, methods, authentication and detailed contract links | [API_REFERENCE.md](API_REFERENCE.md) |
| Stripe authorization/capture/refunds, transfers, weekly payouts and statements | [PAYMENTS_PRINTING.md](PAYMENTS_PRINTING.md) |
| Bridge configuration, Surface/hardware verification and safe recovery | [PAYMENTS_PRINTING.md](PAYMENTS_PRINTING.md) |
| GitHub/hosting/configuration/access, deployment, monitoring and rollback | [FRONTEND_OPERATIONS.md](FRONTEND_OPERATIONS.md), [HANDOVER_CHECKLIST.md](HANDOVER_CHECKLIST.md) |
| Tests, vulnerabilities, measurement and evidence limits | [VALIDATION.md](VALIDATION.md), [SCALABILITY.md](SCALABILITY.md) |
| Calai integration, canonical IDs, permissions, reporting and staging plan | [CALAI_INTEGRATION.md](CALAI_INTEGRATION.md) |
| Onboarding, maintenance and independent-team acceptance | [HANDOVER_CHECKLIST.md](HANDOVER_CHECKLIST.md) |

Treat this dated package as the current source-audit entry point. Older feature documents remain useful for detailed behaviour and history; conflicting deployment/readiness claims require owner verification. The exact currently deployed build, authorised service access, bank settlement, physical printer behaviour, distributed load and disaster-recovery performance remain open evidence gaps.

## Recommended next decision

Review and approve the P1 remediation scope and staging integration design before structural implementation. First preserve existing behaviour with regression cases for the reproduced defects; then repair safety/recovery issues, measure the query/poll/worker improvements, implement read-only Calai integration and complete device/finance/scale gates. The separate testing repository and staging environment are specified in the plan; they were **not created or deployed as part of this audit**. Production changes, database migrations and any printer ownership change remain approval-controlled.
