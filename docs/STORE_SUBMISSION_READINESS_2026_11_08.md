# Store submission readiness — 8 November 2026

This is a checked release-preparation record, not store approval. Neither public store release has been submitted. Provider identity verification remains postponed at the owner's request; real customer payments are disabled. Android21's source is `edc261b87e5550470317c35fa5f2689cb320e5ed`; the subsequent `5365ef6` commit records rollout/device evidence. Store-form preparation can advance separately from this record: the last authenticated public-setup audit is stated below and must be reconciled with the operator's final form snapshot.

Current evidence-based [privacy/Data safety draft](store/PRIVACY_DATA_SAFETY_2026_11_08.json), [review-access/notes draft](store/REVIEW_ACCESS_DRAFT_2026_11_08.md) and [saved-state checkpoint](store/STORE_STATE_2026_11_08.json) are available for final review. They contain no review credentials and do not themselves save, publish or certify any answers.

## Apple

Authenticated App Store Connect and read-only API checks confirm version 1.0.0 is **Prepare for Submission**. Customer build 16 is selected, valid, not expired and App Store eligible. The approved Privacy Notice URL, description, support/marketing links, age questionnaire and one completed native 1206×2622 screenshot are present. iPad support is disabled. The declared non-exempt-encryption flag is false; do not call the encryption-document section a missing requirement merely because no document is uploaded.

Before public submission:

1. App Privacy now has a **saved, unpublished draft with17 data types**. The saved UI readback was compared with the declaration draft: all17 purpose groups and linked-to-user selections match, including Advertising Data. The operator reports all individual tracking answers saved as No. Final Publish confirmation is pending; a saved preview and available Publish button are not publication or store approval. The draft includes retained payment form/history, contact/account/message data, optional GPS and operational diagnostics. Intentional allergy collection is off; displaying merchant photos does not mean the customer app uploads customer photos. No implemented cross-property advertising matching was found; the recorded No-tracking rationale has specific reassessment triggers.
2. Supply a working, pre-verified **customer** review account, review contact name/phone/email and review notes. These fields are blank. Explain collection/service coverage, restaurant hours, signup verification, order messaging and notifications so reviewers can reach the features without access to the operator's inbox.
3. Make the truthful content-rights declaration and ensure menu/photo rights support it. This declaration is currently unset.
4. Set the app price and launch territories. Add Pricing and Set Up Availability remain. Review trader status if EU distribution is included, and the default untested Mac/Vision Pro availability.
5. Resolve and verify the remaining objectionable-content filtering/review scope in merchant/customer messaging and published merchant content. Native reporting, contact blocking and platform support are in selected iOS16. Focused server-side text screening is being prepared separately from this audit; do not describe a local patch as already deployed, or represent a limited English text screen as complete image/multilingual moderation. Preserve support reporting and specifically reported evidence.
6. Verify final screenshots against all actually required slots and final runtime content. The completed medium-size screenshot has an accepted current dimension; more screenshot coverage is useful but there is no automatic requirement for ten images. Check the exact submitted build on physical devices, including privacy/deletion, verification and advertised notifications/Live Activities.
7. Complete the actual restaurant's live payment onboarding, commercial acceptance and controlled paid-order checks. Keep a working backend and real reviewed menu/hours available during review; do not disguise testing checkout as a final production service.

In-app account deletion is implemented, including identity/password confirmation, staff review, an explained completion period and erasure/completion notification. Apple's current guidance permits manual completion; staff review alone does not require a redesign to instant automatic deletion.

## Google Play

The latest authenticated release evidence confirms **1.0.0 (21)** is available to internal testers, release9/full rollout on 8 November at17:01 UTC. Source: `edc261b87e5550470317c35fa5f2689cb320e5ed`; build87b37cf0-472e-4da5-92fe-edc79037739a; signed AAB SHA-256 `a5784529b2c16c8796323eb2f545c1c88e50489f7d9a682c60f31f7bc8c3d244`. Production, open testing and closed testing were inactive at the authenticated public-setup audit. The public application was a draft with **0 of11 setup tasks completed**. Routine form edits may advance that count; capture the final Console state rather than treating this earlier count as a new read. Internal-test availability is not public review or approval.

The operator subsequently saved the approved privacy URL, government-app No, health-feature No, Contains ads No, incentives-only Financial features, Food & Drink category, `support@calai.info` and `https://eats.calai.info`. Data safety is being edited, including transmitted in-app search terms; it is not yet recorded here as saved/submitted. Target-audience completion is waiting for reviewer access. Content rating, reviewer access, listing and final public-review status still require their own saved-state verification. Do not continue presenting the earlier0/11 count as the current total or infer a new total from individual saves. The declaration draft distinguishes ordinary restaurant discounts from sponsored advertising, and physical-food checkout from banking/digital-wallet services.

Android21 targets API36 and its checked binary compatibility/signature evidence is recorded with the release. It includes native report/block, blocks the unused overlay/shared-storage permissions, and includes the corrected quiet-notification channel and permission-education flow. This supersedes build19's older feature/permission state. The previous build20 error used Android's raw importance4 where Expo's translated enum4 means LOW;21 uses the installed Expo HIGH enum and an explicitly negotiated versioned quiet channel. Existing low channels migrate only after an affirmative user action; disabled/edited phone choices are preserved.

The user confirmed the Android permission prompt and visible support-notification pop-up on a Samsung Galaxy S10 after updating and enabling quiet updates. Transport receipt and account/channel registration were also verified. This is evidence for that device/test, not a universal guarantee about Android vendors, lock-screen settings, delivery latency or app performance. Native startup/frame/memory performance and the complete final production ordering journey remain separate checks. iOS16 is still the older selected Apple binary; Android21 evidence does not update that binary.

Google also requires a public resource for account and associated-data deletion. `/account-deletion/`, linked from Support, provides the in-app path and email alternative, verification/timing/retention details, and immutable approved-policy links. The page does not change the approved Privacy Notice, send email, or grant inbox access. Use `https://eats.calai.info/account-deletion/` in the Play form after checking the public HTTP page. Legal documents remain pinned to approved2026-11-08-v1.

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
