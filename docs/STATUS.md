# Calai Eats local version handover

Updated: 2026-10-24 (Europe/London).

## Delivered

The first persisted local browser app is complete through schema v8 and runs at http://127.0.0.1:4310/. Customer, restaurant and admin workspaces share the original user-supplied Calai logo and navy/blue theme. Implementation was delegated to supported gpt-5.6-sol agents, with lead architecture, review and browser integration checks.

- Customer: restaurant discovery and postcode search, delivery/collection, menu choices, basket, checkout, order confirmation/history/status, reorder, receipts, account export and support.
- Restaurant: order handling with restaurant-owned delivery, editable menu/choices/allergens, delivery areas/fees/minimums, profile, hours/overnight service/holidays/pause, staff access and statements.
- Offers: completed-order customer directory, customer order count/net spend/last order, individually selected recipients, a free item with a qualifying paid order, expiry/minimum controls, recipient/open/reservation/redemption analytics, and customer offer views.
- In-app notifications: persisted recipient-specific order and offer updates, unread counts, mark-read and short order references. Customer notifications poll every ten seconds; the active merchant order panel refreshes every five seconds.
- Admin: approvals/suspension, orders, simulated refunds, manual cash-settlement records, append-only commission/refund ledger, CSV exports, support/deletion review, integration status and a cost-input margin estimate.
- Operations: expiry/outbox workers, tracked browser receipt handoff, disabled live-provider boundaries, local online backup and isolated restore verification.

The user chose **offers only**. Automatic rewards after ten orders are deferred. No real customers received messages; all demo people, offers and orders are fictional local fixtures.

## Verification

- Earlier integration baseline `npm run check`: **49 tests passed, zero failed**, including real loopback HTTP, auth/tenant isolation, order lifecycle, delivery boundaries, financial idempotency/concurrency, refunds, offer reservation/release/redemption, UI serialization and backup safety.
- Persisted HTTP smoke passed: restaurant approval, menu, delivery order, acceptance, visibility, receipt/print record, full refund, balanced ledger and database reopen.
- Browser verified at a 390-pixel phone viewport: original logo; manual login and demo-role access; paid menu modifier; delivery checkout; restaurant progress to completion; customer status updates; tailored offer receipt, reservation and redemption; merchant customer/campaign analytics; support; receipt; readable owner forms and admin controls. No whole-page horizontal overflow in captured screens. Menu and profile forms were saved and re-read successfully.
- Demo order 40A53016: £12.50 paid food including Chilli mayo, £2.50 delivery, free Seasoned fries valued at £4.50, total **£15.00**. The gift added no commission. The earlier £14.50 order plus this order gives **£29.50 customer net spend** and **£1.72 mock commission**. Campaign analytics show one recipient, one opened, one redeemed.
- Online backup `backups/calai-eats-2026-10-24T14-46-02-834Z.sqlite` passed isolated integrity/foreign-key verification with schema v6, four users, two restaurants and two orders. Backup predates the final unchanged-value menu/profile save and remains an order-complete checkpoint.
- Screenshots in `docs/screenshots/` show each principal screen and selected dialogs. Some capture intermediate workflow states (offer available, order placed/out for delivery); the persisted demo orders are now completed.

## Pre-upload follow-up

Following the user's request to conserve usage, the full suite and smoke were not repeated. Account recovery/email confirmation adds schema v7, expiring single-use hashed tokens, all-session revocation on reset, and a read-only local mailbox CLI. A concurrency review also fixed login racing a password reset. Four focused account-access security tests passed; targeted syntax checks passed. The inexpensive repository checker passed, and an offline `npm ci --ignore-scripts --offline --no-audit --no-fund` succeeded after Windows sandbox restrictions on local workspace links were lifted. No registry packages or install scripts were used.

Repository preparation adds pinned toolchain metadata, a matching workspace lockfile, actual environment-variable examples, optional `.env` loading, editor/line-ending settings and private-file exclusions. The screenshot ZIP remains on disk but is no longer in the tracked upload set. Source screenshots and the offline gallery remain tracked. Notifications now focus the referenced order card. Browser review covered the account email-status display, generic forgot-password acknowledgement, initial-load and same-tab reset-link fragment removal, and exact notification destination (40A53016); no real password was changed in the browser. The preview was restarted successfully and migrated the existing database to v7. See ACCOUNT_ACCESS_API.md and REPOSITORY_RELEASE.md.

The user confirmed that directly rendered image tool results are visible on their phone; local Markdown image links were not. Use direct images for future phone previews.

## Run and resume details

The final local preparation adds a guarded hosted-preview profile, secure hosted cookies and exact write origins, persistent SQLite authentication throttles, known-demo-account refusal, an initial-admin CLI with masked or bounded stdin secret input, and a five-second request drain that cannot close SQLite beneath an active handler. Four focused deployment/security tests passed, including a held-handler shutdown regression. The full suite and persisted order smoke were not repeated. The repository check passed for 35 JavaScript files and 21 required files. The existing local database migrated to v8 and the actual HTTP readiness probe passed.

The browser app now includes a phone installation manifest, original-logo icons embedding the unchanged PNG, a public-asset-only network-first service worker and branded reconnect page. A pinned Node 24.19.0 non-root Docker recipe and readiness probe prepare a future single-instance preview with a private persistent volume. Static validation passed; Docker is not installed, so no container was built. Browser installation diagnostics stalled, so service-worker activation/offline interception and real-phone installation remain explicitly unverified. The normal customer screen still rendered after restart. The deprecated Railway config file was omitted in favour of current documented manual setup choices; no service was provisioned.

Node 24.19.0 and npm 11.17.0 are installed. No package download is required. Use the root README for startup and public local fixture credentials, LOCAL_RUNBOOK.md for backup/recovery and the screenshot gallery for the phone walkthrough. The current local Git branch is `codex/local-app`; no remote push or cloud deployment was made. Database, backups, secrets and logs remain ignored by Git.

## Remaining work and limits

This is a local responsive browser app, not a native Expo/iOS binary or a production release. Mock card processing, refunds, cash records and delivery statuses do not contact banks or couriers. Receipt handoff does not verify physical printing. There is no GPS driver map, external push/email/SMS, real email verification, live payout or provider reconciliation. Local password recovery and informational email confirmation are now implemented with a private simulated mailbox.

Native packaging/device validation, verified sandbox payment adapters/webhooks, approved commercial/privacy terms, production security/recovery/monitoring, infrastructure and deployment remain later work. Default local mode still rejects production and non-loopback binding. The new hosted-preview profile is separately guarded, keeps payments simulated and requires an empty non-demo database. Before hosting, verify the container build, mounted-volume permissions, HTTPS/proxy behaviour, backups and phone installation. See DEPLOYMENT.md, HOSTED_PREVIEW.md, CONTAINER_PREVIEW.md and PENDING_DECISIONS.md.

No GitHub, Expo, Railway, paid infrastructure, live payment, DNS or store-submission operation was performed. The user's stop threshold is **5% usage remaining**; check account usage before further sustained work. The latest check during final verification showed 24% remaining.
