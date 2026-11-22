# Combined business workspace: implementation and release guide

Status as of 22 November 2026: the Cal-Eats workspace, central system-administrator tablet fleet and central signed enrolment follow-up are deployed through PRs #6, #7 and #8; health, integrity and data-preservation checks passed. The read-only Microsoft collector is implemented but remains disabled pending its approved connection. Original Calai remains unchanged. A web deployment is not evidence of a signed mobile release, working physical printer or delivered push notification.

## Boundaries and architecture

- Existing Cal-Eats API, SQLite migration runner, web portal, customer accounts, order/payment records, queues and existing manager app remain the product foundations. The customer app's native identity is unchanged.
- The shared system-administrator Tablets page and safe requested-configuration/reassignment rules are described in [the central fleet guide](CENTRAL_TABLET_FLEET_2026_11_22.md). It does not deliver Intune changes or replace native tablet authentication.
- Migrations 67–72 add the independent business association, scoped operational tablet identity, administrator product permission/verified owner proof, Surface presence/monitoring metadata, central inventory and read-only management evidence. They run only against Cal-Eats storage. Existing restaurant IDs, native Calai IDs, orders, saved commissions and payout records are retained.
- An association references separate native accounts. Product names prefix counters and source records. There is no shared ledger, cross-product balance transfer, email/name matching, shared signing secret or replacement native identity.
- Cal-Eats administrator permission, verified native account connection and setup readiness are separate facts. New associations default to administrator-off. Migration preserves explicit enablement of pre-existing Cal-Eats associations; synthetic seed provisioning is local development/test only.
- The two administrator controls are **Allow Calai connection in the combined workspace** and **Enable Cal-Eats**. The former restricts only the integration, never native Calai operation. Turning either off retains references/history. Re-enablement does not need a business Resume action if the genuine setup remains ready.
- New Cal-Eats intake checks administrator enablement/readiness at quote, creation, transactional commit, scheduling and provider checkout boundaries. Already accepted fulfilment, existing payments, reconciliation, statements and support retain their established rules. Presence does not silently close the marketplace, pause a restaurant, cancel an order or issue a refund.

## Source Calai preservation

The protected Calai baseline and asset candidate are documented in `CALAI_FRONTEND_INTEGRATION_BOUNDARY.md`. Original Calai source and deployment remain untouched. The candidate changes only the business frontend and preserves native settings/forms/login/startup and native actions. Protected backend, host, runtime, authentication, database, printer/configuration, billing and deployment settings are not altered.

The reviewed frontend patch, sanitized manifest and protected hashes are in the [tracked review package](../integration/calai-business-frontend/README.md). Additional ignored local evidence remains under `artifacts/calai-business-frontend-20261122/`. Current remote source is not verified, and no supported existing assets-only deployment/rollback route has been established. The existing container release rebuilds/replaces services. Do not run it, copy into its containers, add a new pipeline or change protected headers to publish this feature.

The new Cal-Eats read adapter excludes native GET call-summary and current-subscription endpoints because source inspection found that those reads can write native records. Calls, native settings and statements link to existing native workflows. No replacement statement backend is fabricated. Source authentication/refresh occurs only in the existing permitted native workflow and uses encrypted integration credentials in Cal-Eats.

## Signing in and linking

1. Start from the existing product-specific business address: native Calai or `/business/` on Cal-Eats. Separate native sign-in remains explicit.
2. An authorised Cal-Eats administrator uses Business accounts (including Calai-only references) to permit the relevant connection. Syncing authorised Calai directory references is an explicit read-only action, not automatic account provisioning.
3. An appropriate owner opens Accounts & connections, verifies the other native login and confirms the returned native business/branch. A five-minute, single-use proof is bound to the initiating user/session/location. Multiple native Cal-Eats accounts require explicit selection.
4. A conflicting existing association requires explicit confirmation of the correct destination. Neither arbitrary IDs nor matching emails establish ownership. An existing enrolled Cal-Eats tablet remains on its native Cal-Eats association when that association is linked.
5. Server commit rechecks the current owner, native proof, administrator setting and location. Late callbacks cannot undo disablement or revoked ownership. Failed/uncertain source reads show unavailable, not a false zero.

The combined UI keeps Calai above Cal-Eats in navigation, separate account/statement links and a persistent order-receiving child while native Calai navigation is visible. Fixed-origin/versioned frame messages carry no credentials, customer records or financial balances. Frame messages are not authentication; parent native user and business IDs must match the independently verified account.

## Operational authority and staff

