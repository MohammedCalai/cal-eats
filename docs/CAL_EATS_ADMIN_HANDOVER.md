# Cal Eats Admin — implementation and rollout

## Applications and authority

`apps/admin-mobile` is the restaurant phone companion, named **Cal Eats Admin**.
It uses the existing Expo 57 / React Native application and the separate
`info.calai.caleatsadmin` identifiers on iOS and Android. Its Expo project is
`6282b87e-36ae-43bb-80b7-12d69108a411` under Yankee1707. The customer application's
identity, projects and interface are not changed by this feature.

The existing business website remains the ordering tablet's interface and the
remote management website. Native and ordinary web sign-in do not grant order
processing authority. The API requires an active enrolled key, a current
authorised business user/session, the matching restaurant, a fresh ordering-screen
proof and the existing valid order transition. Public capability flags explicitly
report processing/printing as false; operator eligibility is a separate field and
is not authority. Platform administrator accounts remain separate.

The phone navigation is Overview, Orders, Payouts, Manage, More. It reuses real
dashboard, order, menu/photo/modifier, hours, marketing/loyalty, customer messaging,
support, account-recovery and finance endpoints. Restaurant switching clears
restaurant-specific views. Logout clears secure sign-in, drafts and delivered
notifications and revokes the business push registration. Role changes remove
management/finance screens. Offline data is read-only and labelled as previously
loaded; there is no offline order-action queue.

Owners and expressly permitted managers can inspect sales/commission/payouts.
Sales totals use the existing recognised confirmed-order/payment definitions:
accepted, preparing, ready, out-for-delivery and completed; real card orders must
have captured/refunded capture evidence. Gross sales, adjustments, net earnings,
transfers and bank deposits retain their distinct meanings. Saved commission
snapshots, rounding, the 7% after discounts including charged delivery, and weekly
payout schedules remain authoritative. The app does not create transfers or fees.
Bank changes, agreements and report emails remain owner-only. CSV reports use the
existing attachment-email flow rather than downloading files onto a tablet/phone.

## Running and building

From the repository root, install the locked workspace dependencies using the
project's Node/npm versions. Set `EXPO_PUBLIC_API_BASE_URL` to the intended
Cal-Eats HTTPS backend before starting or bundling the app. Loopback HTTP is
accepted for local development only; the original Calai origin is rejected.

```text
npm run admin:mobile:check
npm test --workspace=@cal-eats/admin-mobile
npm run store:check --workspace=@cal-eats/admin-mobile
npm run admin:mobile:start
```

Native test distribution profiles are already in `apps/admin-mobile/eas.json`:
`preview` produces an internal Android APK, `simulator` an iOS simulator build,
and `store-test` an App Store/Play test binary. Build from that app directory with
the approved project and an authenticated EAS account. Public production builds
remain guarded. A JavaScript bundle export is not an installable signed iPhone
binary. TestFlight also requires that business app's Apple identifier, profile
and distribution setup; customer app signing is not this app's identity.

Two installable Android QA packages were built from the frozen native source on
15 November 2026. They are under the Git-ignored task artifacts directory:

| Package | Target | SHA-256 |
| --- | --- | --- |
| `artifacts/cal-eats-admin-20261115/Cal-Eats-Admin-local-QA-arm64-v8a-20261115.apk` | ARM64 Android phone | `f3c8fe5b77f73ff733949831b98dd650a288a83b018e1797064d2de6314881b6` |
| `artifacts/cal-eats-admin-20261115/Cal-Eats-Admin-local-QA-x86_64-20261115.apk` | x86-64 Android emulator | `77661f7b0a14651baa9d60939f969d4e8754318cd211e8ec89ba8b2fbc77fdf1` |

These packages use Android Debug signing, version 0.1.0 (1), package
`info.calai.caleatsadmin` and the isolated local API at
`http://127.0.0.1:4350`. They do not connect to the live restaurant. For a USB
Android test phone, start the isolated QA backend with
`node apps/admin-mobile/scripts/local-qa-server.mjs --isolated-fixture`, enable authorised USB debugging
and run `adb reverse tcp:4350 tcp:4350`, then install the matching package with
`adb install -r <apk>`. Keep the computer connected during that local test. The
temporary QA fixture prints its synthetic login details in the local console and
contains synthetic accounts/orders only. It clears inherited provider settings,
uses a new temporary database, and deletes it on a graceful exit. Production/test
distribution against the hosted service uses the HTTPS build profiles above
after a compatible backend and tablet cutover; it must not use this local build
or the Android Debug signer. Both packages passed signature, package, ABI and
archive-integrity checks. They have not yet been opened on a physical phone.

