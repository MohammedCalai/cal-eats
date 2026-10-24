# Calai Eats

Local milestone implementation using Node.js 24 only. It currently provides a persistent SQLite foundation, health checks, customer registration, login, session lookup and logout. The initial schema also reserves the journey tables described in `docs/ARCHITECTURE.md`.

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

## Verify

```text
npm test
npm run check
```

This is a local development system. It has no production deployment mode, delivery, tax, live payment processing, password reset, email verification or frontend yet.
