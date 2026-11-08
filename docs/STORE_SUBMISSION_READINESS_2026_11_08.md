# Store submission readiness — 8 November 2026

This is a checked release-preparation record, not store approval. Neither public store release has been submitted. Provider identity verification remains postponed at the owner's request; real customer payments are disabled. Android21's source is `edc261b87e5550470317c35fa5f2689cb320e5ed`; the subsequent `5365ef6` commit records rollout/device evidence. Store-form preparation can advance separately from this record: the last authenticated public-setup audit is stated below and must be reconciled with the operator's final form snapshot.

The latest coordinator-reported source/hosting checkpoint is Git main `83a67be`, Railway deployment `b4da9a37` **SUCCESS**. This does not activate live payments. The new iOS17 build from that source is finished and its IPA verified; TestFlight submission is in progress, with upload/processing/selection still requiring completion checks.

Current evidence-based [privacy/Data safety draft](store/PRIVACY_DATA_SAFETY_2026_11_08.json), [review-access/notes draft](store/REVIEW_ACCESS_DRAFT_2026_11_08.md) and [saved-state checkpoint](store/STORE_STATE_2026_11_08.json) are available for final review. They contain no review credentials and do not themselves save, publish or certify any answers.

## Apple

Authenticated App Store Connect and read-only API checks confirm version 1.0.0 is **Prepare for Submission**. Customer build 16 is selected, valid, not expired and App Store eligible. The approved Privacy Notice URL, description, support/marketing links, age questionnaire and one completed native 1206×2622 screenshot are present. iPad support is disabled. The declared non-exempt-encryption flag is false; do not call the encryption-document section a missing requirement merely because no document is uploaded.

Subtitle **“Local food, offers & updates”** is saved. Mac and Vision Pro availability are **disabled**, verified by both checkboxes remaining unchecked after saved-page reload. A **free GBP0 price schedule with United Kingdom as base** is saved: Next/Confirm succeeded, Price Schedule is present and Add Pricing is no longer shown. Availability is saved to **one country, United Kingdom**, explicitly **Available on App Release**; it is not a public release. EAS iOS17 build `06b7fed2-5d05-4dbf-bca9-f5c15d32100e` finished using the existing free allowance and source `83a67be`; its IPA is verified and TestFlight submission is in progress. Build16 remains the last confirmed selected public-review build until a later verified upload/selection.

Before public submission:

1. App Privacy now has a **saved, unpublished draft with17 data types**. The saved UI readback was compared with the declaration draft: all17 purpose groups and linked-to-user selections match, including Advertising Data. The operator reports all individual tracking answers saved as No. Final Publish confirmation is pending; a saved preview and available Publish button are not publication or store approval. The draft includes retained payment form/history, contact/account/message data, optional GPS and operational diagnostics. Intentional allergy collection is off; displaying merchant photos does not mean the customer app uploads customer photos. No implemented cross-property advertising matching was found; the recorded No-tracking rationale has specific reassessment triggers.
2. A dedicated **customer** review account has now been created through the ordinary API and email-verified. Its credentials are stored privately and have not been entered in either store. Review contact fields and notes still need final entry. A verified login alone is not full-feature review access while paid ordering is paused; explain genuine service coverage, restaurant hours and the working checkout only after those prerequisites are available.
3. Make the truthful content-rights declaration and ensure menu/photo rights support it. This declaration is currently unset.
4. Pricing and initial territories are now saved and verified: **free, United Kingdom only**, available on app release. Mac/Vision Pro are disabled after saved reload. If territories later expand to the EU or other markets, recheck applicable trader information and distribution requirements; this UK-only setup does not pre-certify wider availability.
5. Focused server-side text screening, the exact erasure-conflict mapping and fail-closed release-preflight changes are in the new source/hosting checkpoint. Native reporting, contact blocking and platform support remain available. Verify the operational moderation/review process for merchant content: a limited English text screen is not complete image/multilingual moderation. Support reporting and specifically reported evidence remain available.
6. Verify final screenshots against all actually required slots and final runtime content. The completed medium-size screenshot has an accepted current dimension; more screenshot coverage is useful but there is no automatic requirement for ten images. Check the exact submitted build on physical devices, including privacy/deletion, verification and advertised notifications/Live Activities.
7. Complete the actual restaurant's live payment onboarding, commercial acceptance and controlled paid-order checks. Keep a working backend and real reviewed menu/hours available during review; do not disguise testing checkout as a final production service.

In-app account deletion is implemented, including identity/password confirmation, staff review, an explained completion period and erasure/completion notification. Apple's current guidance permits manual completion; staff review alone does not require a redesign to instant automatic deletion.

## Google Play

