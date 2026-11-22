# Surface monitoring and the existing manager app

This change extends the existing `apps/admin-mobile` Expo project. Its current name, bundle identifiers, branding, approved Expo owner/project and test-distribution guards are retained. It does not create a replacement customer or manager app. All new backend state lives in Cal-Eats; no Calai database, host, authentication, printer service or configuration is changed.

## What counts as online

Cal-Eats application presence requires the active registered operational terminal, its live scoped application grant and a fresh signed application heartbeat. A native phone login, Windows login, Intune check-in, printer-service contact or browser login page does not supply this proof. The presence route accepts only the terminal principal constructed after backend signature/nonce validation; client-supplied product, restaurant, user and device fields are rejected.

The business frontend sends `POST /api/business/accounts/:businessId/surface/heartbeat` with `{sequence,state:"active"}` through the registered native terminal client. The server derives account, restaurant, operator and terminal from authenticated context. Sequence values must increase within the same grant. Receipt time is server time. Signed-out presence is persisted before only that application grant is revoked. A revoked, expired, replaced or signed-out grant cannot resume presence. Reopening obtains a new valid application grant through the established terminal flow.

The independent terminal/printer-service heartbeat is deliberately not a presence signal. The application heartbeat must remain mounted while either product's navigation is being used, while Cal-Eats' authenticated application and order-receiving client remain active. No heartbeat runs from the manager app or an old service worker.

Defaults are stored in `surface_monitoring_settings`, editable only by a Cal-Eats platform administrator:

| Setting | Default |
|---|---:|
| Application heartbeat | 30 seconds |
| Backend evaluation | 30 seconds |
| Contact stale threshold | 120 seconds |
| Opening notification grace | 120 seconds |
| Known sign-out/session-expiry notification grace | 60 seconds |
| Stable application recovery | 30 seconds and two fresh observations |
| One additional outage reminder | 600 seconds |
| Printer observation stale threshold | 60 seconds |
| Simple printer/service fault confirmation | 30 seconds |

Known sign-out is shown offline immediately; only its notification is delayed. Stale-contact notifications do not add the opening grace again. The scheduler enumerates restaurants even if no Surface has ever contacted Cal-Eats. Approved trading restaurants with no eligible Surface are offline rather than indefinitely exempted as setup. Calai-only businesses or administrator-disabled Cal-Eats do not generate Cal-Eats Surface outages.

Opening periods use the native Cal-Eats schedule and holiday dates in `Europe/London` by default, including split shifts, previous-day overnight intervals and daylight-saving transitions. A supported native location timezone can be read if available. The current native schema has ordinary opening intervals and holiday-date closures; this change does not invent a second editable schedule or modify Calai's hours. Closing ends a monitoring episode with `opening_period_ended`, never a fabricated connection-restored event. Manual pauses and order-availability rules are not changed by this monitoring module.

## API and app views

- `GET /api/restaurant/restaurants/:id/surface-status` returns current authorised Surface and separate printer evidence, observed reasons, last verified contact, expected opening period, outage duration and notification-delivery limitations.
- `GET /api/restaurant/restaurants/:id/device-incidents?page=1&pageSize=20` returns bounded persistent incident history.
- `PATCH /api/restaurant/restaurants/:id/device-incidents/:incidentId/read` marks only that user's read state; it does not change device health or resolve the incident.
- `GET /api/admin/surface-monitoring?state=offline&page=1&pageSize=25` provides the platform-admin list. State snapshots are indexed so list requests compute current details only for the returned page.
- `GET/PATCH /api/admin/surface-monitoring/settings` reads or changes timing defaults with an audit event.

The existing manager app adds an Overview Surface summary and More → Devices & incident history, with loading, error, empty, last-known and current-status presentation. Its existing order screens and incoming-order banner are view-only: no acceptance, rejection, ETA/progression or print actions remain. Pending orders say “Awaiting acceptance on restaurant tablet.” Dismissing a phone banner does not process its order.

An explicit Platform administrator sign-in uses `/api/native/platform-admin/auth/login`; a normal restaurant sign-in continues using its existing native business endpoint. The separately authorised administrator sees paginated cross-business monitoring. This does not grant financial or Calai product authority by association. The manager UI uses native per-restaurant capabilities independently for finance, menu, marketing and devices; finance permission never exposes owner-only bank modification or statement-schedule editing. Restaurant device access requires current owner or `can_view_devices` permission; backend, notification inbox, unread counts, SSE and queued push all recheck current roles, membership and source-incident ownership.

## Notification setup and delivery

Reuse the existing private Expo sender connection, but explicitly approve the manager app's own project and native push credentials. The customer app's permission or token is not a manager registration. Current manager project: `6282b87e-36ae-43bb-80b7-12d69108a411`; current native identifiers: `info.calai.caleatsadmin` for both iOS and Android.