The updated backend and portal must be deployed together with an agreed tablet
cutover. An old hosted backend does not provide the new capabilities/health API.
Do not distribute this new app pointing to an incompatible backend, or silently
deploy tablet enforcement while the real ordering tablet remains unenrolled.
Only local isolated databases and synthetic signing/printer adapters are used by
the automated checks. There is no development seed or software key in production.

## Pairing, replacement and scope

See [Windows installation and enrolment](WINDOWS_TERMINAL_COMPANION.md) and
[terminal authentication protocol](ORDERING_TERMINAL_AUTHORITY.md).

1. Install the current protected Cal-Eats printing companion on the authorised
   Windows ordering tablet using the scoped installer. It must run as SYSTEM in
   its protected installation, rather than from an ordinary Downloads folder.
2. Sign into the existing business website on that tablet. The owner/admin opens
   Devices and issues a single-use ten-minute pairing code. The local companion
   creates its non-exportable P-256 Windows machine key and pairs its public key.
3. The ordering page gives the companion a short-lived, one-use session handoff.
   Its private delegation stays inside the service. The browser obtains a new
   one-use screen challenge every reporting interval. A running background
   printer service alone never proves the ordering page can receive orders.
4. Verify the tablet is online, configure the intended printer and perform an
   explicitly labelled test receipt. Confirm the physical paper output.

Replacement is explicit and limited to one active tablet per restaurant. The old
key/session loses authority when the new pairing completes; revocation can happen
immediately from owner/admin controls. Use a fresh printer setup for the new
device. Do not copy machine keys, credentials or uncertain-job journals. Same-PC
re-enrolment needs the scoped administrator procedure in the Windows guide.

The server checks key possession, not remote Windows/TPM attestation. Supported
Windows CNG storage, non-exportability and the SYSTEM/Administrators ACL are
enforced and verified by the installed companion. An administrator-controlled or
compromised Windows installation is outside a browser-only security boundary.
There is no remote acceptance fallback if the terminal is unavailable.

## Health evidence and incidents

Separate evidence is retained for the ordering screen/session, printing service,
configured printer and each receipt job. Network diagnostics establish TCP
reachability only. The explicit Windows printer adapter reads supported Win32
spooler/driver flags, including paper-out, cover-open, paused queue, error and
offline when the actual driver reports them. Missing/unsupported diagnostics stay
unknown. Zero driver flags mean **No reported printer fault**, not confirmed
physical readiness. No ordinary phone browser contacts a local printer.

The server records the enrolled location/device, selected printer, version,
observation source, observation time, server receipt time and real queued/failed
job counts. Both observation age and receipt freshness must be valid. Re-sending
one cached observation cannot count as two recovery checks.

Defaults are configurable rather than embedded product assumptions:

| Setting | Environment variable | Default |
| --- | --- | --- |
| Report interval | `CALAI_DEVICE_HEALTH_REPORT_SECONDS` | 15 seconds |
| Stale/offline threshold | `CALAI_DEVICE_HEALTH_STALE_SECONDS` | 60 seconds |
| Connectivity confirmation | `CALAI_DEVICE_HEALTH_CONFIRM_SECONDS` | 30 seconds |
| Distinct healthy recovery checks | `CALAI_DEVICE_HEALTH_RECOVERY_CHECKS` | 2 |

The backend creates one durable incident per device/fault/job episode. It sends
one opening and one recovery notice, deduplicates retries and retains in-app
history if push cannot deliver. Tablet outages group dependent faults. Closed
restaurants with no actionable live orders retain incidents without routine
overnight pushes. Reading a notification does not make the printer healthy.

The offline block is checked again at quote/order creation. Recovery clears only
that block after sustained fresh evidence; it does not undo a manual pause,
opening hours or suspension. Printer-only problems do not pause/cancel/refund
orders. Existing pending acceptance deadlines and payment reconciliation remain
in place.

## Phone notification connection

Business notifications have their own encrypted registration table, native
business sessions, approved project list and durable delivery outbox. They do not
reuse customer session tables/project configuration. Provider credentials stay on
the backend. Push defaults to **disabled** until configured:

