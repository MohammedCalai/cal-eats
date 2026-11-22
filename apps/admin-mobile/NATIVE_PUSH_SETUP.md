# Manager app native notifications and installation

## Identity and isolation

The phone's display name is **Cal Eats Admin**. Use the existing `@yankee1707/cal-eats-admin` project, ID `6282b87e-36ae-43bb-80b7-12d69108a411`, and iOS/Android identifier `info.calai.caleatsadmin`. Do not initialise a replacement Expo project or reuse the customer app's `uk.co.calai.caleats` identity. The customer app and original Calai configuration are separate and remain unchanged.

The manager app registers its installation with the authenticated Cal-Eats backend. Device/printer incidents remain available in the app if notification permission is refused or push delivery is not configured. A read incident does not clear the underlying device fault. Phones remain unable to process or print orders; those actions require the enrolled ordering tablet.

## Confirmed provider status — 22 November 2026

Provider checks and the approved existing-key connection confirmed:

- The existing Yankee1707 Expo project uses its existing Android signing credentials. At 17:19 UTC, the existing Cal-Eats FCM v1 credential was associated with the manager Android credentials and verified. The customer project's credential association was identical before and after.
- The manager Android registration was created through the authorised Google owner console in the existing `cal-eats-notifications` project: sender `267285017965`, app ID `1:267285017965:android:806f06e062f0931dbb9664`, package `info.calai.caleatsadmin`. The official 1,164-byte SDK configuration was subsequently retrieved from Google's successful `GetAndroidAppConfig` download response and preserved unchanged in ignored `artifacts/admin-mobile-push/google-services.manager.official.json`. At 18:49 UTC, those exact bytes were uploaded only to the manager Expo project's preview file variable, `CAL_EATS_ADMIN_GOOGLE_SERVICES_FILE`, with `SECRET` visibility. No IAM expansion or replacement key was needed.
- The existing Cal-Eats App Store Connect API credential returns `403 FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED`, including for the existing customer bundle. Further console checks show the Developer Program licence was already accepted on 5 November 2026. The API issuer and actual certificate/profiles match the current Calai ltd team. App Store Connect instead lists Calai ltd's Free and Paid Apps agreements as **Pending (New Legal Entity)**. That is the relevant Apple-side transition to investigate; the generic API error is not proof that the user needs to accept the Developer Program licence again. No replacement key/team is justified by these checks.
- Exactly one signed internal Android preview APK completed at 18:57:54 UTC, using the existing included plan. Its identity, Firebase resources and signing checks are recorded below. No public store release or physical handset check was performed. Existing iOS manager builds remain simulator builds; manager iOS signing/push credentials and TestFlight installation remain outstanding. The existing Cal-Eats APNs credential is available for reuse after Apple's company transition; no new notification key was created.
- At 19:03 UTC, the deployed Cal-Eats runtime at schema 72 was verified with business push enabled for **only the manager Android project**. The iOS project allowlist is empty. Customer notification configuration remains separate.

Provider configuration and a signed APK do not prove handset installation, lock-screen delivery or that a person read an alert. Private setup and verification receipts are retained under ignored `artifacts/admin-mobile-push/`.

## Android configuration

1. **Completed:** `info.calai.caleatsadmin` is registered in the existing `cal-eats-notifications` project. Do not create a duplicate or change the customer registration/messaging account.
2. **Completed:** the official manager download is preserved unchanged. Google legitimately includes sibling application clients in this file. Configuration selects exactly one client matching the manager package, then requires its exact approved app ID, sender, project and API-key presence. Customer-only, duplicate-manager and mismatched registrations fail validation. The file was not manufactured from the customer configuration.
3. **Completed:** the manager project's preview **file** variable `CAL_EATS_ADMIN_GOOGLE_SERVICES_FILE` contains the official configuration with `SECRET` visibility. Keep provider private keys out of public Expo variables, source control and build archives.
4. **Completed:** the existing Cal-Eats FCM v1 credential is associated with the manager Android app credentials in EAS. The customer credentials remain unchanged. Do not create a replacement key.
5. **Completed:** one `preview` build produced the internal APK below. `store-test` would produce an AAB for the separate store-testing process; no additional build or store upload was started.

`app.config.js` deliberately ignores the customer app's `CAL_EATS_GOOGLE_SERVICES_FILE` and `GOOGLE_SERVICES_JSON`. It rejects a mismatched Expo/native identity, absent/duplicate manager client or different manager registration. Official sibling entries do not change the selected native identity. Android EAS workers fail before packaging if the manager file is absent. Both test profiles use this manager project's own `preview` environment.

## Verified internal Android build