Server settings in the authorised Cal-Eats environment:

```text
CALAI_BUSINESS_PUSH_ENABLED=true
CALAI_BUSINESS_PUSH_IOS_PROJECT_IDS=<approved manager-app project UUID>
CALAI_BUSINESS_PUSH_ANDROID_PROJECT_IDS=<approved manager-app project UUID>
CALAI_BUSINESS_EXPO_PUSH_ACCESS_TOKEN=<private existing Expo sender token, optional if CALAI_EXPO_PUSH_ACCESS_TOKEN is already authorised>
```

Enabling delivery requires at least one approved project and the private sender token. Never place a sender secret in an `EXPO_PUBLIC_` variable. Manager builds need their own valid APNs/FCM credentials and Expo notification entitlements/configuration; no new credentials are created by this implementation. `expo-notifications` is added to the existing app configuration. A new signed native manager build is required to install that native capability.

More → Phone notifications explains the purpose before requesting OS permission. Denied permission, simulator/browser limitations, an unapproved project or an unconfigured sender are reported; incident history remains available. Already granted permission is rechecked after foregrounding, and token rotation registers the current installation again. Registration is serialised with logout, bound to the current native session and audience, encrypted server-side and retired on session logout/expiry or role changes. Native administrator tokens use a separate platform-session registration table. Notification links accept only product/recipient-scoped identifiers, then fetch current authorised details rather than trusting a supplied URL or cached status.

One durable episode produces an initial in-app incident for currently authorised owners/managers AND platform administrators. Each recipient/channel is deduplicated. A reminder is sent once after ten minutes; recovery requires stable fresh evidence and an earlier opening notification for that recipient. Faults dependent on a Surface outage are grouped under that outage. Alerts contain restaurant/location identity and generic device/order references, never customer names, contact details or addresses.

The durable outbox rechecks current session, device generation, recipient authority, product enablement, schedule and incident state immediately before provider dispatch. Expired/superseded messages are cancelled. Claims are leased; a crashed or lost response after dispatch is uncertain rather than blindly resent. Invalid tokens are erased. Provider acceptance and provider delivery receipts are separate recorded states; neither proves a person saw or read an alert. Current bounded dispatch defaults are 25 jobs per worker invocation. This is not a demonstrated 10,000-restaurant simultaneous-outage push-delivery SLA; deployment capacity and sender throughput must be sized and verified separately.

The evaluation worker yields between batches of 100 restaurants and defaults to evaluating up to 10,000 per cycle. A missed central evaluation window produces a platform-monitoring incident and suppresses misleading restaurant fault floods while the monitoring service stabilises. No production load or capacity claim follows from unit fixtures.

## Printer evidence and operational guide

The installed Cal-Eats bridge's existing authenticated connectivity reports distinguish a reporting service from a reachable configured printer. A bridge heartbeat or installed queue is never labelled physical readiness. The common result is “No reported printer fault” with its source/timestamp and `physicalReadinessKnown:false`, or “Printer status unavailable” when evidence is missing or stale. With an offline Surface the display says “Tablet offline — printer status unavailable”; with an online Surface and stale bridge contact it says “Printing service offline.” Printer-only faults never pause sales, cancel/refund orders or change acceptance.

The existing `business_device_health` storage can carry trustworthy driver/hardware observations. Paper-out, cover-open and other specific faults require a supported diagnostic source. Current legacy connectivity reports do not establish those faults; advanced Windows/driver diagnostics need a verified isolated producer before claiming real hardware support. Physical unplugging, power loss and paper/cover behaviour have not been verified on hardware by these automated fixtures.

When the printer disconnects:

1. Keep using the accepted order details on the registered Surface. Acceptance and printing remain separate outcomes.
2. Check printer power, paper, cover and its supported USB/network connection. Inspect the shown source and observation time.
3. If the Surface is online but the printing service is offline, check the existing restaurant printing service without changing Calai's service or configuration.
4. Review queued jobs on the Surface. Do not re-accept an order or repeat its payment to fix printing.

For an uncertain print result, first check whether the receipt actually printed or remains queued. A lost acknowledgement can follow a real printer submission. Only use a deliberate tablet-side reprint after that check, and identify duplicate copies as REPRINT through the existing printing workflow. The phone never submits retries/reprints. Windows queue submission/disappearance is not a reliable physical printed acknowledgement; exactly-once physical printing is not promised.

## Retention, backup and release

Migration70 adds Cal-Eats-only presence/configuration/snapshots, incident metadata and separate platform-phone delivery registrations. It reuses existing incident and restaurant-phone registration tables. It does not alter Calai native IDs, billing, orders, printer configuration or account history. Commission and payout calculations are not touched.