Ordinary website and manager-phone sign-in can monitor authorised locations but cannot accept/reject, change preparation/fulfilment, test print, retry or reprint. Operational actions require current server-verified device registration, native location and grant plus fresh signed request proof. IDs, browser flags, Windows user-agent and local storage are not authority.

Owners and scoped administrators can assign independent native Cal-Eats staff finance, devices, menu and marketing permissions. The server rechecks those exact current grants. Banking changes, legal acceptance, tablet registration and stronger owner-management functions do not become ordinary manager permissions. A Cal-Eats role never grants native Calai access.

A tablet's Calai read scope also requires the registering human's current verified authority over that exact native Calai account. A different Cal-Eats owner cannot read Calai records by replacing the tablet. Removing that source proof removes its Calai integration scope while leaving native Calai independent.

## Surface installation and enrolment

This is a separate Cal-Eats identity companion, not a replacement or patch for the original Calai printer service. It has no printer queue consumer.

Prerequisites: supported 64-bit Windows, administrator/SYSTEM installation authority, valid signed Node.js 24.19+ executable, current supported Microsoft Edge and browser permission to reach the local companion. Intune/browser policy configuration is a separate task; this installer does not write browser/Intune policy, change kiosk startup or touch Calai's management folder.

1. On the authorised business website, open Surface & printer. A native Cal-Eats owner or separately authorised administrator can download **CalEats-Tablet-Setup.ps1**. Native manager-phone sessions cannot provision an operational tablet.
2. Prepare the companion first if necessary; the installer can run without an enrolment file. It installs only into `%ProgramData%\CalEatsTerminalAuth`, with a separate **CalEats - Terminal Auth Broker** task and protected files. It does not install/restart Calai.
3. When ready at the designated Surface, issue **Register ordering Surface**. Download its private JSON only to the intended Surface. It is single-use and expires after ten minutes. Never email it, commit it or put it in browser storage. If setup expires, request a fresh file; issuance alone does not register a tablet.
4. Run the reviewed installer from an administrator PowerShell with the private file and a verified official Node executable:

   ```powershell
   & .\CalEats-Tablet-Setup.ps1 -NodePath 'C:\Program Files\nodejs\node.exe' -DeviceName 'Restaurant ordering Surface' -EnrolmentPath '.\CalEats-Surface-enrolment.json'
   ```

5. The SYSTEM companion creates an ECDSA P-256 Windows machine key with export disabled and verified SYSTEM/administrator access controls, then signs the server challenge. Current production adapter uses the Windows software key provider; TPM hardware attestation is not claimed. Browser sessions never receive that key or the companion's terminal grant.
6. Open the existing Cal-Eats business address on that Surface. Permit its scoped local-network browser prompt if required. Successful signed discovery and actual order-receive checks establish the application session. A background companion heartbeat, printer service, phone login or login page cannot make the Surface online.
7. Confirm the correct location, current application contact and operational controls. Physical key protection, browser permission, restart/recovery and receipt output still need a real Surface acceptance check before production rollout.

Alternatively, a secured system administrator can select the exact record in **Tablets**, download its serial-limited installer and issue the same one-use setup document there. Prepare the companion before starting the ten-minute expiry. The central flow confirms the exact existing terminal before a replacement and signed pairing binds the registration to that inventory record. Metadata edits invalidate unfinished setup; a serial guard prevents accidental installation but does not replace the protected signing key. Do not issue Cal-Eats setup for a Calai-only location.

The local companion listens on loopback only, validates the exact approved Origin/Host and per-process CSRF/window proof, constrains methods/paths, signs request bodies, and rejects stale/replayed requests. It does not expose a general signing proxy or arbitrary URL forwarding. Browser process reconnection retries are bounded; uncertain operational writes are never automatically replayed.

### Replacement, logout and revocation

- Use Replace ordering Surface deliberately. Existing authority remains until the one-use replacement enrolment commits; that commit atomically revokes the old registration and its grants. A stale replacement cannot replace a different device enrolled in the meantime.
- Use Revoke Surface to withdraw authority immediately. Active browser windows cannot keep accepting with cached credentials. Revocation and enrolment have actor/location/device audit records.
- Reusing the same physical tablet with a different new registration requires its explicit administrator `-ForgetRegistration` option and a fresh authorised enrolment file. This retires local public identity metadata; it does not bypass server revocation or make an expired code usable. Cross-restaurant reassignment remains quarantined until a supported, separately authorised process clears previous browser/native and protected printer tenant credentials and reconciles queued receipts.
- Explicit application logout reports signed logout and clears/revokes the current application grant. A subsequent legitimate sign-in requires a fresh native grant. Companion contact alone does not undo the signed-out state.

## Presence, printer evidence and notifications

