# Calai Eats

Local milestone implementation using Node.js 24 only. It provides persistent authentication plus the full restaurant approval, menu, collection/delivery ordering, status, receipt and commission journey.

## Run locally

Requires Node.js 24.19.0 or newer. No package download is needed.

```text
npm run db:migrate
npm run db:seed
npm start
```

Open `http://127.0.0.1:4310/health/ready`. The database defaults to `data/calai-eats.sqlite`. Override it with `CALAI_DB_PATH`. The server accepts only its exact configured host and origin and only binds to loopback. This milestone intentionally refuses to run with `NODE_ENV=production`.

The explicit, idempotent seed command creates local demo accounts (it is never run automatically):

- `admin@calai.local` / `LocalAdmin!4310`
- `restaurant@calai.local` / `LocalRestaurant!4310`
- `restaurant2@calai.local` / `LocalRestaurant2!4310`
- `customer@calai.local` / `LocalCustomer!4310`

These credentials are public, local-only fixtures. Do not reuse them. The two restaurant users belong to separate demo restaurant tenants.
The approved demo restaurant includes a usable menu and delivery to exact outward postcode areas `N1` and `N2`, with a £2.50 fee and £10.00 food minimum.

## Verify

```text
npm test
npm run check
npm run smoke
```

This is a local development system. Delivery is a postcode allowlist simulation advanced manually by the restaurant; it has no courier integration. Mock cards never contact a payment provider. Cash is marked collected only when the restaurant completes the order. There is no tax/tip calculation, refunds, production deployment mode, password reset, email verification or frontend yet. The provisional commission is 7% of food subtotal and excludes the delivery fee.

## Frontend response shapes

All JSON successes use `{ "data": ... }`. List routes put the array directly in `data`. Public and owner menu reads use `{ "data": { "restaurant": Restaurant, "items": MenuItem[] } }`. Create/update routes put their DTO directly in `data`.

Order DTOs contain the restaurant/customer IDs, status, GBP subtotal, delivery fee, total, delivery address snapshot or `null`, commission, fulfillment, payment method/status, timestamps, item snapshots and status events. Customer order responses omit ledger entries; authorized restaurant and admin order views add `ledger`. Ledger kinds are `commission_mock` and `commission_cash_receivable`. Mock card states move from `mock_authorized` to `mock_captured`; rejected mock cards become `mock_cancelled`. Cash uses `cash_due`, becomes `cash_collected` only at completion, and becomes `cash_cancelled` on rejection.
