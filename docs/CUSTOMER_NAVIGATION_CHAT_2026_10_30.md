# Customer navigation, chat and account — 30 October 2026

- Customer browser navigation is always fixed at the bottom, including wide screens, guests and the basket. Five labelled SVG icons have clear selected states. Basket checkout controls sit above the navigation. Native signed-in screens keep the same bottom navigation, with checkout departure guarded while payment is in progress.
- Customer notification reminders use a single foreground timer and stop immediately when the bell opens. Bell acknowledgement is separate from marking an update read. Bounded acknowledgement history prevents old filtered updates from ringing again. New updates arriving after acknowledgement remain eligible for a reminder. Browser playback requires a user gesture and pauses when hidden. Native playback uses the SDK-pinned Expo Audio module, respects silent mode and pauses in the background; microphone and background-audio permissions are disabled. No background push delivery is claimed.
- Messages now has searchable conversation rows, initials avatars, actual activity timestamps, unread filtering/badges and readable chat bubbles. The conversation composer remains separate from polling history, preserving drafts and retry keys. No presence, message previews or delivery/read receipts are invented.
- Account shows a profile overview, saved address cards and grouped settings/help/privacy. Address forms open only for Add/Edit and close after saving. Profile/address submissions guard duplicate and stale completion. Address removal uses an explicit confirmation. Existing support, preferences, data export, session and account-review functions remain available.

## Checks

- Seven targeted web checks passed, covering notification repetition, acknowledgement, missing-batch restoration, hidden-state suppression, identity cleanup, chat escaping, draft/retry behaviour and receipt helpers.
- Customer native TypeScript and store configuration checks passed. Packaging checked 130 JavaScript files and 24 required files. These are source/configuration checks, not signed builds or physical-device sound tests.
- Browser review at desktop width and 390 × 844 confirmed navigation anchored to the viewport bottom; basket checkout controls clear it. Tested saving an address, reopening its populated editor, dismissing reminders through the bell and sending a message in the isolated local fixture (email disabled, no background workers).
- Native source needs a new build for device verification. The previously observed pending Apple membership still prevents claiming a TestFlight release.

Unrelated README and audit-folder work was excluded from this change.