```text
CALAI_BUSINESS_PUSH_ENABLED=true
CALAI_BUSINESS_EXPO_PUSH_ACCESS_TOKEN=<private business sender connection>
CALAI_BUSINESS_PUSH_IOS_PROJECT_IDS=6282b87e-36ae-43bb-80b7-12d69108a411
CALAI_BUSINESS_PUSH_ANDROID_PROJECT_IDS=6282b87e-36ae-43bb-80b7-12d69108a411
```

For Android, provide private `CAL_EATS_ADMIN_GOOGLE_SERVICES_FILE` at build time,
for the Firebase Android app `info.calai.caleatsadmin`, and configure its FCM v1
credential in this business Expo project. For iPhone configure this business
bundle's APNs signing/profile and push credential. The customer app's sender is
not proof these are connected. These settings have not been activated by the
source implementation.

The app explains permission denial, missing setup and registration failures;
in-app incidents remain usable. Invalid tokens are retired, logout removes the
registration and each send rechecks session, generation and restaurant access.
Known provider rate-limit rejection has bounded retry; a lost dispatch response
is uncertain and is not blindly re-sent. Lock-screen incident text contains the
restaurant identity and order reference only, not customer names or addresses.

## Receipt recovery: staff guide

- **Tablet offline:** open the registered ordering page and check internet/power.
  Until it is receiving orders again, printer status is unavailable. Do not use a
  phone to accept orders.
- **Printing service offline:** check the scoped Windows service/task on that
  tablet. Orders already accepted remain visible. Restart only that Cal-Eats
  component; do not stop unrelated Calai processes.
- **Printer not connected:** check printer power and the configured USB/network
  connection. Paper/cover instructions appear only when supported diagnostics
  actually report those faults. Continue using the on-screen order if needed.
- **Print result uncertain:** first check the physical receipt and printer queue.
  On the registered tablet, record whether the receipt is present. If there is
  no receipt, use the explicit labelled **REPRINT** action after checking the
  existing job. Never delete the journal to force another send.

Acceptance and printing are separate durable outcomes. A failed receipt never
returns the order to pending or repeats capture/acceptance. Jobs are persisted
before dispatch; a server submission marker precedes printer bytes. Results and
spooler IDs are journalled before acknowledgement. A lost acknowledgement replays
the same result, never the receipt bytes. Only proven pre-submission failures
have bounded automatic retry. Submitted/legacy claimed jobs with missing evidence
become uncertain. Spooler submission/disappearance is not physical printed proof.

## Data migration, verification and outstanding evidence

Migrations 64 and 65 add enrolment, explicit manager capabilities, health,
incidents, separate push and additional receipt states. They do not auto-enrol an
old printer or grant operational permission to a login. Existing order/payment
snapshots, users, menus, printer credentials and historical receipt states are
preserved. Restorable backups remove native tokens, delegated sessions, handoffs,
pairing codes, push sends and old health/screen freshness; financial facts and
public enrolment keys remain. Original Calai voice ordering is not migrated.

Focused checks cover tenant/origin/body/nonce/session/revocation denial, concurrent
acceptance, receipt idempotency and uncertainty, cached diagnostic freshness,
outage/recovery/manual pause, quiet/deduplicated push, token generation/logout,
populated schema upgrades, financial rounding and authoritative payout reporting.
See the task validation log for executed commands and outcomes. Synthetic tests
are not Windows hardware or physical-phone proof.

Before production cutover: install/enrol the real Windows tablet; verify CNG under
its SYSTEM runner, browser local-network permission, actual printer diagnostics,
unplug/reconnect, service restart and uncertain receipt recovery. Connect the
business project's APNs/FCM/sender, make signed test builds and verify background
and locked-phone delivery. Complete that evidence before publishing the app or
enforcing the new terminal requirement on the live restaurant.

Bounded queries, indexed health due-times, durable jobs and capped workers are
implemented. This revision is not a certification of 10,000-restaurant hosting
capacity; that needs a representative deployment/load test and capacity planning
for the existing single-writer database and notification throughput.

Implementation references: [OWASP authorisation guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html),
[Microsoft JOB_INFO_1 status semantics](https://learn.microsoft.com/windows/win32/printdocs/job-info-1),
[Microsoft PRINTER_INFO_2](https://learn.microsoft.com/windows/win32/printdocs/printer-info-2),
and [Win32_Printer reporting limitations](https://learn.microsoft.com/windows/win32/cimwin32prov/win32-printer).
