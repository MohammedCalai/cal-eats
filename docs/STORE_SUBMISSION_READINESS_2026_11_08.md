# Store submission readiness — 8 November 2026

Cal-Eats is available for internal testing. Neither public store release has been submitted or approved. Real customer charging remains paused until the genuine restaurant and payment checks are complete.

## Current releases and store state

| Surface | Verified result | Remaining preparation |
| --- | --- | --- |
| Apple TestFlight | Customer 1.0.0 (17), source 83a67be, is VALID and IN_BETA_TESTING in the existing internal group. | Check this exact build on an iPhone, including the full ordering journey and Live Activity completion. |
| Apple public version | 1.0.0 remains Prepare for Submission; build 16 is still selected for public review. | Use the final checked binary, publish the prepared App Privacy responses after operator confirmation, and finish review details/content rights. |
| Google Play | Android 1.0.0 (21), source edc261b, is available to internal testers. The public Dashboard shows 6 of 11 initial setup tasks complete. | Review access, target audience, content rating, final Data safety and listing completion. |
| Hosting | Application code a774283 deployed successfully; database and migration readiness returned HTTP 200. | Keep the backend and restaurant service available during review; no payment activation is implied. |

The signed iPhone package, both store profiles, production push entitlement, nested Live Activity widget and code/resource hashes were checked. Windows signature inspection is not Apple trust/revocation or physical-device testing. TestFlight availability is separate from public App Store review.

Android 21 targets API 36. Its checked binary has the expected Cal-Eats identifiers, signature, notification configuration, permissions and 16 KB native-library segment alignment. Generated-APK/device rendering and production traffic are separate checks. The user confirmed clear navigation on Android 20 and the notification-permission prompt and visible silent pop-up on Android 21 on a Samsung Galaxy S10. This is device-specific evidence, not a universal Android delivery or performance guarantee.

## Saved store preparation

Apple has a saved free download price, United Kingdom as the base country, and United Kingdom-only availability on app release. The saved Current Price table shows GBP 0.00. Mac and Vision Pro availability are disabled after saved-page readback; iPad support is disabled. The subtitle is “Local food, offers & updates”. The approved privacy URL, description, support/marketing links, age questionnaire and one completed native 1206×2622 screenshot are present. The non-exempt-encryption flag is false; no missing encryption document is inferred merely from an empty upload section.

Apple App Privacy has 17 saved data types, with the reviewed purposes and user linkage. Individual tracking answers were saved as No against the implemented data flows. Final publication remains subject to the operator's specific confirmation of Apple's accuracy/update declaration. This does not release the app. See the [privacy and Data safety answers](store/PRIVACY_DATA_SAFETY_2026_11_08.json) and [saved-state record](store/STORE_STATE_2026_11_08.json).

Google's six completed setup tasks are privacy policy, ads, government apps, financial features, health, and category/contact details. The saved answers describe a private food marketplace, no health service, no ad placement product, and the actual restaurant/voucher incentives. Food & Drink, support@calai.info and https://eats.calai.info are saved. Marketplace discounts alone were not treated as an advertising-network product.

Google Data safety has all 16 selected data types and their handling entered and saved as a draft. It includes transmitted in-app searches, conservative non-ephemeral handling, precise GPS sharing for app functionality, encrypted transport and the actual deletion routes. Completing it requires Target audience, which requires working review access. It has not been submitted for review.

The Google short/full descriptions, accepted 512px icon and 1024×500 feature artwork are saved as a listing draft. At least two genuine Android screenshots remain required. Console screenshots and iOS captures must not be relabelled as Android app screenshots.

## Application and operational checks completed

