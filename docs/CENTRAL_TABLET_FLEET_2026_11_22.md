# Central system-administrator tablet controls

The shared **Tablets** page is `/business/admin/tablets`. Both system-administrator product menus link to the same inventory. It is separate from a restaurant owner's **Surface & printer** page. A restaurant owner, manager or ordinary phone/browser session does not become a system administrator by supplying a tablet or restaurant ID.

## What the page controls

- A display alias, recorded serial and management reference IDs. Renaming this alias does not rename the Windows computer or Intune device.
- A recorded restaurant/location and requested Calai-first or Cal-Eats-first startup. A Calai-only location does not need a native Cal-Eats restaurant account.
- References to independent product accounts, their connection/permission/readiness state and an existing signed Cal-Eats terminal identity where present.
- Cal-Eats terminal revocation and a quarantined reassignment request. These are not Windows device disablement, a native Calai logout or proof that an old browser profile is clean.

Migrations add inventory, configuration-request history and read-only management evidence only in Cal-Eats. Existing native tenants, memberships, money records and printer configuration are not transferred. Serial/Intune/Entra identifiers entered by an administrator are metadata, not cryptographic identity or permission.

## Requested and applied are separate

The page displays distinct stages for a request, management assignment, management offer, device receipt, application and physical verification. A management check-in does not prove the business application is open. An offered script does not prove receipt, execution or successful startup.

The separately approved read-only Microsoft Graph collector was activated and verified on 22 November 2026. No Graph delivery connector or trusted Windows configuration-acknowledgement adapter is connected. Saving a startup preference records a request. It does not assign Intune policy, modify a shortcut, change a watchdog or open a second browser window. Unsupported delivery and acknowledgement stages remain unconfirmed. Read-only script evidence remains separate from startup-request application and physical verification; arbitrary form fields cannot claim that a setting was applied.

Authenticated Cal-Eats application presence remains separate from terminal-companion contact, printing-service contact and physical printer observations. Missing or stale evidence must not be displayed as healthy.

## Enrolment and inventory

The central system-administrator page can now start the controlled one-use physical-tablet enrolment flow. Select the exact native Cal-Eats restaurant, download its independent companion installer, prepare the Surface, then issue the ten-minute single-use enrolment document. If the restaurant has an existing terminal, explicitly confirm its exact current identity; the new setup cannot silently replace it. A serial recorded on the selected inventory row limits that installer to the matching Windows serial to prevent accidental installation elsewhere. This guard is not device authentication.

Pairing still requires the Windows companion's protected key; creating an inventory record or downloading a file cannot enrol a device. Signed physical pairing binds the new registration back to the originating row. A changed record, removed administrator, quarantine, expired file or changed replacement invalidates setup. Issuance alone leaves the working terminal active; successful physical pairing atomically replaces it. Existing owner-issued setup remains available. Calai-only accounts show their native provisioning dependency rather than an incompatible Cal-Eats helper.

Where an administrator has already recorded the same physical tablet, use the explicitly confirmed existing-registration reconciliation action. It must match the current business and genuine active terminal; it does not move keys, grants or sessions. Do not match different records automatically by business name, email, alias or serial.

## Disablement and safe reassignment

1. Inspect the current location, exact registered identity and requested destination. Enter a reason and confirm the operation.
2. Revocation invalidates the affected Cal-Eats terminal, grants and operational principal. A quarantined location cannot use an unchanged owner session or delayed enrolment file to immediately recreate that authority. Already valid unrelated terminals are not treated as physically disabled merely because another device has a pending request.
3. Keep the old location and historical references. The requested destination is separate; the action does not grant the new restaurant access to the old restaurant's information.
4. Keep the device quarantined until an authorised administrator performs and verifies the necessary physical sign-out/profile cleanup through a supported procedure. Protected printer tenant credentials and queued receipts also require separately authorised cleanup/rebinding before a cross-restaurant handoff. Calai's protected authentication and Windows/printer setup must not be changed by this inventory.

There is deliberately no unsupported handoff-completion or security-override button. Completing physical cleanup and reconnecting a reassigned device require a separately supported, authorised procedure. An inventory row with no attached application terminal cannot claim that a physical device or unknown native session was revoked.

## Access, audit and reliability

Fleet changes require a current, secured human system-administrator website session. Phone access can inspect permitted records; it cannot mutate this fleet. Mutations recheck current authority after asynchronous work, use the record's revision and audit actor, old/new values and time. A stale form must reload instead of overwriting another administrator's change.

List and location lookups use bounded server-side pagination and search. Responses are private and not cached publicly. Privileged signing credentials, enrolment secrets and customer addresses are not fleet diagnostics.

## Existing startup pilot

The separately managed Calai-0001 startup pilot must not be reinstalled or overwritten by this work. Its handover reported a script assigned/offered with no execution acknowledgement at that point. Those observations are not proof of successful startup. The terminal-identity companion is a separate Cal-Eats component; it does not replace or patch the shared Calai printer/watchdog/startup setup.

An updated authorised handover later confirmed the startup-only v3 check ran at 16:50 London on 22 November and returned **AlreadyCorrect, Changed=false** for the exact pilot serial. That is a successful configuration check, not a newly applied startup change. Earlier attempts failed before startup writes or backup creation and remain part of that task's history. Its one previously requested restart completed at 16:27; this platform work requested no additional restart.

The actual signed-in application window, absence of popup, authenticated business identity and physical paper output remain unverified. The central page does not import this separate local management record or turn its Intune success badge into application presence. The approved read-only Microsoft connection is now active and an actual runtime read matched the same exact pilot identity, script hash and unchanged result. The central inventory mapping still needs the authenticated administrator's setup; no pilot row or observation was inserted by a privileged backdoor. See [the management connection guide](TABLET_MANAGEMENT_CONNECTION.md). Do not type management results into an application-health field.

For physical pairing and printer/uncertain-result procedures, see [the release and tablet guide](UNIFIED_BUSINESS_RELEASE_AND_TABLET_GUIDE_2026_11_22.md) and [monitoring guide](SURFACE_MONITORING_AND_MANAGER_2026_11_22.md).
