# Original Calai backend audit

## Scope and conclusion

This is a static, read-only review of the filtered snapshot at commit `ab138fd17c9ac4fc6e0b34ef5044754be643056c`. No source command, dependency install, migration, seed, network request, or test was run.

The recovered product is **not a Laravel backend**. It is a Node.js ESM application built around Express, Prisma/PostgreSQL, Redis, Vapi and a separate Python AI service. Its useful product vocabulary and a few bounded algorithms can inform Cal-Eats, but its backend should not replace the current Node 24/SQLite prototype wholesale. The recovered order path is voice-call-centric, its billing is SaaS subscription billing rather than marketplace money movement, and several authorization and webhook boundaries need redesign before reuse.

## Exact recovered stack

| Area | Evidence | Recovered implementation |
|---|---|---|
| API | `reference/calai-platform-ab138fd/backend/package.json` | Node ESM, Express `4.21.2`, Prisma Client `6.18.0` / CLI `6.19.2`, PostgreSQL (`pg`), Redis, Socket.IO, JWT, bcrypt, Passport local/Google OAuth, Nodemailer, Multer, Puppeteer, XLSX, Axios, node-cron and Stripe `22.0.1`. |
| Database | `backend/prisma/schema.prisma` | PostgreSQL Prisma schema covering users/businesses, SaaS plans/subscriptions/invoices, calls, menu items, orders, printers and audit/integration records. |
| Web | `frontend/package.json` | React `19.2.0`, Vite `7.2.4`, React Router `7.11.0`, TanStack Query/Table, Tailwind `4`, Socket.IO client and Vapi Web SDK. |
| AI service | `ai-codebase/requirements.txt` | Separate FastAPI/Uvicorn Python service with OpenAI and document parsing dependencies. |
| Runtime topology | `docker-compose.yml` | PostgreSQL 15, Redis 7, backend, AI service, frontend and nginx; configuration is supplied through an environment file. |

Lockfiles/manifests establish a JavaScript/Python service estate, not the unverified React/Laravel architecture described before source retrieval.

## Reuse map

### Safe to reuse as contracts or design references

- The domain names and associations in `backend/prisma/schema.prisma`: `Business`, `UserBusiness`, `Item`, `Order`, `OrderItem`, `Printer`, `PrintJob`, `Call`, `CallSummary`, `Integration`, `Agent` and `AuditLog`. Translate concepts deliberately; do not copy the schema verbatim.
- The owner-facing route groupings in `backend/src/app/router/index.js` are a useful inventory for future parity: settings/hours, calls and summaries, orders, items, printers, agents, subscription and dashboards.
- The print-job lifecycle in `businessowner/printer/printer.service.js`—pending, printing, completed/failed, retry count and a frozen receipt payload—is compatible in concept with the prototype's persisted print jobs. Authentication and claiming must be replaced.
- The idempotency and uncertainty model in `webhook/card-payment-transfer.js` is a useful isolated algorithm: a Redis lease, bounded calls, ownership-checked completion, and a distinct unknown outcome after dispatch. It correctly avoids claiming that a phone transfer completed payment. It is still voice/Vapi-specific and is not a card-capture implementation.
- The call/order reconciliation ideas in `webhook/helpers/order-sync.js`, `webhook/unconfirmed-order.js` and the related tests may be adapted later behind a provider boundary if voice ordering returns.
- Human-facing receipt formatting in `backend/src/app/utils/receipt.js` can be compared with the existing 80 mm receipt contract, after escaping, money, snapshot and privacy rules are retained from the current implementation.

### Reuse only after redesign

- `UserBusiness` expresses membership, but recovered authorization does not consistently use it. Retain the membership concept while keeping Cal-Eats' restaurant-scoped owner/staff permission checks.
- `Call`, `CallSummary`, `TrainingFile`, `Agent` and `Integration` are optional future bounded contexts. They should reference an order, not own its lifecycle or totals.
- `Plan`, `Subscription` and `Invoice` can later form a separate platform-billing context. They must remain separate from customer order payments, commission, merchant receivables, refunds and settlements.
- Printer registration and polling need opaque per-device credentials, hashed storage, tenant-bound job claims and replay-safe acknowledgements before the protocol is reusable.

### Remove or keep outside the core ordering path

- Do not preserve the required `Order.callId`/`Call` relationship or the unique one-order-per-call constraint from `schema.prisma`. Browser and future native orders must be first-class.
- Do not preserve `Item.vapiAgentId` or the menu upload path's requirement for a Vapi agent.
- Do not preserve JSON order items plus floating-point prices. The current prototype's normalized, snapshotted order lines and integer minor units are safer.
- Do not import local upload directories, generated bridge downloads, automatic external configuration, or startup reconciliation into the API process.

