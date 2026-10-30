# Validation record — 30 October 2026

Source baseline: `b94092ee4657b01d93466a4ddf282155f76a0fa2`; clean tracked working tree at audit start. Configured origin: `https://github.com/MohammedCalai/cal-eats.git`. This identifies the local checkout, not the deployed release. Runtime: Node 24.19.0, npm 11.17.0, Windows x64. This report records executed checks separately from static findings and historical documents.

## Checks executed for this audit

| Check | Result | Interpretation |
| --- | --- | --- |
| `npm run release:check` | Passed; 126 JavaScript files, 24 required files | Syntax and packaging/tracked-file checks; not a security certification |
| `npm run portal:build` | Passed; 75 transformed modules | JS 470.81 kB (136.85 kB gzip); CSS 79.76 kB (16.24 kB gzip); no browser/device UX test implied |
| `npm run mobile:check` | Passed | Customer native TypeScript |
| `npm run admin:mobile:check` | Passed | Business native TypeScript |
| `npm test --workspace=@cal-eats/mobile` | 12 passed, 0 failed | Native model/API boundary unit tests |
| `npm test --workspace=@cal-eats/admin-mobile` | 6 passed, 0 failed | Business native model/alert unit tests |
| `npm test` | **231 passed / 232; one failed**, no skips, 64.399 s | Existing Cal-Eats-only API/web/portal/bridge/script suite; excludes reference source |
| `node --test apps/api/test/finance-operations.test.js` | **4 passed / 5; same failure**, 9.725 s | Focused rerun establishes repeatability |
| `npm audit --json` | 13 affected dependency entries: **6 high, 7 low**, 0 critical, 0 moderate | Registry advisory evidence, not proof of reachable exploitation; no dependency changes |
| `npm run load:local` | **120/120 completed**, 1,521 HTTP requests, 0 HTTP errors; 8.635 s | Short isolated current-source synthetic benchmark; see below |
| Fresh in-memory schema and query plans | 31 migrations; 85 tables; 57 explicit indexes; 149 FK edges; integrity OK, no FK errors | Validates empty-schema construction, not upgrade of existing production data |
| Actual discovery route at 100/1k/10k businesses | 100 ~14-18 ms; 1k ~1.16-1.19 s; 10k did not finish within 30 s | Diagnostic evidence; see [scalability](SCALABILITY.md) |
| Printer lease/restart reproduction | Two dispatches of the same job with an isolated counting transport | No physical printing, provider call or real order |
| Notification reconnect reproduction | 100 of 150 unseen historical notifications delivered; 50 remained stranded | In-memory synthetic records, subscribe then poll |
| Concurrent order-message retry reproduction | HTTP 201 and 500, one stored row | Duplicate storage prevented, replay response broken |
| Backup privacy reproduction | Order messages removed; one temporary customer conversation remained | Synthetic temporary database; original data/backups untouched |

The root suite's failure is at `apps/api/test/finance-operations.test.js:70`. Its fixture sets an order's creation time to 2020, expires it into a terminal rejected state, then expects a customer detail read to succeed. The current 90-day terminal-order visibility rule instead returns 404 (`app.js:91`; `customer-order-history.js:13-25`). The observed missing `body.data` is therefore a stale test expectation, **not evidence that expiry failed**. Correct the fixture to an age beyond expiry but inside 90 days and retain separate history-policy coverage in a subsequent reviewed change. Do not weaken the business rule. No tests or application source were edited during this audit.

## Current synthetic load evidence

Raw result: [local-load-results.json](evidence/local-load-results.json). Existing harness: `scripts/load-marketplace.js`.

