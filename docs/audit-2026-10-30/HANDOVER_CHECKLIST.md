# Independent developer handover checklist

Use this with [the audit report](REPORT.md). Checkboxes are acceptance work for the incoming team; unchecked items are not claims of completed setup. Assign a named owner, date, evidence link and reviewer to every release gate. The audit supplied source documentation and isolated measurements, not production access or operational sign-off.

## Access and environment ownership

- [ ] Confirm the owner of `MohammedCalai/cal-eats`, the current deployed commit, branch protections, review rules and deployment triggers. The configured local remote alone proves none of these settings.
- [ ] Create the separately approved **private testing repository** from the agreed Cal-Eats baseline; record provenance, licensing and exclusions. Keep original Calai source read-only and independently maintained; do not merge repositories.
- [ ] Record production, staging and local inventories: host/service owner, URL, application commit/image digest, runtime, schema version, DB/volume location, region, provider mode and backup destination. No secret values in this inventory.
- [ ] Obtain GitHub and hosting membership by named invitation from the organisation owner, with MFA and least privilege. Use review/deploy rights appropriate to role, not a shared personal password.
- [ ] Obtain a separate Stripe sandbox role and restricted test credentials/webhook signing secrets from the finance/platform owner. Verify account/mode and separate platform/Connect destinations. Finance approves any later live capability; no real funds are used in staging.
- [ ] Obtain Microsoft Graph/send-only mailbox or SMTP access from the mailbox/identity administrator. Review required application/delegated permissions, sender restriction, consent and token-vault ownership. Keep test mail local until an explicit test recipient is authorised.
- [ ] Obtain Expo/EAS, Apple and Google developer roles through the release owner for signing/device tests. Signing certificates and recovery credentials belong in approved secret storage, never Git.
- [ ] Obtain Calai staging API/specification and tenant-scoped test identities through its authorised maintainer. Telephony/call-provider sandbox access is separate; inspect actual dependencies rather than guessing credentials from the reference snapshot.
- [ ] Obtain domain/DNS/TLS permissions through the domain owner only for the agreed staging hostname. Do not alter the main Calai website or live routing.
- [ ] Record Surface/Windows/printer support ownership, inventory and an isolated test device. Obtain named technician access and an approved maintenance window before installation or ownership changes.
- [ ] Document secret names, purpose, environment, rotation owner and retrieval procedure; verify access revocation. Do not paste secrets, production DBs, mail caches, recordings or device credentials into tickets or this repository.

## Safe local onboarding

1. Read [REPORT](REPORT.md), [architecture/database](BACKEND_DATABASE.md), [API](API_REFERENCE.md), [payments/printing](PAYMENTS_PRINTING.md) and the existing feature contracts. Record accepted business rules before editing.
2. Use a fresh checkout or explicitly isolated test workspace with the pinned Node 24.19.0/npm 11.17.0 toolchain. Inspect scripts and lockfile; install with `npm ci --ignore-scripts`, then build the portal. Do not run original reference source/tests.
3. Configure loopback local mode, a **new synthetic DB path**, mock payment mode, local mail transport and file-sink printing. See `.env.example` and `apps/api/src/config.js`; `.env.example` can lag new options, so use the audited environment map. Never copy private production environment files.
4. Only in that new isolated local database, explicitly run migration/seed commands. Normal application startup also migrates its configured DB; verify the resolved path before any start. The audit did not run these commands against the existing application data.
5. Run release packaging, portal build, root tests, both native tests and both native type checks. The known stale expiry fixture must be corrected in a reviewed test change before the gate is green. Never use unrestricted recursive `node --test` discovery from this workspace.
6. Walk customer discovery/menu/basket/checkout, owner order confirmation/ETA/status, staff permissions, refunds, finance, offers/loyalty, messages/support, reports, accessibility and notification reconnect with fictional accounts. Compare browser/phone/tablet visuals to the agreed baseline.

## Business behaviour baseline

- [ ] Inventory every customer, owner, staff and platform-admin feature, including existing browser/native differences. Link each feature to a contract, screen and test; screenshots alone do not establish behaviour.
- [ ] Preserve integer GBP pence, food-only commission rules and accepted contract versions; delivery fees, discounts, free items and provider fees remain distinct.
- [ ] Preserve opening/holiday/pause/service-area rules, modifiers/allergen notes, price-review prompts, immutable snapshots, ETA requirements and collection/delivery transitions.
- [ ] Preserve cash collection timing, refund authority, idempotency, loyalty/offer reservation and release, customer-history visibility and temporary-message retention.
- [ ] Capture tenant/role negatives for every new or touched route, DTO, export, event, notification, attachment, print job and Calai mapping. Include revoked users, switched tenants and owner/staff differences.

## Database and recovery gate

- [ ] Review all 31 source migrations and the [85-table schema](SCHEMA_REFERENCE.md); confirm actual deployed schema independently. Never infer production integrity from an empty in-memory migration test.
- [ ] Capture representative query plans and timings before/after proposed indexes or batching. Verify read improvements, write cost and retention/archival requirements on realistic history.
- [ ] Rehearse each supported upgrade path and table rebuild on synthetic or expressly authorised redacted copies. Check counts, foreign keys, financial totals, idempotency keys, encrypted data and public DTO compatibility.
- [ ] Approve any production migration separately; define migration ownership, maintenance/write-stop requirements, backward/forward compatibility and cutover criteria.
- [ ] Resolve backup sanitation for temporary customer conversations and missing container operational scripts; pass the actual DB source path explicitly.
- [ ] Encrypt/restrict off-host backups, escrow required keys independently and define retention. Validate integrity, restore application usability, RPO/RTO and provider/print reconciliation in isolation.
- [ ] Do not roll back by restoring old data after payments or paper have happened. Reconcile external side effects and use compatibility-aware rollback/forward repair under an incident lead.
- [ ] Test key rotation with historical key access before rotating; a new single message key alone cannot decrypt old records.

