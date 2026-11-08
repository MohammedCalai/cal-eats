# Store submission readiness — 8 November 2026

Cal-Eats is available for internal testing. Neither public store release has been submitted or approved. Real customer charging remains paused until the genuine restaurant and payment checks are complete.

## Current releases and store state

| Surface | Verified result | Remaining preparation |
| --- | --- | --- |
| Apple TestFlight | Customer 1.0.0 (17), source 83a67be, is VALID and IN_BETA_TESTING in the existing internal group. | Check this exact build on an iPhone, including the full ordering journey and Live Activity completion. It does not contain the later native guest-safety correction. |
| Apple public version | 1.0.0 remains Prepare for Submission; build 17 is now saved as the selected review candidate. Manual release is selected. | Complete exact-build device checks, publish the prepared App Privacy responses after operator confirmation, and finish review details/content rights. |
| Google Play | Android 1.0.0 (22), source 354a593, is available to internal testers as release 10, confirmed 8 November at 20:35. Its review status is Not reviewed. The public Dashboard shows 7 of 11 initial setup tasks complete. | Finish usable review access, target audience, content rating and final Data safety; internal availability is not public submission or approval. |
| Hosting | Application source 354a593 is running in Railway deployment d49e0aff-00fc-443e-b983-f03425d3ee79, status SUCCESS. | Keep the backend and restaurant service available during review; no payment activation or native-binary update is implied. |

The signed iPhone package, both store profiles, production push entitlement, nested Live Activity widget and code/resource hashes were checked. Windows signature inspection is not Apple trust/revocation or physical-device testing. TestFlight availability is separate from public App Store review.

The current Expo free iOS build allowance is exhausted at 15 of 15. No paid iOS build is authorised. iOS 17 does not include the guest-safety fix from source 354a593; backend deployment cannot add that native change to the existing app. A later AuthScreen explanation about saving addresses and following orders was corrected after Android 22's source was frozen, so that copy change is in neither Android 22 nor iOS 17.

Android 22 was built by EAS job `0aa67c71-41af-4379-930e-49f37c5c0934` from `354a593714e10a1dad9cfb52d4c4df5780df21c7`; its locally verified AAB SHA-256 is `a8fe3e7d6037b010b02cf29f46b757874e5b6250d98286d014b83eb14df9c69b`. An unchanged AAB-derived app ran in the dedicated Android API 36 emulator: guest menu opening, local basket and the sign-in/return-to-browsing route passed without entering credentials, creating an order or making a payment. The derived APK uses a local testing certificate, rather than Play's signing certificate. This is bounded emulator evidence; physical-device push, paid ordering and payout UAT remain separate.

