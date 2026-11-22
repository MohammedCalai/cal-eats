# Manager app native notifications and installation

## Identity and isolation

The phone's display name is **Cal Eats Admin**. Use the existing `@yankee1707/cal-eats-admin` project, ID `6282b87e-36ae-43bb-80b7-12d69108a411`, and iOS/Android identifier `info.calai.caleatsadmin`. Do not initialise a replacement Expo project or reuse the customer app's `uk.co.calai.caleats` identity. The customer app and original Calai configuration are separate and remain unchanged.

The manager app registers its installation with the authenticated Cal-Eats backend. Device/printer incidents remain available in the app if notification permission is refused or push delivery is not configured. A read incident does not clear the underlying device fault. Phones remain unable to process or print orders; those actions require the enrolled ordering tablet.

## Confirmed provider status — 22 November 2026

Read-only provider requests confirmed:

- The existing Yankee1707 Expo session can access the existing manager project. Android signing credentials exist; the manager project has no FCM credential association. Existing iOS manager builds were simulator builds; no manager iOS signing/push credential record was present.
- The manager Android registration was created through the authorised Google owner console in the existing `cal-eats-notifications` project: app ID `1:267285017965:android:806f06e062f0931dbb9664`, package `info.calai.caleatsadmin`. The customer registration remains separate. The existing messaging service account authenticates, but the Firebase app-configuration API returns `403 PERMISSION_DENIED`; no official Firebase/gcloud user CLI session is available. The in-app browser's download did not return a configuration file. Do not expand the messaging account's permissions or create another private key to work around this.
- The existing Cal-Eats App Store Connect API credential returns `403 FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED`, including for the existing customer bundle. The Apple team Account Holder must review and resolve the applicable agreement directly. A new Expo login, APNs key or customer build does not fix that agreement.
- Existing Cal-Eats APNs and FCM sending credentials are available for reuse. They have not been assigned to the manager project in this work. No new provider key, signed build, store upload or physical push test was performed.

These are credential/account prerequisites, not evidence that a push was delivered. Recheck provider status after the owner completes them.

## Android configuration

1. The separate Android application `info.calai.caleatsadmin` is already registered in the existing `cal-eats-notifications` project. Do not create a duplicate or change the customer app registration/messaging account.
2. From its manager app settings, obtain the generated `google-services.json` through the authorised owner console. It must contain only the manager Android client, the correct Firebase project and matching sender/app IDs. Do not copy the customer file, manufacture an unverified configuration or use a Google service-account private-key JSON as this file.
3. In the **manager Expo project**, create a preview-environment **file** variable named `CAL_EATS_ADMIN_GOOGLE_SERVICES_FILE` with the manager configuration. Use the existing provider account and existing messaging credentials. Do not place private keys in public Expo variables, source control or build archives.
4. Associate the existing Cal-Eats FCM v1 credential with the manager Android app credentials in EAS. This association does not replace customer credentials.
5. Run the checks below and build one chosen profile. `preview` produces an internal APK; `store-test` produces an AAB for the existing testing release process. An AAB cannot be installed directly like an APK.

`app.config.js` deliberately ignores the customer app's `CAL_EATS_GOOGLE_SERVICES_FILE` and `GOOGLE_SERVICES_JSON`. It rejects a mismatched Expo/native identity, a customer/mixed Firebase client file or a different Firebase sender. Android EAS workers fail before packaging if the manager file is absent. Local JavaScript work and iOS configuration can still run while Android registration is pending. Both test profiles use this manager project's `preview` environment.

## iOS and TestFlight

After Apple resolves the agreement, use the existing team and existing Cal-Eats APNs key. Register or verify the manager's own bundle ID with push capability, associate the existing APNs key with the manager Expo project and create a manager-specific provisioning profile using an existing valid distribution certificate where supported. Do not reuse the customer provisioning profile.

Verify/create the separate App Store Connect record for `info.calai.caleatsadmin` under the established approval process. Use `store-test` to build for real iPhones, then upload that manager build to its own TestFlight record. A simulator build is not installable through TestFlight. App Store Connect processing and tester eligibility must complete before an invitation/install link is usable.

From the repository root, after the credentials are configured:

```powershell
npm test --workspace=@cal-eats/admin-mobile
npm run typecheck --workspace=@cal-eats/admin-mobile
npm run store:check --workspace=@cal-eats/admin-mobile
```

From `apps/admin-mobile`, use the installed EAS CLI within the authorised existing plan:

```powershell
eas build --platform ios --profile store-test
# Choose Android APK OR store AAB as needed; do not start both automatically.
eas build --platform android --profile preview
```

These are operator instructions, not claims that builds or uploads have run. Do not select a public production profile, buy a plan or accept new legal terms as part of these commands.

## Backend sender activation and handset checks

Only after the manager provider credentials and signed build are ready, configure the approved manager project in Cal-Eats:

```text
CALAI_BUSINESS_PUSH_ENABLED=true
CALAI_BUSINESS_PUSH_IOS_PROJECT_IDS=6282b87e-36ae-43bb-80b7-12d69108a411
CALAI_BUSINESS_PUSH_ANDROID_PROJECT_IDS=6282b87e-36ae-43bb-80b7-12d69108a411
```

Keep a platform out of its allowlist until that platform is configured. The sender can reuse the existing private Cal-Eats Expo access token; do not copy it into this document or the app. Production setting changes follow the Cal-Eats release process. This work has not activated these settings.

Install the new native manager build, sign in to an authorised restaurant account and allow phone notifications from More. Confirm registration reports configured delivery, then test a truthful incident while backgrounded/locked. Verify the correct restaurant/device opens on tap; sign-out removes the installation's registration; denied push still leaves incident history visible. Verify an opening notification once per fault episode and recovery only after the configured healthy checks. Provider acceptance alone does not prove lock-screen presentation or that a person read an alert.

## Printer incident operation

An offline tablet means printer status is unavailable; do not infer an unplugged printer from a stale tablet report. If the tablet is online but the local printing service is not reporting, inspect the service on the tablet. If a supported driver reports a printer fault, check power, cable and the reported condition. Unsupported physical diagnostics remain unknown.

Orders remain visible independently of printing. For an uncertain print result, staff must check for an existing receipt and queue state on the enrolled tablet before intentionally reprinting. A deliberate duplicate must be labelled `REPRINT`. Never retry from the owner phone, and never infer physical receipt output solely from spooler submission or disappearance.
