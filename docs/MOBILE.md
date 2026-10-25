# Cal-Eats native iPhone client

`apps/mobile` is an independent Expo/React Native customer app for the Cal-Eats API. It contains no original Calai host, token, device setting, analytics SDK, payment credential, EAS project, cloud update configuration or live-provider integration.

## What is implemented

- Customer registration, login, Keychain-backed opaque bearer session, logout, local-simulation password recovery and reset.
- Delivery/collection discovery by postcode and search; restaurant menus, restaurant-supplied dietary/allergen information, required/optional modifiers and integer-pence basket totals.
- Saved address selection and CRUD, server-authoritative checkout, retry-safe order idempotency, mock card and restaurant-enabled cash.
- Order history, five-second foreground status refresh while an order is live, preparation estimate display and in-app notification history.
- Restaurant offers with viewed state and checkout selection. The server remains authoritative for eligibility, minimum spend, expiry and redemption.
- Support cases; refund-case creation, status/conversation, customer reply when requested, and explicit camera/library evidence selection for PNG/JPEG images.
- Account profile and offer preference, sanitized account export through the iOS share sheet, reviewable deletion request, and clearly labelled development legal/privacy notices.
- A bundled, offline crop of the approved original speech/phone emblem with an explicit `Cal-` + `Eats` wordmark, plus dark navy navigation surfaces and customer blue/cream content surfaces. No `Calai-Eats` wordmark is shown.

The app deliberately does not claim live card charging, Apple Pay, push notifications, driver tracking, automatic refunds or immediate account erasure.

## Dependency baseline

All versions are exact rather than floating:

| Package | Version | Basis |
| --- | ---: | --- |
| `expo` | `57.0.31` | npm's `sdk-57` tag |
| `react` | `19.2.3` | Expo SDK 57 compatibility matrix |
| `react-native` | `0.86.2` | Expo SDK 57 template/matrix |
| `expo-secure-store` | `57.0.4` | published SDK 57 package |
| `expo-image-picker` | `57.0.20` | npm's `sdk-57` tag |
| `expo-status-bar` | `57.0.1` | Expo SDK 57 default template |
| `typescript` | `6.0.3` | Expo SDK 57 default template |
| `@types/react` | `19.2.2` | Expo SDK 57 default template |

Primary compatibility references (checked 25 October 2026):

- Expo SDK matrix: <https://docs.expo.dev/versions/latest/>
- Expo's SDK 57 default template: <https://github.com/expo/expo-template-default/blob/main/package.json>
- SecureStore: <https://docs.expo.dev/versions/v57.0.0/sdk/securestore/>
- ImagePicker: <https://docs.expo.dev/versions/v57.0.0/sdk/imagepicker/>
- Expo package registry history: <https://www.npmjs.com/package/expo?activeTab=versions>
- SecureStore registry history: <https://www.npmjs.com/package/expo-secure-store?activeTab=versions>
- ImagePicker registry history: <https://www.npmjs.com/package/expo-image-picker?activeTab=versions>

SDK 57 requires Node 22.13 or newer and targets iOS 16.4 or newer according to the Expo matrix.

## Local configuration

Install dependencies from the repository root using the root workspace lockfile. Do not create a second lockfile under `apps/mobile`.

Set the independent API address before starting Metro:

```powershell
$env:EXPO_PUBLIC_API_BASE_URL='https://your-independent-cal-eats-api.example'
npm run start --workspace @cal-eats/mobile
```

The client rejects the original `calai.info` host family, URL-embedded credentials, and cleartext remote HTTP. `http://localhost`/`127.0.0.1`/`[::1]` is accepted only for simulator development. On a physical iPhone, `localhost` means the phone, so use a separately operated HTTPS Cal-Eats endpoint; never reuse the original deployment.

Native requests explicitly omit cookies and reject redirects so a bearer token is not intentionally forwarded to a different origin. Same-origin media URLs are resolved only against the configured API. React Native's enforcement of `redirect: "error"` must be confirmed on the target iOS/React Native version during physical-device testing; if the native networking layer does not enforce it, release must remain blocked until a no-redirect native transport/interceptor is in place.

The API URL is compiled into the development bundle and is not a secret. Native bearer tokens are written only to `expo-secure-store` using `AFTER_FIRST_UNLOCK` and are never logged or included in account exports.

## API boundaries

The app follows `docs/MARKETPLACE_API.md`:

- `/api/native/auth/*` and `/api/native/account/*` for native session/account operations.
- `/api/restaurants`, `/api/restaurants/:id/menu`, `/api/orders` and `/api/orders/:id` for the customer journey.
- `/api/notifications`, `/api/offers`, `/api/account`, `/api/account/preferences`, `/api/account/addresses`, `/api/support` and `/api/refund-cases` for post-order/account services.

Checkout sends menu item IDs, quantities and modifier IDs—not client prices. The API recalculates all prices and validates delivery, restaurant availability, cash support, modifiers and offers. One idempotency key is retained for every retry of a checkout attempt.

## Payment boundary

`src/payments.ts` is the explicit adapter seam. Only these server-supported modes are selectable:

- `mock_card`: deterministic local simulation; it cannot charge a card.
- `cash`: shown only when the restaurant advertises cash support; money is handled directly by the restaurant.

The Apple Pay row is visible but disabled and explains why. Enabling it requires a selected test-mode payment provider, verified merchant/account capability, an Apple Merchant ID and entitlement, domain/certificate decisions where applicable, updated server contract and native-device testing. No live keys or provider SDK were added.

## Refund evidence

The user must explicitly choose the camera or photo library and grant iOS permission. The client sends only Base64 PNG/JPEG data to the access-controlled case endpoint. It pre-checks a reported file size above 1 MiB; the API remains authoritative for encoding, byte length and dimensions. Large modern camera images may be rejected by the API's current 4096-pixel/1 MiB limits; the error is shown and the user can choose a smaller image. No image is uploaded in the background.

## Verification and release limits

Focused local checks:

```powershell
npm run typecheck --workspace @cal-eats/mobile
npm test --workspace @cal-eats/mobile
npx expo export --platform ios --output-dir <temporary-directory>
```

This phase performs JavaScript/TypeScript and offline Metro bundle verification only. It does **not** run EAS, create an Apple signing identity, provision an App Store/TestFlight build, contact a live payment service or claim physical-iPhone verification. Windows cannot produce or install a signed iOS binary. The configured `uk.co.calai.caleats` bundle identifier is a development choice and ownership must be confirmed before signing.

Before release, verify on supported iPhones: Keychain persistence/logout, camera and limited-library permission paths, Dynamic Type/VoiceOver, slow/offline recovery, evidence upload constraints, foreground/background resume, status refresh, API TLS trust, legal copy, retention obligations and the actual operator support route. Push is not implemented; “Inbox” means server-backed in-app notifications fetched while the app is open.
