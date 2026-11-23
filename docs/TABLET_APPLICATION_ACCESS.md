# Central tablet assignment and application access

The system-administrator Tablets page lists real Windows devices through the existing certificate-based, read-only Microsoft connection. It also lists saved Cal-Eats tablet assignments and protected application registrations. It does not install software, change Intune, change Windows startup, or change the original Calai website or printer service.

## Administrator workflow

1. Open **Tablets → Microsoft tablets** and select the actual device. Check its name and serial against the intended physical tablet.
2. Give it a useful Cal-Eats display name, choose its existing business/location, and choose **Calai**, **Cal-Eats**, or **Calai + Cal-Eats**. The selected services must already be enabled, connected and ready for that business. This does not enable a business subscription or create native account authority.
3. Save. A device directory record or ordinary owner login does not enrol the tablet. For a first connection with an exact serial, the same page downloads one private, serial-bound setup file containing the ten-minute one-use enrolment. Run it on the intended tablet as a Windows administrator. It refuses an existing different application identity. Existing/replacement identities retain the separate reviewed replacement process; issuing replacement setup leaves the old device active until successful signed replacement pairing. The existing companion signs requests with its Windows-bound identity.
4. A paired application reads its current configuration, renders the corresponding interface, and acknowledges that exact revision using a signed request. The page shows **Waiting for tablet** until the server receives that acknowledgement, then **Received** and its server time. Neither saving nor a Microsoft check-in creates a receipt. Received does not mean Windows startup or physical printing was tested.

An existing native Calai-first Windows application remains separately managed. The product choice controls the Cal-Eats-owned combined/embedded application; it cannot disable or modify the original Calai site. Native Calai access still needs the existing exact-account owner proof. Device mode does not create that proof. After an administrator has paired a tablet, the owner who verified the native account can open **Accounts & connections → Calai → Allow Calai on this tablet** and confirm the named device and business. This adds read-only Calai access to that same registered tablet when its mode includes Calai. It does not renew pairing or change the selected mode.

The Arndale pilot applies Calai-only mode to a paired tablet at an existing Cal-Eats restaurant. A new business with only a native Calai account still needs first enrolment by an issuer already verified for that exact account. The current owner website has no first-enrolment flow for that case. The owner approval described here requires an existing pairing.

## Moving or disabling a tablet

Moving an already assigned device uses the safe reassignment action. It revokes its linked Cal-Eats identity and quarantines both relevant locations until supported physical session/printer-tenant cleanup is complete. There is no manual “applied” or cleanup-complete override. This page cannot clear a previous human browser or native Calai session.

Disabling/replacing still revokes the appropriate protected device authority immediately under the existing rules. A product-only change keeps a valid grant, but the server recalculates scope on each signed request. It clears old ordering-screen presence and requires current contact again. Removing Cal-Eats is blocked while active Cal-Eats orders or submitted/pending print jobs would be stranded. Readiness and unfinished work are checked again at actual registration association and signed pairing, including when work arrives after setup was issued. Checkout immediately refuses new Eats work if the current active tablet excludes Eats. A printer’s existing acknowledgement can still reconcile a dispatched result.

## Connection and limits

The existing `CAL_EATS_INTUNE_READ_ENABLED`, tenant/client/certificate and private-key-file settings are reused. The device directory requires the already approved Microsoft Graph application permission `DeviceManagementManagedDevices.Read.All`; no write permission, new key, script execution or device action is introduced. Script-status collection remains the separate existing read-only function.

Directory fields are limited to device identifiers, name, serial, manufacturer/model and management contact time. The adapter follows only the exact Graph managed-device collection with the Windows filter and bounded page size. Reads have deadlines/body limits, reject unsafe provider links, and are briefly cached. If the configured page bound is reached, the UI explicitly reports an incomplete result; it does not claim an unbounded complete fleet or fabricate missing devices.

## API and app acknowledgement

- `GET /api/admin/tablets/directory`: secure system-admin-only bounded real-device list, with existing saved assignment summaries.
- `POST /api/admin/tablets/directory/{managed-device-id}`: assigns a device returned by the current server-read directory. It creates metadata and device policy only, without terminal authority.
- `POST /api/admin/tablets/{tablet-id}/configuration`: one atomic, audited command for display name, same business/initial assignment and device-scoped application selection. Requires the current record revision.
- `POST /api/admin/tablets/{tablet-id}/setup-package`: private first-connection PowerShell attachment. Requires a current revision, no previous/current application identity, exact serial and explicit `confirmReplaceTerminalId:null`. It issues and builds within one transaction; any builder error rolls back issuance. A verified Calai-only native business can enrol without an Eats restaurant only when the current issuer has the exact native Calai account proof. An unverified reference is refused.
- `GET/POST /api/business/accounts/{business-id}/terminals/calai-authorization`: checks and records the verified owner's acknowledgement for an existing paired tablet. The POST accepts only the expected terminal ID and rechecks the owner, native account, and live registration. A replacement tablet must qualify separately.
- Signed `GET /api/business/context`: returns current `products[*].allowedOnTablet` and optional `tabletConfiguration` containing `tabletId`, `revision`, `selection`, `status` and `receivedAt`. Native restaurant identity remains stable across mode changes; it is not authorization.
- After rendering, signed `POST /api/business/accounts/{business-id}/surface/heartbeat` with exactly `{ "state": "configuration_received", "configurationTabletId": "<current tablet UUID>", "configurationRevision": n }` records a durable receipt for the current terminal/business/revision. This reuses an existing native allowlisted path, so the companion does not need a new privileged route. It does not record an online heartbeat, print a receipt or change Windows.

The acknowledgement branch uses current signed device and grant validation, request freshness/replay protection, exact payload validation and current record revision. Repeated acknowledgements retain the first server receipt time. A stale revision, another location, revoked device, human session or supplied applied/status flag cannot acknowledge it.

Automated tests use explicit synthetic directory, software-key and printer adapters. They do not establish physical Windows key non-exportability, real phone delivery, Windows startup behaviour or paper output. Those remain separate physical checks.