## Security and tenancy findings

1. **Authorization is global-role based, not membership based.** `middleware/checkAuthMiddleware.js` accepts a global `User.role`; business services such as `businessowner/order/order.service.js`, `businessowner/item/item.service.js` and `businessowner/printer/printer.service.js` select the first business whose `ownerId` equals the user. This ignores `UserBusiness.role`, excludes legitimate staff/multi-tenant use, and makes the first owned business an implicit tenant selector. Preserve the current prototype's explicit restaurant membership and permission checks.
2. **Suspension checks are incomplete.** Both `checkAuthMiddleware.js` and `auth/auth.service.js` check only `business.findFirst({ ownerId })`. Membership businesses and multiple owned businesses are not evaluated at resource authorization time.
3. **Sessions are stateless and not revocable.** `utils/userTokenGenerator.js` signs access and refresh JWTs without a persisted session identifier. `auth/auth.service.js` refreshes a token after only signature/user-state checks; password reset/change does not revoke refresh tokens. Logout only clears the browser cookie in `auth/auth.controller.js`. Keep Cal-Eats' persisted sessions, password-reset revocation and concurrent-login protections.
4. **Authentication leaks account state.** Login and forgot-password distinguish unknown user, unverified account and wrong password in `auth/auth.service.js`. The current generic credential/recovery responses are safer.
5. **CORS is over-broad.** `backend/src/app.js` uses `cors({ origin: true, credentials: true })`, reflecting arbitrary origins. Keep exact Origin/Host enforcement and secure-cookie rules from the current local/hosted-preview modes.
6. **Stripe webhook verification fails open.** `businessowner/payment/payment.controller.js` falls back to parsing an event when the signing secret/header is absent or signature verification fails, then may mutate subscriptions/invoices. Processing failures return HTTP 200. This route must fail closed, deduplicate event IDs and update state transactionally if rebuilt.
7. **The general Vapi webhook boundary is not visibly authenticated at the route.** `webhook/webhook.route.js` exposes `/vapi`; `webhook/webhook.controller.js` processes a merged body/query payload and returns error details with HTTP 200. Provider signature verification, size limits, replay keys and an allowlisted event schema are prerequisites.
8. **Printer device endpoints lack a secure device identity.** `businessowner/printer/device-printer.route.js` has no auth middleware. Polling accepts a printer ID, business ID or tolerant MAC match; retrieval and acknowledgement accept only a print-job ID. Anyone who obtains/guesses identifiers could claim receipt content or alter job status. Controller logs also include device/job identifiers.
9. **Error and operational logging is too revealing.** Auth, webhook and printer controllers log request context/errors and sometimes return `error.message`. Replace with bounded structured logs and non-secret correlation IDs.
10. **Monetary data uses floating point.** `schema.prisma` stores menu prices, order totals, order-line amounts and invoices as `Float`; payment service converts some values with rounding. Preserve integer minor units and historical contract/rate snapshots from Cal-Eats.

## Order, menu, call and print coupling

The recovered `Order.callId` is required and unique, and points to `Call`. `Item.vapiAgentId` associates menu data with a voice agent. `webhook/webhook.service.js`, `webhook/helpers/order-sync.js` and `webhook/unconfirmed-order.js` create/reconcile orders from call/tool events, while order confirmation can invoke `PrinterService.autoQueueOrderPrint` (`businessowner/order/order.controller.js`). Menu upload in `businessowner/item/item.service.js` opens an uploaded file, calls the AI service/Vapi configuration via Axios, parses the result, upserts items and deletes missing items.

This is a single voice-ordering pipeline rather than a marketplace-ordering core. Recommended seams are:

`channel adapter (web/native/voice) -> validated order command -> transactional order core -> durable outbox -> printer/notification/payment adapters`

The order core must remain server-owned for totals, eligibility, offer reservation, state transitions, commission, refunds and snapshots. Voice calls should supply the same input contract as the browser rather than bypass it. Printing should consume an outbox event after commit; failure must not undo an accepted order.

## Finance: subscription billing is not marketplace accounting

`Plan`, `Subscription` and `Invoice` in `schema.prisma`, plus `businessowner/payment/payment.service.js`, implement merchant SaaS subscriptions and a possible one-time onboarding fee. Stripe Checkout runs in `subscription` mode. The invoice amount is a plan price and is marked paid from a checkout event. This does **not** represent customer order authorization/capture, merchant funds, commission, cash receivables, refunds, reversals, settlement or payout.