## Payment and printing gate

- [ ] Confirm actual Stripe mode, account, API version, Connect onboarding status and webhook destinations with authorised access; store evidence without secrets.
- [ ] Test authorization/capture/decline/cancel, customer abandonment, duplicate/out-of-order events, provider timeout, partial/full refund, external Dashboard refund, chargeback, held transfer and retry after ambiguous response.
- [ ] Reconcile gross, commission, provider fee, refund, merchant transfer and bank payout as separate facts. A weekly statement or configured Monday schedule is not evidence of money reaching a bank.
- [ ] Verify actual bank payout behaviour only in the later approved provider pilot. Define finance ownership, exception alerts and audited recovery actions before live reliance.
- [ ] Fix and regress printer claim fencing/restart duplication and manual-reprint deduplication; preserve clear uncertain states.
- [ ] Record Surface/printer transport, model/driver/runtime/startup identity, journal/credential paths, ACLs, sleep/power settings and safe update/rollback method.
- [ ] Validate the actual installed startup command includes any deliberately approved physical flag. Start with a file sink, then spare hardware; never use a restaurant's active printer as a load generator.
- [ ] Run paper-out/network/power/reboot/lease/lost-ack tests and receipt fidelity checks. Document who reviews an uncertain job and how an intentional labelled reprint is authorised.

## Calai integration gate

- [ ] Approve [CALAI_INTEGRATION.md](CALAI_INTEGRATION.md), scoped identity design and explicit business mapping; validate the current Calai deployed API rather than assuming the old snapshot is current.
- [ ] Preserve Cal-Eats navigation/screens; add Calai entries beneath them and a separate accessible login modal. Restrict feature display and server data to authorised activated restaurants.
- [ ] Reject arbitrary tenant IDs, unauthorized stream rooms and stale/revoked grants; resolve the reference Socket.IO weakness before reuse.
- [ ] Use unique source/order/event keys, transactional outbox/inbox and version-aware projections; do not recreate a phone order through normal online checkout.
- [ ] Agree the metrics dictionary and revenue evidence; test combined counts, refunds, time windows and live calls against both source systems. Retain source drill-down and data-freshness indicators.
- [ ] Prove a Calai outage cannot disrupt Cal-Eats ordering. Test disable/unlink/relink/rollback and rebuild of projections without repeating payments, orders or prints.
- [ ] Keep printing unchanged in the initial read-only phase; any combined delivery requires one authority per physical job and a separately approved ownership handover.

## Release, monitoring and maintenance

- [ ] Establish CI with bounded test discovery, root/native tests, type checks, portal build, release packaging and advisory triage. Include a reviewed Docker build/restore exercise and required browser/device regression jobs.
- [ ] Review all high-priority defects and document remaining exceptions with named risk owner/expiry. Do not equate a build passing with acceptance of unresolved financial or printer risks.
- [ ] Run the staged [10k-business plan](SCALABILITY.md) with independent generators, historical data, realistic dashboards/printer load, provider limits, skew and fault injection; keep offered/served load and invariant results.
- [ ] Agree service objectives and alert thresholds. Monitor request errors/latency, event-loop lag, DB locks/WAL/disk, stream replay lag, worker heartbeat/backlog, payment discrepancies and printer uncertain/offline state.
- [ ] Establish redacted structured logs and correlation IDs with access controls and retention; verify alerts reach a staffed operational channel. Alert routing itself requires authorised configuration.
- [ ] Rehearse incident response: assign commander, preserve evidence, stop unsafe new side effects, keep orders visible, assess provider truth, recover and reconcile, then record actions and regression work.
- [ ] Release staging first; record immutable image/source/schema versions. Approve production deployment separately and use small restaurant cohorts with explicit stop/rollback criteria.
- [ ] Daily operational review: payment/print/email exceptions, backup results, oldest queue age and resource headroom. Weekly: reconcile settlement/statements, access/activation changes and dependency advisories. Per release: regression matrix and migration compatibility. Regularly: restore and device failure drills, credential/access review and retention verification. Agree exact cadence with the accountable owners.
- [ ] Independent developer demonstrates setup, one complete fictional order, tenant denial, refund reconciliation, print recovery and restoration using only the handover and authorised access. Independent operations/finance owners sign off the relevant evidence.

## Acceptance record

| Area | Accountable role | Evidence required before acceptance | Current audit status |
| --- | --- | --- | --- |
| Product/interface/business rules | Product owner + QA | Feature inventory, visual/behaviour regressions | Source/tests reviewed; device journey pending |
| Security/tenant access | Security/technical lead | Role/tenant matrix, privileged access, scoped Calai stream | Existing controls documented; gaps listed |
| Finance | Finance + backend owner | Provider reconciliation, held-case recovery, payout evidence | Historical sandbox payments only; bank settlement pending |
| Printing | Device/operations owner | Hardware/crash recovery and one delivery owner | Duplicate dispatch reproduced; physical acceptance pending |
| Scale | Platform lead | Target workload, limits, cost/headroom and raw results | Diagnostic and short baseline complete; target test pending |
| Recovery | Operations lead | Off-host restore, keys, measured RPO/RTO | Repository gaps confirmed; drill pending |
| Independent maintenance | Incoming team lead | Onboarding demo, runbooks, CI and access ownership | Documentation supplied; team acceptance pending |