- Added bounded English screening for clearly abusive/threatening/sexual requests in new peer messages and published merchant text. Rejected content is not saved or sent. Private safety/support evidence remains reportable. Eighteen focused safety/messaging/marketing checks passed.
- Added audited administrator cover-photo removal with confirmation and cross-restaurant media protection. Six focused checks and the portal build passed. No live restaurant image was removed during these checks.
- Corrected delayed requests after account erasure to return a clear account-deleted conflict while preserving the database suppression. The release checker now rejects missing, unknown or malformed approval gates. Sixteen focused auth/privacy/readiness checks passed.
- Verified normal signup/email verification and password recovery through the hosted API and delivery worker, including reset-token replay protection and revoked old access. Inbox receipt and physical-device reset-link use are separate evidence.
- Prepared a separate, enabled, email-verified customer review account through the ordinary signup flow. Privileged endpoints deny that account. Credentials remain private and are not in either store, source, screenshots or these documents.

Account deletion is implemented as password/identity-confirmed intake, staff review and actual erasure/login revocation with explained retention exceptions. The approved disposable customer was permanently erased on 8 November. Browser/native sessions and fresh logins reject access, recovery records are gone, and one normal completion email was sent; inbox receipt is unverified. The authorised maintenance workflow used the normal domain planner and transaction, with admin, policy, blocker and preview-hash checks. This is not an observed live admin HTTP/UI test. Other main/admin/business/reviewer profiles remained unchanged. A support-reviewed process does not require redesigning this as instant automatic deletion.

The public [deletion page](https://eats.calai.info/account-deletion/) provides in-app and email routes, including a specific-data request that keeps the account. Deployment returned HTTP 200. Approved immutable Terms/Privacy remain published; the extra help text does not rewrite them.

## Required before public submission

1. Complete genuine provider verification, Arndale bank onboarding and merchant commercial acceptance. Validate a controlled real paid order, the 7% calculation after restaurant discounts including delivery, commission-free periods, and weekly payout/reconciliation. Do not submit disabled checkout as a working production service.
2. Provide full reviewer access to a usable restaurant/menu/ordering journey without inbox or expiring-code dependencies. The Google full-access checkbox was deliberately left unsaved while ordering is paused. Finish the operator's review contact name/phone/email and accurate location/hours instructions.
3. Confirm menu/photo permissions and make the truthful content-rights declaration. Complete the remaining content-rating/target-audience questions and final listing/privacy submission checks. Adults 18+ is the intended audience; it is not a substitute for answering actual content questions.
4. Capture the required genuine Android screenshots and check the final native binaries on phones. Include checkout return, receipt, verification/deletion UI, messages, notification destinations and Live Activity background/terminal behavior. Previously successful web/API checks do not establish those device results.
5. Review remaining test credentials and name the primary/backup people monitoring customer safety reports and support. The [content safety operations note](store/CONTENT_SAFETY_OPERATIONS.md) describes actual image-removal/report controls and filtering limits; it does not claim automatic image or all-language moderation.
6. Reconcile the fixed release gates with evidence and explicit public-release approval. A passed build or privacy form must not turn every gate true. Existing internal testing remains separate from production release.

The [review access draft](store/REVIEW_ACCESS_DRAFT_2026_11_08.md) contains no credentials and must be finalised against the enabled service. UK-only pricing/availability does not pre-certify wider distribution or EU trader information.

## Capacity and evidence limits

See [directory capacity](RESTAURANT_DIRECTORY_CAPACITY.md), [local order capacity](ORDER_CAPACITY_VALIDATION_2026-11-08.md) and [native-client local validation](ANDROID_LOCAL_VALIDATION_2026-11-08.md). Synthetic load results do not certify hosted payment latency, native rendering, push delivery, printing or 10,000 simultaneously trading restaurants. No broad load suite was repeated for these bounded safety/preparation changes.

## Primary guidance

- [Apple review guidelines](https://developer.apple.com/app-store/review/guidelines/), [complete review information](https://developer.apple.com/help/app-review/before-submitting-for-review/complete-review), [account deletion](https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion), [privacy details](https://developer.apple.com/app-store/app-privacy-details/) and [screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications).
- [Google Data safety](https://support.google.com/googleplay/android-developer/answer/10787469), [account deletion](https://support.google.com/googleplay/android-developer/answer/13327111), [reviewer access](https://support.google.com/googleplay/android-developer/answer/15748846) and [target API requirements](https://support.google.com/googleplay/android-developer/answer/11926878).