The voice card-transfer code explicitly transfers a live call to a restaurant and reports only `initiated`/`unknown`/`not_initiated`; it does not capture or verify a customer payment. It must never be mapped to a paid order.

Preserve the current prototype's separate financial concepts: immutable order/contract snapshots, integer-pence totals, exactly-once 7% commission on paid food only, distinct mock-card and cash states, append-only ledger adjustments, refund/reversal records, and cash settlement statements. If platform subscriptions are added, give them separate tables, provider event IDs, ledgers and authorization surfaces.

## External execution hazards

Do not execute the recovered source in an audit or migration environment. The following files have side effects or can reach external/local services:

| File | Hazard |
|---|---|
| `backend/src/server.js` | On startup connects Redis/Prisma, listens on a socket, runs subscription expiry immediately and hourly, starts working-hours scheduling, syncs registered assistants, starts a Vapi reconciliation worker and schedules 90-day cleanup. |
| `backend/src/app/config/env.js` | Loads `.env`, mutates process timezone and throws during import when required environment names are absent. Values were not inspected or copied. |
| `backend/src/app/config/redis.config.js`, `backend/src/app/config/dbConnect.js` | Connect to Redis/PostgreSQL. |
| `backend/prisma/*`, package migration/seed scripts | Can change the original database; never run against retrieved configuration. |
| `backend/src/app/modules/businessowner/item/item.service.js` | Reads uploads, calls the AI service and external agent configuration, then bulk upserts/deletes menu records. |
| `backend/src/app/modules/businessowner/payment/payment.service.js` | Creates real Stripe Checkout sessions and mutates subscription/invoice/audit state from webhook events. |
| `backend/src/app/modules/webhook/*` | Handles Vapi traffic, fetches provider state, reconciles calls/orders, queues printing and can initiate live-call transfer. |
| `backend/src/app/modules/businessowner/printer/printer.service.js` | Mutates printer/job state and exposes persisted receipt text through device polling. |
| `backend/src/app/modules/businessowner/printer/printer.controller.js` | Builds a downloadable bridge whose batch file downloads Node from the internet and whose config may embed server/device coordinates. Do not distribute it without a security redesign. |
| `backend/src/app/modules/otp/*` and mail configuration | Can send real SMTP email and mutate OTP/user verification state. |
| `backend/src/app/utils/subscriptionChecker.js` and cleanup/scheduler utilities imported by `server.js` | Perform scheduled data mutation and provider synchronization. |
| `ai-codebase/*` | Runs a network-facing FastAPI/OpenAI/Vapi-adjacent service and document ingestion; do not start or feed production documents during extraction. |
| `docker-compose.yml` and Dockerfiles | Start PostgreSQL, Redis, API, AI, frontend and nginx; backend/AI startup inherits all preceding jobs and provider hazards. |
| `frontend` build/runtime | Contains public provider integration inputs (Vapi/EmailJS names); building or running is unnecessary for backend extraction and could exercise original endpoints if misconfigured. |

## Recommended integration path

1. Keep the current Node 24 built-in HTTP/SQLite application as the authoritative local product and preserve its API contracts, integer-money rules, migrations, idempotency, sessions, restaurant memberships, outbox and temp-DB testing seams.
2. Create a mapping migration, not a schema transplant. Map recovered `Business` to restaurant, `Item` to menu item/modifiers, and printer concepts to the existing print-job model. Treat calls, agents, training, SaaS subscriptions and integrations as optional modules with new foreign keys into—not ownership of—the order core.
3. First extract pure DTOs and algorithms only: call summaries, provider-independent call metadata, the card-transfer uncertainty state machine, and printer job states. Write fresh adapters with explicit credentials and current authorization.
4. If PostgreSQL is later required for scale, port the tested domain transactions behind the existing database lifecycle interface. Do not simultaneously adopt the recovered auth, route handlers and provider jobs. SQLite remains appropriate for the current single-instance guarded preview; multi-instance deployment requires a deliberate database/outbox/worker design.
5. Keep every external adapter disabled by default. Provider activation must require explicit configuration, verified webhook signatures, idempotency keys, timeout/retry policy, audit records and simulation-to-live separation.
6. Add SaaS billing only after marketplace money is stable, under a separate bounded context. Never infer restaurant subscription status from order payment state or vice versa.

The practical outcome is selective recovery: reuse the recovered product vocabulary and bounded provider-independent logic, while retaining the current prototype's safer ordering, tenancy, money and account foundations.
