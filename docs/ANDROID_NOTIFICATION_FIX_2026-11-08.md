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
