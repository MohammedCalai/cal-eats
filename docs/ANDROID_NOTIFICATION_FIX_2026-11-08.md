# Android quiet pop-ups and permission setup

## Device finding

On a Samsung Galaxy S10 running Cal-Eats 1.0.0 (20), the test support notification reached the notification shade and tapping it opened the correct conversation. The user did not see the expected lock-screen pop-up. Delivery and routing were therefore confirmed, while visual pop-up acceptance failed.

Android20 used the raw Android HIGH value `4` when calling Expo's notification API. In the installed Expo SDK57, `AndroidImportance.LOW` is `4` and `HIGH` is `6`; Expo translates its enum to Android's native values. The old logic tests repeated the same numeric assumption, so they failed to expose this mistake. The correction supplies `Notifications.AndroidImportance` directly and tests against the installed SDK enum.

## Correction and compatibility

- New quiet notification settings use the SDK's HIGH value, with no sound or vibration. They do not override device privacy settings or Do Not Disturb.
- Android does not let an app raise an existing notification channel's importance. The corrected app uses `cal-eats-updates-quiet-v2` and registers its supported channel per device.
- Additive database migration58 stores the allowlisted `android_channel_id`. Older clients continue using the original quiet channel; the server never sends a new channel ID to an old client that has not registered it.
- Changing the effective channel increments the device generation and invalidates stale pending/claimed dispatches. Legacy encrypted registrations remain readable; new registrations bind the channel in authenticated encryption metadata.
- An existing quiet LOW channel is retained until the user explicitly chooses to enable quiet pop-ups. Disabled, audible or other user-modified categories are not silently replaced. A working existing HIGH quiet category remains supported.

## Customer permission prompt

After sign-in, customers receive a clear **Allow notifications** explanation and action. Permission requests follow that affirmative action. If permissions or a category are blocked, the action opens the phone's notification settings instead. Customers can choose **Not now**, close the prompt, and return through Account later; ordering is not gated on notification permission.

The prompt is remembered per customer on that installation. It waits until sign-in, verification welcome messages, checkout, conversations and keyboard interaction have finished. It remains open if setup fails or permission stays blocked, and does not equate a completed settings call with permission being granted. Alerts remain silent, and marketing consent is unchanged.

Samsung's separate lock-screen/brief-pop-up choices still govern screen-off presentation. See [Samsung's notification pop-up guidance](https://www.samsung.com/us/support/answer/ANS10003383/) and [Android notification-channel guidance](https://developer.android.com/develop/ui/views/notifications/channels). These settings must not be described as something the app can force-enable.

## Validation

Targeted backend integration checks cover mixed legacy/new devices, invalid channels, platform mismatch, generation/idempotency and upgrade races. Mobile checks cover the actual SDK enum, channel-choice preservation, account isolation and permission-prompt state. Final signed-package inspection and a repeat Galaxy S10 pop-up test are required before recording the corrected behavior as physically verified.

The previous native-client order-load results remain separate and unchanged. No order/payment logic, bank setup, marketing consent or business notification sound changed in this correction.

## Internal testing release

Android **1.0.0 (21)**, built from `edc261b87e5550470317c35fa5f2689cb320e5ed`, was confirmed available on Google Play internal release9 on 8 November 2026 at 17:01 UTC. The [existing tester link](https://play.google.com/apps/internaltest/4700960164758478673) serves the update as Google propagates it. The customer should open the app and choose **Allow notifications** before the repeat quiet-pop-up test.

Validation passed: **61 mobile logic checks**, **10 targeted API integration checks**, Android Hermes export, exact package/version/signature inspection and the compiled quiet-v2 configuration. All 34 native 64-bit libraries passed 16KB alignment checks; the package targets API36 with minimum API24. The signed AAB SHA-256 is `a5784529b2c16c8796323eb2f545c1c88e50489f7d9a682c60f31f7bc8c3d244`.

The hosted service is healthy on migration58, and an existing legacy encrypted Android registration remained readable after the additive migration. This is backward-compatibility evidence, not new-device delivery proof. The Android21 prompt and Galaxy S10 pop-up retest remain pending the customer's update and affirmative setup action.
