# Store submission readiness — 8 November 2026

This is a checked release-preparation record, not store approval. Neither public store release has been submitted. Provider identity verification remains postponed at the owner's request; real customer payments are disabled. No store declarations, legal agreements, review passwords, pricing or country selections were changed during this audit.

## Apple

Authenticated App Store Connect and read-only API checks confirm version 1.0.0 is **Prepare for Submission**. Customer build 16 is selected, valid, not expired and App Store eligible. The approved Privacy Notice URL, description, support/marketing links, age questionnaire and one completed native 1206×2622 screenshot are present. iPad support is disabled. The declared non-exempt-encryption flag is false; do not call the encryption-document section a missing requirement merely because no document is uploaded.

Before public submission:

1. Complete and publish accurate App Privacy answers against the actual app, processors and partner data uses. The privacy screen still shows Get Started. A Privacy Notice URL does not complete this separate questionnaire.
2. Supply a working, pre-verified **customer** review account, review contact name/phone/email and review notes. These fields are blank. Explain collection/service coverage, restaurant hours, signup verification, order messaging and notifications so reviewers can reach the features without access to the operator's inbox.
3. Make the truthful content-rights declaration and ensure menu/photo rights support it. This declaration is currently unset.
4. Set the app price and launch territories. Add Pricing and Set Up Availability remain. Review trader status if EU distribution is included, and the default untested Mac/Vision Pro availability.
5. Resolve the remaining objectionable-content filtering gap in merchant/customer messaging and published merchant content. Native reporting, contact blocking and platform support exist; trimming, length checks and valid-image checks alone are not content filtering. Define the filtering/review policy without quietly weakening report/block behavior.
6. Verify final screenshots against all actually required slots and final runtime content. The completed medium-size screenshot has an accepted current dimension; more screenshot coverage is useful but there is no automatic requirement for ten images. Check the exact submitted build on physical devices, including privacy/deletion, verification and advertised notifications/Live Activities.
7. Complete the actual restaurant's live payment onboarding, commercial acceptance and controlled paid-order checks. Keep a working backend and real reviewed menu/hours available during review; do not disguise testing checkout as a final production service.

In-app account deletion is implemented, including identity/password confirmation, staff review, an explained completion period and erasure/completion notification. Apple's current guidance permits manual completion; staff review alone does not require a redesign to instant automatic deletion.

## Google Play

The authenticated Console confirms **1.0.0 (19) — Email verification** is available to internal testers, full rollout, last updated 8 November 01:12. Production, open testing and closed testing are inactive. The public application is a draft and its initial setup dashboard lists **0 of 11 tasks completed**. Internal-test availability is not public review or approval.

All eleven displayed public setup tasks still need truthful completion: privacy policy; reviewer sign-in; ads; content rating; target audience; Data safety; government apps; financial features; health; category/contact details; store listing.

The signed existing bundle targets API 36 and its inspected64-bit ELF libraries meet16 KB segment alignment. Final generated-APK/device checks remain separate. Build 19 predates the native report/block controls in current source. Its merged manifest also contains unused overlay/shared-storage permissions. Current source now blocks those three permissions; that change and current moderation controls require a **new signed Android build**, compiled-manifest inspection and device checks before public review. No new build or upload was made during this audit.

Google also requires a public resource for account and associated-data deletion. This change adds `/account-deletion/`, linked from Support, with an in-app path and email alternative, verification/timing/retention details, and immutable approved-policy links. The page does not change the approved Privacy Notice, send email, or grant inbox access. The next Play Data safety form can use the published URL after deployment verification.

## Capacity is separate from store eligibility

See [directory capacity](RESTAURANT_DIRECTORY_CAPACITY.md) and the current order-load report when available. A local concurrency result does not prove hosted payment-provider latency, native rendering, push delivery, hardware printing or capacity for10,000 simultaneously trading restaurants. Public review still needs a complete, reliably usable app even while wider infrastructure scaling remains staged.

## Primary guidance checked

- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) — content moderation and app completeness.
- [Apple complete-review information](https://developer.apple.com/help/app-review/before-submitting-for-review/complete-review).
- [Apple account deletion](https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion).
- [Apple screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications).
- [Google target API requirements](https://support.google.com/googleplay/android-developer/answer/11926878).
- [Google account-deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111).
- [Google Data safety](https://support.google.com/googleplay/android-developer/answer/10787469).
- [Google reviewer app-access instructions](https://support.google.com/googleplay/android-developer/answer/15748846).
- [Expo merged Android permissions](https://docs.expo.dev/guides/permissions/).
