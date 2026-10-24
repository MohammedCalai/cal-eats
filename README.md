# Calai Eats

Local milestone implementation using Node.js 24 only. It provides persistent authentication plus the full restaurant approval, menu, collection/delivery ordering, status, receipt and commission journey.

## Run locally

The checked toolchain is Node.js 24.19.0 and npm 11.17.0, pinned in the repository. There are no third-party runtime packages to download. See [repository preparation](docs/REPOSITORY_RELEASE.md) for the offline lockfile install.

```text
npm run db:migrate
npm run db:seed
npm start
```

Open `http://127.0.0.1:4310/` to use the app; readiness is at `/health/ready`. The database defaults to `data/calai-eats.sqlite`. Override it with `CALAI_DB_PATH`. Default local mode only binds to loopback and checks the configured host and origin. A separately selected [hosted-preview profile](docs/HOSTED_PREVIEW.md) supports an HTTPS-facing preview with secure cookies, exact write origins and no seeded accounts. Nothing is deployed.

This first version is a responsive browser app with the original Calai logo, a [phone installation manifest and offline reconnect screen](docs/PHONE_INSTALL.md). It is not a native Expo/iOS build. See `docs/STATUS.md` for verified completion, `docs/LOCAL_RUNBOOK.md` for backup and recovery, and `docs/PENDING_DECISIONS.md` for remaining commercial decisions. [Container preparation](docs/CONTAINER_PREVIEW.md) is included for a future single-instance preview; Docker and real-device installation remain unverified. No GitHub, Expo or Railway deployment has been performed.

View the 28 captured screens in [the offline gallery](docs/screenshots/index.html). Some screenshots show intermediate stages of the fictional order and offer walkthrough. The reconnect page was captured directly; that image does not verify automatic offline interception. The earlier 26-screen archive is kept local and excluded from repository uploads.

The explicit, idempotent seed command creates local demo accounts (it is never run automatically):

- `admin@calai.local` / `LocalAdmin!4310`
- `restaurant@calai.local` / `LocalRestaurant!4310`
- `restaurant2@calai.local` / `LocalRestaurant2!4310`
- `customer@calai.local` / `LocalCustomer!4310`

These credentials are public, local-only fixtures. Do not reuse them. The two restaurant users belong to separate demo restaurant tenants.
The approved demo restaurant includes a usable menu and delivery to exact outward postcode areas `LU1` and `LU2`, with a £2.50 fee and £10.00 food minimum. Seeding upgrades only the old untouched N1/N2 fixture; customized delivery settings are preserved.

## Verify

Use `npm run release:check` for inexpensive syntax, lockfile and upload-set checks. Run focused tests for changed behaviour. `npm run check` runs the complete suite and `npm run smoke` checks the persisted HTTP journey; reserve these broader checks for an integration milestone or an unresolved regression.

This is a development preview. Delivery is a postcode allowlist simulation advanced manually by the restaurant; it has no courier integration. Mock cards and refunds never contact a payment provider. Cash is marked collected only when the restaurant completes the order, and cash refunds/settlements are explicit manual records. There is no tax/tip calculation, provider-verified refund, bank settlement, physical-printer confirmation or live production release. The provisional demo contract records a 7% food-only commission for 24 months; it is not a live legal agreement.

Password recovery and informational email confirmation are implemented using a private local mail simulation. No real email is sent. Reset links expire, can be used once and revoke all existing sessions. See [the account-access contract](docs/ACCOUNT_ACCESS_API.md) for routes and the explicit local mailbox command; never publish mailbox output or the database.

## Frontend response shapes

All JSON successes use `{ "data": ... }`. List routes put the array directly in `data`. Public and owner menu reads use `{ "data": { "restaurant": Restaurant, "items": MenuItem[] } }`. Create/update routes put their DTO directly in `data`.

Order DTOs contain the restaurant/customer IDs, status, GBP subtotal, delivery fee, total, delivery address and demo-contract snapshots, commission, fulfillment, payment method/status, timestamps, item snapshots, status events, refunds and refunded totals. Customer order responses omit ledger entries; authorized restaurant and admin order views add `ledger`. Ledger kinds include `commission_mock`, `commission_cash_receivable`, their refund adjustments, and `cash_settlement`. Mock card states add partial/full refund states after capture. Cash uses `cash_due`, becomes `cash_collected` only at completion, and may then become partially/fully refunded.

The server exposes a fixed allowlist of browser assets, including the installation manifest, service worker, offline page and original-logo icons. Only public assets may be cached; API responses and authenticated documents are network-only. Finance/operations additions include demo contracts, admin-only simulated refunds and manual settlements, restaurant/admin statements, audit/job/integration views, local order expiry and notification outbox processing, recorded browser print attempts, 80mm receipts and escaped CSV reports. Phase C adds recipient-isolated in-app notifications and owner-funded tailored free-item offers for customers who have completed an order at that restaurant. Offer grants are reserved with checkout, excluded from paid totals and commission, released after rejection/expiry or a pre-completion full refund, and redeemed on completion. Automatic loyalty rewards and external messaging remain deferred. Live Stripe and Apple Pay adapters stay disabled and never read credentials.

Passwords use salted scrypt with the OWASP-published `N=32768, r=8, p=3` combination and bounded hashing concurrency. Successful login transparently upgrades the earlier local `N=16384, r=8, p=1` hashes. See the [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

Product operations include fictional restaurant onboarding that remains pending for admin review, owner/staff permissions, Luton discovery, London-time opening and overnight hours, holiday/pause/suspension controls, merchant-supplied allergens and modifiers, immutable checkout snapshots, account export, support cases and deletion review requests. Food information is unverified and restaurant supplied. Delivery times are estimates rather than driver tracking.