See `SURFACE_MONITORING_AND_MANAGER_2026_11_22.md` for timings, server worker, sources, notification configuration, retention and operational steps.

The current printer path supports authenticated service contact and TCP endpoint reachability. It does not produce supported paper-out/cover/WMI/spooler diagnostics or prove physical readiness. A completed network write is uncertain, not printed. The new installer excludes historical Calai patch/shared-connector helpers and stops if a native Calai service is detected. A safe, already-supported shared-printer arrangement must be verified on the actual Surface before installing a second producer.

One durable device/fault episode creates scoped business and platform-admin in-app history. Initial/recovery/reminder delivery is deduplicated and eligibility is rechecked before sending. Read/dismiss is not health recovery. Closed periods do not create false reconnection messages. Offline Surface, offline printing service, unreachable printer and unsupported diagnostics remain distinct.

The existing manager app retains its identity and can build for iOS/Android. Added native notification dependencies require a new signed build. Configure its own approved Expo project/native APNs/FCM credentials and Cal-Eats business-push allowlist/sender. An iOS/Android JavaScript export is not an installed TestFlight/Play build or proof of lock-screen delivery. Push denial/failure leaves in-app incidents available.

## Scoped release and rollback

1. Review the exact release diff and current target environment. Do not merge to an automatically deploying branch merely to preview work. The first authorised Cal-Eats release is now deployed; see the dated verification report for its exact commit and checks. Original Calai and hosted secrets remain unchanged by that deployment.
2. Take and verify the normal Cal-Eats database/media backup. The new backup sanitizer changes the backup copy only: privileged phone sessions, new terminal grants/proofs/pairings and encrypted integration credentials are removed/revoked; native references, original records and financial history remain. A restored environment requires owner reauthentication and terminal re-enrolment.
3. Apply migrations through the existing Cal-Eats migration runner in a dedicated test deployment first. Verify all original-column snapshots/foreign keys, own app routes, authorised source reads and the signed-terminal flow there. Configure monitoring/push only in Cal-Eats.
4. Coordinate physical Surface enrolment and a safe operational rollout before activating the stricter production order-action boundary. Deploying it against an unprepared current ordering browser would intentionally deny that browser's operational actions. There is no insecure remote-acceptance fallback.
5. Release the existing manager app with its unchanged identifiers only once the corresponding API/credentials are ready. Run the real Surface/physical-printer/phone notification acceptance checklist without creating real calls/payments for this change.
6. Release the permitted Calai frontend only when its exact current baseline and an existing isolated asset deployment/rollback mechanism are verified. Until then, retain the reviewable patch; do not use the protected full-container deployment.

Rollback uses the normal scoped Cal-Eats application release and a verified backup when required. Do not downgrade to an older server that restores ordinary-browser acceptance, drop financial tables, reverse payments, delete associations or touch Calai to hide a failed integration. An old backup cannot be used to resurrect a revoked device or push token. If no safe backward-compatible release is available, keep the feature branch out of production and resolve the dependency first.

## Verification and outstanding dependencies

Local checks cover source allowlist semantics, one-use linking/races, separate native identities, admin disablement/readiness, scoped manager capabilities, genuine signed test-terminal requests, revocation/replacement/replay, single order/print effects, deterministic incident/recovery/outbox behavior, privacy/backup and separate financial rounding/history. Tests use software keys, synthetic source adapters and local provider sinks. They are not hardware/production verification.

Exact remaining release dependencies:

1. Current original Calai source confirmation and an already-supported frontend-assets-only release/rollback route.
2. Actual Surface installation/key/browser-permission and app lifecycle check; coordinated replacement of the existing ordinary ordering session.
3. Verified isolated shared-printer arrangement and actual hardware diagnostics/output. Paper/cover capability is currently unsupported, not secretly simulated.
4. Manager-app official Firebase SDK configuration file, APNs/Apple account transition, signed distribution build and physical foreground/background/locked-phone delivery. The existing manager Expo Android credential is now associated with the existing approved FCM key; customer credentials are unchanged. See `apps/admin-mobile/NATIVE_PUSH_SETUP.md` for the remaining exact prerequisites.
5. Deployment sizing and throughput verification for large simultaneous outages; bounded local tests do not establish a 10,000-restaurant alert-delivery SLA.
6. Dedicated Microsoft certificate identity and read-only consent to activate the implemented collector. Remote startup delivery and cross-restaurant physical cleanup/rebinding remain separate unsupported operations; the read-only collector cannot perform them. See `TABLET_MANAGEMENT_CONNECTION.md`.

Final command results and local screenshots are recorded in the verification report next to this guide. Implemented, locally tested and deployed must remain separate statuses.