`runBusinessMonitoringRetention` runs at most daily and follows the existing approved 30-day operational-content period. It removes old resolved monitoring history/read markers, delivery metadata, stale presence and expired push registrations while keeping active issues and all financial/order/contract/print-job records. Privacy-disabled environments do not silently activate deletion.

Cal-Eats backup sanitisation acts on the new backup COPY only: it removes phone delivery registrations, native phone/platform sessions, presence, terminal grants/nonces/pairing codes and connection proofs; clears encrypted Calai integration credentials; and revokes Cal-Eats terminal registrations. Native product references, associations and financial history remain. After restoration, owners must reauthenticate connections and re-enrol the authorised Surface. This prevents a stale backup from restoring a previously revoked tablet or old push delivery. Original Calai backups and services remain unchanged.

Run local verification with the repository's API tests, `npm run admin:mobile:check`, manager tests and an Expo iOS/Android bundle export. A bundle export is not a signed build, TestFlight installation, push-provider registration or physical device/printer verification. Deploy only through the scoped Cal-Eats release process after review and backup checks. No production publication, live push setup, Windows installation, real call/order/payment or protected Calai deployment is performed by this monitoring implementation.

## Verified implementation references and current transport boundary

Primary references were checked online on 22 November 2026:

- [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html): authentication does not establish permission for every operation. Deny access unless an explicit rule permits it, and validate the action and resource on every request. The Cal-Eats implementation applies this at terminal actions, monitoring reads, notification inbox/counts/streams, token registration and final queued-push dispatch. Restaurant/device identifiers and client presentation flags are never authority.
- [Microsoft JOB_INFO_2](https://learn.microsoft.com/en-us/windows/win32/printdocs/job-info-2): completion can mean delivery to the printer before paper output. Drivers/port monitors without TrueEndOfJob may report printed immediately after submission. Queue state, disappearance or a submission acknowledgement therefore cannot establish a physically printed receipt. Missing post-submission acknowledgements retain uncertainty rather than triggering a blind duplicate.
- [Microsoft Win32_Printer](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-printer): WMI obtains printer state through the spooler; a driver that does not supply status can appear idle. An installed queue, an idle result or a running service cannot certify physical readiness. Specific paper/cover faults require a supported driver/hardware report, and unavailable diagnostics remain unknown.

The current inspected Cal-Eats transport is `TcpEscPosTransport` in `apps/print-bridge/src/transports.js`. Its diagnostic opens a zero-byte TCP connection to the configured printer endpoint; the generated package uses port 9100 and a five-second connection timeout. This establishes only endpoint reachability. It does not query paper/cover state, use Windows WMI/spooler status or verify a printed receipt. A completed network-stack write returns `uncertain`, preserving the possibility that the receipt printed. `FileSinkTransport` is explicitly simulated development/test output and is not physical-printer verification.

The bridge reports `printerReachable` and its transport through the authenticated existing printer heartbeat. Server receipt/probe time supplies freshness; service contact and application presence remain separate. Supported advanced observation sources are accepted only for the currently enrolled terminal and configured printer; spooler/driver readiness alone still cannot set physical readiness. No new diagnostic producer is installed by this monitoring change.

The release installer now detects an existing native Calai printing service and stops without changing it. Historical patch/shared-connector helpers are excluded from the new release package. Shared physical-printer coexistence remains a separately verified release dependency; this implementation does not establish that two producers can safely share it.

## Local verification results

- Monitoring plus existing notification replay/backpressure checks: 23 passed, zero failed/skipped. Cases include opening without prior contact, split/overnight/DST hours, terminal-only/replay/sign-out proof, distinct printer evidence, recipient revocation, backup/retention, recovery, one reminder, stale delivery and post-dispatch uncertainty.
- Existing manager tests: 8 passed, zero failed/skipped. TypeScript checking and local iOS/Android exports passed. Final exports are under `artifacts/manager-monitoring-ios-20261122` and `artifacts/manager-monitoring-android-20261122`.
- Customer/closure plus backup/restore/privacy regression run: 21 passed, zero failed/skipped after choosing the explicit enrolled-tablet adapter for operational actions. This includes the 10,001-customer directory (462.5 ms and 13,339 response bytes in its observed local run), both verified account-closure cases and immutable-source backup tests. The business-only backup checks retained native/financial references, revoked restored authority and absence of removed secret bytes.
- Finance/lifecycle legacy fixtures now explicitly choose signed tablet actions while keeping ordinary owner reads for ledger/commission assertions. The first broad finance run passed 36 of 42; its six fixture-context failures were corrected and the focused four-file rerun passed all 11 checks, including discount/delivery commission, fully covered vouchers, zero-rate snapshots and migration/current-runtime compatibility. No financial expected values or production permissions were weakened. Full repository results are recorded separately by the integration run.

These are isolated automated/local bundle checks. No physical Surface, real printer, installed manager phone, lock-screen provider delivery or production-scale throughput test was performed.
