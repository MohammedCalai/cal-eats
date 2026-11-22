# Combined business workspace verification

22 November 2026. The Cal-Eats workspace release is deployed; original Calai remains unchanged. The dated release evidence below distinguishes production checks from synthetic/local verification and physical checks still outstanding.

## Live Cal-Eats release evidence

- PR #6 merged at `a7bda06548121a9c12bb8aa5c7cf1954eed2933a`. Its exact source head passed GitHub Actions run 106 on Ubuntu, Windows and the deployment container.
- The existing Cal-Eats Railway service deployed successfully at 16:28 UTC on 22 November. Its health check passed; a read-only production check confirmed schema 70, database integrity and no foreign-key errors.
- All 34 orders and the checked ledger, commission, commercial-acceptance, payout and adjustment records matched the verified pre-release backup. No real payment, order, refund, transfer or payout was initiated by these checks.
- The signed-in Arndale owner page loaded the new workspace at the existing business address. Its account, devices and view-only operational guidance were visible. Arndale was closed with no active orders; the existing printing service continued reporting.
- No operational tablet was registered at that check. The Surface installation/enrolment and physical printer acceptance are still required. A background service contact is not proof of physical printer readiness.
- The manager Android app was separately registered in the existing Cal-Eats Firebase project through the authorised Google account. The customer registration remains separate. The existing messaging-only service account cannot read app configuration; the in-app browser did not produce a downloadable configuration file. EAS credential association, signed manager builds and physical push delivery are not yet complete. Apple reports an outstanding team agreement.

The production backup was also migrated in a private local copy from schema 66 to the new fleet schema 71: all original-column values in 146 tables and all 34 orders were preserved, with foreign-key/integrity checks passing (38 ms). This copy test did not modify production.

## Checks actually run

| Check | Result |
| --- | --- |
| Full API, customer web, portal, printer, terminal and backup/restore core suite (`npm run test:core`) | **797 passed, 0 failed, 0 skipped**, 628.7 seconds |
| Customer mobile tests | **69 passed** |
| Existing manager mobile tests | **8 passed** |
| Customer and manager TypeScript checks | Passed |
| Final portal tests, including subsequent presentation and explicit sign-in recovery checks | **133 passed** |
| Final portal production build | Passed; existing main-chunk size advisory remains (about 657 kB minified) |
| Post-run customer push and business policy/DST checks | **22 passed**, 0 failed/skipped |
| Final terminal transport restriction and broker/logout/replay checks | **9 passed**, 0 failed/skipped |
| Release/package check | Passed: 273 JavaScript files and 28 required files; new companion is explicitly included in Cal-Eats runtime packaging |
| Generated standalone Windows installer | Generated and parsed successfully by the PowerShell parser; **not installed or executed** |
| Existing manager iOS and Android JavaScript/Hermes exports | Both passed; not signed native distribution builds |
| Isolated original Calai frontend candidate | Full pinned-dependency Vite build passed in 40.90 seconds, 14 output assets |
| Calai frontend boundary | 8 protocol tests, 5 JSX parses, patch applicability and protected hashes passed; original snapshot/archive unchanged |

Focused checks overlap the full suite and must not be summed as unique test counts. Two final frontend presentation changes and the tightened local terminal read allowlist were checked with their focused suite/build after the full run; the entire core suite was not needlessly repeated for those changes.

The core tests exercise actual Cal-Eats HTTP routing and migrations with synthetic records, signed software-key test tablets and local provider adapters. They preserve original financial assertions while replacing obsolete test assumptions that an ordinary owner browser could process orders. Ordinary browser/phone denial remains directly asserted. No real calls, customer orders, payments, transfers, provider pushes or production outages were used.

## Principal behaviours covered

- Both connection directions; separate identities/native IDs; explicitly selected branches; colliding IDs; one-use proof retries/concurrency; current owner/session and administrator changes during awaited work.
- New association default-off, explicit enablement/readiness, rejection of crafted owner pause/activation/unlink fields, re-enablement and preserved history/accepted fulfilment.
- Native restaurant manager capability flags and owner/scoped-administrator editing; no self-grant, financial/banking security bypass or cross-product role inheritance.
- Signed enrolled tablet, replay/timestamp/location/session rejection, replacement/revocation, owner-removal during pairing, concurrent acceptance/one capture/one original print job, deliberate checked-original reprints and uncertain outcomes.
- Calai tablet reads require the registering person's current exact source proof. Mutating native call-summary/current-subscription GET paths are excluded. Native financial analytics are not terminal scope.
- Date-window SQL counts and at most 100 visible Eats dashboard records; 123 current-day and 300 historical records plus cross-location rows; London spring 23-hour and autumn 25-hour boundaries.
- Opening without prior sign-in, logout/expiry/staleness, split/overnight/DST/closure, stable recovery, no false closing recovery, one reminder and independent central-monitoring outage.
- Separate app/service/printer evidence, supported-source fault validation, no inferred physical printing, scoped incidents/read state, role removal and durable queued-push revalidation/uncertainty.
- Token rotation/logout, invalid token cleanup, denied/unconfigured push with retained in-app incidents, privacy retention and backup-copy sanitisation without changing live source/financial records.
- Existing customer pricing/offers, saved commissions/refunds/adjustments, banking onboarding guards, payout/statement reconciliation, privacy/deletion, service email, notifications and recovery regressions.

## Browser checks actually performed

Used an isolated loopback-only synthetic Cal-Eats application and a fake local Calai read adapter. No native Calai page was signed in or changed.

Verified owner login; grouped Calai-above-Cal-Eats navigation; separate product counters, account references and statements; view-only pending order/details/messages without acceptance or printing actions; scoped notification list and close control; truthful offline/not-configured/unconfigured-push messages; owner-controlled Surface setup instructions and installer/enrolment controls; administrator account directory with both product cards for a single-product restaurant; administrator offline-business list and timing controls.

Checked desktop and 768×1024 tablet portrait presentation. Local asset rebuilding during the session produced the existing recoverable page-load screen; its Reload workspace action successfully loaded the new bundle. This is not proof of a production zero-interruption deployment.

Screenshots (local, synthetic data):

- `artifacts/unified-owner-devices-tablet-20261122.jpg`
- `artifacts/unified-admin-monitoring-20261122.jpg`

## Release limitations

No signed manager build, TestFlight/Play upload, real push delivery, physical Surface/CNG installation, printer output or supported paper/cover diagnostic check was performed. The Windows key adapter uses non-exportable software CNG storage; hardware TPM attestation is not claimed.

The tested Calai frontend patch and sanitised manifest are committed for review under `integration/calai-business-frontend/`. They have not been applied to original Calai. Its current source baseline and supported frontend-assets-only release/rollback route remain unverified; its protected container release must not be used.

Physical shared-printer compatibility and manager APNs/FCM/Expo configuration remain exact external dependencies. The scheduler's bounded 10,000-location evaluation limit and 25-push dispatch batch are implementation defaults, not a demonstrated large-outage throughput SLA.

See `UNIFIED_BUSINESS_RELEASE_AND_TABLET_GUIDE_2026_11_22.md` for architecture, scoped rollout/rollback, enrolment/replacement and remaining dependencies; `SURFACE_MONITORING_AND_MANAGER_2026_11_22.md` for actual diagnostic support and disconnection/uncertain-receipt operating steps.