- [Install/download Cal Eats Admin APK](https://expo.dev/artifacts/eas/Oc8YK7PucPImKvO7Q2aiMBTouHybFePsDcBVyycM13A.apk).
- [Expo build details](https://expo.dev/accounts/yankee1707/projects/cal-eats-admin/builds/c1123d05-2583-4017-8fc2-ac75a61e721f).
- Build `c1123d05-2583-4017-8fc2-ac75a61e721f`, reviewed source `a46d5a4210db815cca84dbc6bff4967c842cf063`, version **0.1.0 (2)**, distribution **INTERNAL**, profile **preview**. This is the manager app, not the customer app or a public Play release.
- Download returned HTTP 200. APK size: 76,991,179 bytes; SHA-256: `84ea524a22e8cd7b89533f079ba4b5c6fcfc958f99c4c02a56d5611b8071bac2`.
- Official Google `aapt2` inspection confirmed display name **Cal Eats Admin**, package `info.calai.caleatsadmin`, minimum Android SDK 24, target SDK 36 and a non-debuggable release. Notification/FCM permissions are present; microphone permission is absent.
- Compiled Firebase resources contain the approved manager app ID and sender. The customer Firebase app ID is absent from those resources. No API-key values were printed.
- Read-only APK v2 signature and protected-content digest checks passed; its certificate fingerprint matches the existing EAS manager keystore. An in-memory corrupted copy was rejected; the original APK was unchanged. This is artifact verification, not an Android OS installation test.
- Before the build, all 16 manager tests, native TypeScript checking and all 10 store-preflight checks passed with the actual official configuration. Remote Expo Doctor reported 19/21 checks, flagging duplicate installed React and newer SDK patch suggestions. The Android export/source map and actual packaged bundle contained React 19.2.3, matching its renderer; workspace React 19.2.6 was not bundled. These observations do not replace handset testing.
- The single Android build consumed **US$1 of included Starter credit**. At 19:01 UTC, usage was US$14 of US$45, with US$31 included credit remaining and **US$0 billed overage**. No new plan, signing key or notification key was purchased/created.

The private aggregate receipt is `artifacts/admin-mobile-push/android-internal-build-handoff.private.json`, alongside the downloaded APK and detailed configuration, manifest, signature and bundle receipts. All remain excluded from Git.

## iOS and TestFlight

After Apple resolves the pending company transition and the API becomes available, use the existing team and existing Cal-Eats APNs key. Register or verify the manager's own bundle ID with push capability, associate the existing APNs key with the manager Expo project and create a manager-specific provisioning profile using an existing valid distribution certificate where supported. Do not reuse the customer provisioning profile.

Verify/create the separate App Store Connect record for `info.calai.caleatsadmin` under the established approval process. Use `store-test` to build for real iPhones, then upload that manager build to its own TestFlight record. A simulator build is not installable through TestFlight. App Store Connect processing and tester eligibility must complete before an invitation/install link is usable.

For future changes, run the repository checks before requesting another build:

```powershell
npm test --workspace=@cal-eats/admin-mobile
npm run typecheck --workspace=@cal-eats/admin-mobile
npm run store:check --workspace=@cal-eats/admin-mobile
```

Future build commands run from `apps/admin-mobile` within the authorised existing plan. The iOS command remains blocked until Apple clears the company transition and manager signing is configured. Do not rerun Android merely to install the completed APK:

```powershell
eas build --platform ios --profile store-test
# Choose Android APK OR store AAB as needed; do not start both automatically.
eas build --platform android --profile preview
```

These are future operator instructions. Only the single internal Android build recorded above has run in this setup phase. No manager iOS device build, TestFlight upload or public production release has been completed.

## Backend sender activation and handset checks

The deployed runtime was verified at 19:03 UTC on 22 November with these business-push settings:

```text
CALAI_BUSINESS_PUSH_ENABLED=true
CALAI_BUSINESS_PUSH_IOS_PROJECT_IDS=
CALAI_BUSINESS_PUSH_ANDROID_PROJECT_IDS=6282b87e-36ae-43bb-80b7-12d69108a411
```

The runtime iOS allowlist is `[]`; Android contains only `6282b87e-36ae-43bb-80b7-12d69108a411`. The sender reuses the existing private Cal-Eats Expo connection. No token belongs in this document or the app. Keep iOS out of the allowlist until its own credentials and native build are ready. Production setting changes follow the Cal-Eats release process.

**Physical handset checks have not run.** Install the completed manager APK, sign in to an authorised restaurant account and allow phone notifications from More. Confirm registration reports configured delivery, then test a truthful incident while backgrounded/locked. Verify the correct restaurant/device opens on tap; sign-out removes the installation's registration; denied push still leaves incident history visible. Verify an opening notification once per fault episode and recovery only after the configured healthy checks. Also check sign-in, navigation, loading/error states and screen/keyboard spacing. Provider acceptance alone does not prove lock-screen presentation or that a person read an alert.

## Printer incident operation

An offline tablet means printer status is unavailable; do not infer an unplugged printer from a stale tablet report. If the tablet is online but the local printing service is not reporting, inspect the service on the tablet. If a supported driver reports a printer fault, check power, cable and the reported condition. Unsupported physical diagnostics remain unknown.

Orders remain visible independently of printing. For an uncertain print result, staff must check for an existing receipt and queue state on the enrolled tablet before intentionally reprinting. A deliberate duplicate must be labelled `REPRINT`. Never retry from the owner phone, and never infer physical receipt output solely from spooler submission or disappearance.