The exact internal-track readback confirmed build 22 available through the [existing internal tester link](https://play.google.com/apps/internaltest/4700960164758478673). Google reported zero device-compatibility changes and one warning that no R8 deobfuscation file was supplied. That warning was accepted for this internal release; final public crash-symbol/deobfuscation review remains pending. No public review submission was made.

Android 21's checked binary has the expected Cal-Eats identifiers, signature, notification configuration, permissions and 16 KB native-library segment alignment. The user confirmed clear navigation on Android 20 and the notification-permission prompt and visible silent pop-up on Android 21 on a Samsung Galaxy S10. Those earlier device reports are not automatically evidence for Android 22 or a universal Android delivery/performance guarantee.

## Saved store preparation

Apple has a saved free download price, United Kingdom as the base country, and United Kingdom-only availability on app release. The saved Current Price table shows GBP 0.00. Mac and Vision Pro availability are disabled after saved-page readback; iPad support is disabled. The subtitle is “Local food, offers & updates”. The approved privacy URL, description, support/marketing links, age questionnaire and one completed native 1206×2622 screenshot are present. The non-exempt-encryption flag is false; no missing encryption document is inferred merely from an empty upload section.

Apple App Privacy has 17 saved data types, with the reviewed purposes and user linkage. Individual tracking answers were saved as No against the implemented data flows. Final publication remains subject to the operator's specific confirmation of Apple's accuracy/update declaration. This does not release the app. See the [privacy and Data safety answers](store/PRIVACY_DATA_SAFETY_2026_11_08.json) and [saved-state record](store/STORE_STATE_2026_11_08.json).

Google's seven completed setup tasks are privacy policy, ads, government apps, financial features, health, category/contact details and the main store listing. The saved answers describe a private food marketplace, no health service, no ad placement product, and the actual restaurant/voucher incentives. Food & Drink, support@calai.info and https://eats.calai.info are saved. Marketplace discounts alone were not treated as an advertising-network product.

Google Data safety has all 16 selected data types and their handling entered and saved as a draft. It includes transmitted in-app searches, conservative non-ephemeral handling, precise GPS sharing for app functionality, encrypted transport and the actual deletion routes. Completing it requires Target audience, which requires working review access. It has not been submitted for review.

The Google main store listing is saved and marked “Ready to send for review”, with short/full descriptions, the accepted 512px icon, 1024×500 feature artwork and three genuine Android 22 RGB 1080×1920 screenshots. [The captures and provenance record](store/screenshots/android22/provenance.json) cover Browse, menu and a local basket. No crop, resize, composition or retouching was applied; original pixels were retained, with only a proven opaque alpha plane removed for lossless RGB export. All five uploaded visuals are labelled as containing AI-generated content because the branding/illustrative food assets contain generated material; this does not mean the native screenshot states were fabricated or retouched. A validated listing draft is not a public app submission or approval.

Google's content-rating form has the consumer-app category and public rating contact prepared. It requires IARC Terms of Use acceptance before the questionnaire can proceed; the specific operator approval is pending. No rating or completed questionnaire is claimed.

## Application and operational checks completed

- Added bounded English screening for clearly abusive/threatening/sexual requests in new peer messages and published merchant text. Rejected content is not saved or sent. Private safety/support evidence remains reportable. Eighteen focused safety/messaging/marketing checks passed.
- Added audited administrator cover-photo removal with confirmation and cross-restaurant media protection. Six focused checks and the portal build passed. No live restaurant image was removed during these checks.
- Corrected delayed requests after account erasure to return a clear account-deleted conflict while preserving the database suppression. The release checker now rejects missing, unknown or malformed approval gates. Sixteen focused auth/privacy/readiness checks passed.
- Verified normal signup/email verification and password recovery through the hosted API and delivery worker, including reset-token replay protection and revoked old access. Inbox receipt and physical-device reset-link use are separate evidence.
- Prepared a separate, enabled, email-verified customer review account through the ordinary signup flow. Privileged endpoints deny that account. Credentials remain private and are not in either store, source, screenshots or these documents.
- Native Android 21 guest interaction exposed an authenticated safety-state lookup on ordinary restaurant browsing. Source 354a593, now compiled into Android 22, skips that lookup for guests and routes the explicit reporting/blocking sign-in action through normal customer authentication, preserving the basket. Signed-in safety state is fenced to its current account/context. The mobile typecheck and bounded Android 22 emulator route passed. Existing Android 21 and iOS 17 binaries still contain the original guest issue; do not infer that deploying backend files updates them.
- Corrected the native singular restaurant-count labels; the web implementation already handled singular counts correctly.
- Prepared [asset provenance](store/ASSET_PROVENANCE_INVENTORY_2026_11_08.json) and [collected dependency notices](store/THIRD_PARTY_NOTICES.txt). This is a bounded provenance/licence-text collection, not a complete transitive/native licensing certificate or an assertion that the notice collection is embedded in current binaries.

Account deletion is implemented as password/identity-confirmed intake, staff review and actual erasure/login revocation with explained retention exceptions. The approved disposable customer was permanently erased on 8 November. Browser/native sessions and fresh logins reject access, recovery records are gone, and one normal completion email was sent; inbox receipt is unverified. The authorised maintenance workflow used the normal domain planner and transaction, with admin, policy, blocker and preview-hash checks. This is not an observed live admin HTTP/UI test. Other main/admin/business/reviewer profiles remained unchanged. A support-reviewed process does not require redesigning this as instant automatic deletion.

The public [deletion page](https://eats.calai.info/account-deletion/) provides in-app and email routes, including a specific-data request that keeps the account. Deployment returned HTTP 200. Approved immutable Terms/Privacy remain published; the extra help text does not rewrite them.

## Required before public submission

1. Complete genuine provider verification, Arndale bank onboarding and merchant commercial acceptance. Validate a controlled real paid order, the 7% calculation after restaurant discounts including delivery, commission-free periods, and weekly payout/reconciliation. Do not submit disabled checkout as a working production service.
2. Provide full reviewer access to a usable restaurant/menu/ordering journey without inbox or expiring-code dependencies. The Google full-access checkbox was deliberately left unsaved while ordering is paused. Finish the operator's review contact name/phone/email and accurate location/hours instructions.
3. Confirm menu/photo permissions and make the truthful content-rights declaration. The merchant content/menu/photo clause is an unapproved draft, not an active agreement or evidence of a signed grant. Complete the remaining content-rating/target-audience questions and final listing/privacy submission checks. Apple App Privacy publication, IARC Terms acceptance and private review contact details remain pending. Adults 18+ is the intended audience; it is not a substitute for answering actual content questions.
4. Recheck the uploaded Android 22 screenshots if the final public binary or restaurant presentation changes, and check the final native binaries on phones. Include checkout return, receipt, verification/deletion UI, messages, notification destinations and Live Activity background/terminal behavior. The three emulator screenshots and bounded guest journey do not establish those device results; iOS still needs the native guest-safety correction.
5. Review remaining test credentials and name the primary/backup people monitoring customer safety reports and support. The [content safety operations note](store/CONTENT_SAFETY_OPERATIONS.md) describes actual image-removal/report controls and filtering limits; it does not claim automatic image or all-language moderation.
6. Keep the fixed release gates matched to evidence and obtain explicit public-release approval. The deployed backend, approved active Terms/Privacy, and bounded hosted account-deletion completion now have recorded evidence in `apps/mobile/release-evidence.json`. The other nine gates remain false. A passed build or privacy form must not turn every gate true. Existing internal testing remains separate from production release.

The [review access draft](store/REVIEW_ACCESS_DRAFT_2026_11_08.md) contains no credentials and must be finalised against the enabled service. UK-only pricing/availability does not pre-certify wider distribution or EU trader information.

## Capacity and evidence limits

See [directory capacity](RESTAURANT_DIRECTORY_CAPACITY.md), [local order capacity](ORDER_CAPACITY_VALIDATION_2026-11-08.md) and [native-client local validation](ANDROID_LOCAL_VALIDATION_2026-11-08.md). Synthetic load results do not certify hosted payment latency, native rendering, push delivery, printing or 10,000 simultaneously trading restaurants. No broad load suite was repeated for these bounded safety/preparation changes.

## Primary guidance

- [Apple review guidelines](https://developer.apple.com/app-store/review/guidelines/), [complete review information](https://developer.apple.com/help/app-review/before-submitting-for-review/complete-review), [account deletion](https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion), [privacy details](https://developer.apple.com/app-store/app-privacy-details/) and [screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications).
- [Google Data safety](https://support.google.com/googleplay/android-developer/answer/10787469), [account deletion](https://support.google.com/googleplay/android-developer/answer/13327111), [reviewer access](https://support.google.com/googleplay/android-developer/answer/15748846) and [target API requirements](https://support.google.com/googleplay/android-developer/answer/11926878).