- 100 businesses, 2,000 menu items, 9,900 customer accounts plus 100 restaurant accounts and one admin; 20 active simulated devices; no historical orders.
- 20 concurrent workflows, 120 planned/completed orders, every checkout submitted twice with the same key; two API processes and two worker loops sharing a single local SQLite WAL database.
- 120 actual orders; zero duplicate operation keys, unbalanced journal groups or FK errors. Printed states were synthetic acknowledgements, not paper evidence.
- Observed burst rate 833.84 orders/minute over **8.635 seconds**. Browse p95 194.51 ms; checkout p95 252.66 ms; finance summary p95 187.67 ms. This is not a sustained capacity guarantee or a controlled comparison to the 25 October run.
- The raw `financialExceptions: 40` count was checked read-only in this run's synthetic database: all 40 were `cash_sale_recorded / held`, representing cash held by restaurants. They were not failed transfers. Preserve the raw count and this interpretation together.
- The harness raises its synthetic auth limit, pre-creates sessions, uses simulated cards/cash, runs workers at 500 ms rather than the normal 60-second interval and drains printers after the burst. It omits live-provider limits, login hashing demand, real network/device failures, long history, weekly finance, 10,000 businesses and a realistic simultaneous printer/dashboard fleet.

The discovery diagnostic deliberately used a separate synthetic **in-memory** database at each cardinality, avoiding normal data and persistence I/O. Its code and output are checked into this documentation directory so independent developers can reproduce it. No p95/p99 is claimed from three samples, and no result is asserted for the timed-out request.

## Dependency triage

[dependency-audit.json](evidence/dependency-audit.json) is the registry result captured during this audit; dependencies may receive newer advisories or fixes later. The total includes direct and inherited package findings, not thirteen independent security flaws. `npm audit` describes 609 dependencies in its metadata; that is a graph inventory, not 609 server runtime dependencies. The API itself uses Node built-ins.

Direct affected packages include Vite, Expo and React Router DOM. The report proposes Vite 7.3.7 and React Router DOM 7.18.5 as available fixes; these are candidates for compatibility tests, not changes applied by the audit. Its Expo remediation suggests a major downgrade to 51.0.39 from the installed 57 series: **do not run a blind forced fix**. Review the relevant SDK-supported dependency graph and reachable paths first, then pin an approved fix with native build/device regression evidence.

Exposure matters. Vite is used to build the portal and in local development, while the deployed application serves built assets. The current Vite config binds to loopback. One official Windows file-deny advisory requires a network-exposed development server and an accessible sensitive file; that condition was not established here. [Vite advisory](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff). A React Router advisory specifically concerns unstable RSC APIs, while this portal uses a client-side browser router; that particular path is not established as reachable. This does not dispose of the other advisory entries. [React Router advisory](https://github.com/remix-run/react-router/security/advisories/GHSA-qwww-vcr4-c8h2).

Before any upgrade: map each advisory to affected installed version, direct/transitive owner, runtime/build/development usage, attack prerequisites and fix; add controlled lockfile updates in the separate testing repository; rerun all product gates; exercise browser routes, native bundle/signing and the deployment image. No exploitable production dependency incident was verified.

## Scope and remaining validation

Reviewed the accessible application source, manifests/lockfile, migrations, tests, deployment/backup scripts and existing handover documents. The selected Calai reference files were read statically for integration boundaries; this is not a full audit of the original Calai platform. Inventory size is 452 tracked files before the audit. Manual source review and negative tests do not prove every route free of defects; no coverage percentage is claimed.

Not performed: live endpoint penetration/load testing; production DB/secret inspection; current hosting/Stripe/telephony configuration certification; Docker image execution; signed mobile build/device acceptance; a physical Surface/thermal-printer test; real bank payout; independent account-permission audit; complete historical migration/restore rehearsal; 10k-business sustained distributed load. No claim of “90% complete” or “production-ready” was independently verified.

Historical [29 October Stripe trial](../STRIPE_TEST_TRIAL.md) reports sandbox Checkout/capture/refunds and a Monday payout schedule. It explicitly excludes actual bank settlement. That report was read, not rerun. Older README/deployment statements are inconsistent with later evidence; determine current deployed commit and settings from an authorised owner before implementation.

Raw local root-test output remains in ignored `artifacts/audit-tests-2026-10-30.log`; synthetic load DB remains under its ignored timestamped artifact directory. Neither contains production records. Documentation contains no secret credentials or private environment-file values. The audit did not run source-reference tests, normal startup/migration/seed scripts, live Stripe trial scripts, mail send/connect scripts or bridge installers.