The latest authenticated release evidence confirms **1.0.0 (21)** is available to internal testers, release9/full rollout on 8 November at17:01 UTC. Source: `edc261b87e5550470317c35fa5f2689cb320e5ed`; build87b37cf0-472e-4da5-92fe-edc79037739a; signed AAB SHA-256 `a5784529b2c16c8796323eb2f545c1c88e50489f7d9a682c60f31f7bc8c3d244`. Production, open testing and closed testing were inactive at the authenticated public-setup audit. The public application was a draft with **0 of11 setup tasks completed**. Routine form edits may advance that count; capture the final Console state rather than treating this earlier count as a new read. Internal-test availability is not public review or approval.

The operator saved the approved privacy URL, government-app No, health-feature No, Contains ads No, incentives-only Financial features, Food & Drink category, `support@calai.info` and `https://eats.calai.info`. **Data safety's16 types and handling are fully entered and saved as a draft**, with Changes saved confirmed. That includes optional transmitted in-app search history, conservative non-ephemeral answers, precise GPS sharing for App functionality, and the appropriate service-provider/user-initiated exceptions for the other transfers. This draft cannot be marked complete/submitted until Target audience is available, which in turn requires App access.

An App access full-feature certification was **discarded without saving**: a customer login cannot honestly certify full access while paid ordering is paused. The verified reviewer account exists privately but has not been entered in Play or Apple. Target audience therefore remains blocked. The Play short/full descriptions, app icon **1/1** and feature graphic **1/1** are saved as a listing draft, with **Your changes have been saved** confirmed. The only remaining listing assets are the minimum **two genuine Android screenshots**. Content rating, final listing validation, other prerequisites and public-review submission remain separate. Do not present the earlier0/11 count as the current total or infer a new total from individual saves.

Android21 targets API36 and its checked binary compatibility/signature evidence is recorded with the release. It includes native report/block, blocks the unused overlay/shared-storage permissions, and includes the corrected quiet-notification channel and permission-education flow. This supersedes build19's older feature/permission state. The previous build20 error used Android's raw importance4 where Expo's translated enum4 means LOW;21 uses the installed Expo HIGH enum and an explicitly negotiated versioned quiet channel. Existing low channels migrate only after an affirmative user action; disabled/edited phone choices are preserved.

The user confirmed the Android permission prompt and visible support-notification pop-up on a Samsung Galaxy S10 after updating and enabling quiet updates. Transport receipt and account/channel registration were also verified. This is evidence for that device/test, not a universal guarantee about Android vendors, lock-screen settings, delivery latency or app performance. Native startup/frame/memory performance and the complete final production ordering journey remain separate checks. iOS16 is still the older selected Apple binary; Android21 evidence does not update that binary.

Google also requires a public resource for account and associated-data deletion. `/account-deletion/`, linked from Support, provides the in-app path, an email alternative, and a separate way to request deletion of specific personal data while keeping the account. Its deployment was verified HTTP200. The same URL is entered for account and specific-data deletion in the Data safety draft. The page explains verification/timing/retention and does not change the immutable approved2026-11-08-v1 policy documents, send email or grant inbox access.

Final Apple privacy publication and the proposed disposable-account deletion verification still await the user's answers. Neither pending action is recorded as completed.

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

## Final preparation checkpoint

Apple has processed customer1.0.0(17) from source`83a67be` as VALID and IN_BETA_TESTING for the existing internal group. The signed IPA, profiles, production push entitlement and nested Live Activity widget were checked; this is not physical-device testing or public App Store review. Public review still has build16 selected.

Google’s authenticated Dashboard now shows **6 of11 initial setup tasks complete**. Privacy, ads, government, financial incentives, health, and category/contact answers are saved. Data safety’s16 data types and their handling are saved as a draft; its completion depends on target audience and working reviewer access. Listing text, the accepted512px icon and1024×500 feature artwork are saved drafts; at least two genuine Android screenshots remain required.

The administrator can remove a restaurant cover through the scoped, audited workspace, with confirmation and cross-restaurant media checks. Focused API checks and the portal build passed. No live restaurant image was removed.

Normal live recovery and verification succeeded for a disposable customer through the actual API and delivery worker. Inbox receipt and the physical reset page are separate checks. A password-confirmed deletion request has an eligible/no-blocker preview; permanent completion awaits the specific operator confirmation. The separate reviewer customer is verified and stored privately, but no full-access declaration has been made while ordering is paused.

Apple privacy publication and disposable-account deletion confirmations are still pending. Real provider/restaurant onboarding, paid-order/commission/payout checks, final reviewer/contact/content-rights details and exact-device evidence remain release requirements. No public store submission has been sent.
