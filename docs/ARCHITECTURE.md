# Calai Eats: local foundation and first journey

## Scope and authority
The user's delivery request is preserved in `USER_REQUEST.txt`. It ends after the workflow instructions; no full product specification was supplied. Build a real persisted local foundation and one complete journey. This is a local development system, not a production release. Provisional product choices: GBP, collection, one restaurant per order, 7% commission on food subtotal, no tax/delivery/tip calculations. Flag these choices for later confirmation; do not imply delivery or tax compliance is implemented.

No GitHub pushes, Actions, Codespaces, Expo EAS, paid services, live payments, cloud provisioning, DNS changes or app submissions. Never inspect or reuse other Calai products' credentials/configuration. Use only this project's data. Mock payment processing must be visibly labelled and must never call a provider.

## Architecture
- Node.js 24 (installed 24.19.0), ESM JavaScript, npm workspaces, no downloaded runtime dependencies for this milestone.
- `apps/api`: local HTTP server, domain services, repository, migrations and tests. Node built-in SQLite, crypto and test runner. Explicit SQL migrations, parameterized queries, foreign keys and transactional writes.
- `apps/web`: responsive browser customer/restaurant/admin portal; plain modules with shared API contracts. Same-origin static assets served by API. No credentials persisted by browser JavaScript.
- `packages/contracts`: shared roles, statuses, validation bounds and money rules. Define API shapes here and in API.md before frontend implementation.
- `data/calai-eats.sqlite`: ignored local database. Test databases use temporary directories and must not touch demo data.
- Default server: `127.0.0.1:4310`. Fail closed for production environment or non-loopback bind in this local milestone. External providers disabled. API endpoints under `/api`; health at `/health/live`, `/health/ready`.

## Security and isolation
Customer self-registration only. Admin and restaurant accounts are created by an explicit local seed command, never public role input. Seed is idempotent, local-only, and uses explicitly documented demo-only credentials. Passwords use salted scrypt; session tokens are cryptographically random, hashes stored in DB, expiry enforced. HttpOnly SameSite=Strict cookies; authenticated writes validate exact configured Origin (missing Origin permitted for non-browser scripts), JSON content type, request size and CSRF protections. No CORS wildcard. Limit login/register attempts. Logout revokes session. API errors never expose SQL, stack traces, hashes or tokens.

All restaurant access is checked through membership derived from the authenticated user, never trusted client ownership fields. Customer reads restricted to own orders; restaurant sees only its own orders/menu; admin has deliberate global read/approval permissions. Unknown/inaccessible objects use safe errors. Validate body shapes, types, lengths, integer prices/quantities and allowed state transitions. Persist audit/order events. Avoid HTML injection in UI and receipt output. Host/origin checks and restrictive browser headers protect loopback app.

## Data model and correctness
Tables: users, sessions, restaurants, restaurant_memberships, menu_items, orders, order_items, order_events, ledger_entries, schema_migrations (and idempotency data as needed). Use text UUID identifiers and ISO UTC timestamps. Approval states `pending`, `approved`, `rejected`. Roles `customer`, `restaurant`, `admin`. Orders snapshot item names/prices, restaurant name, currency and totals. Calculate prices exclusively from active DB menu records belonging to the approved restaurant. Never accept a client-computed total or commission.

All money is integer GBP pence, bounded safe integers. Commission is 700 basis points, rounded half up once per order subtotal. Example: 1999 pence => 140 pence. Ledger records recognition at acceptance exactly once, transactionally with order event/status. Refunds (when implemented) are compensating entries, never mutation/deletion of original financial records. Cash receivable represents commission owed by restaurant, not money collected by platform. Never misrepresent mock funds as settled.

Initial state path: placed -> accepted -> preparing -> ready -> completed; placed -> rejected. Customers cannot change restaurant status. Order POST requires a bounded Idempotency-Key scoped to customer; same key/same canonical request returns original order, same key/different payload yields 409. Do not duplicate order, ledger or events on retries.

## Milestones and ownership
1. Foundation implementation agent (`gpt-5.6-sol`): root package/config/gitignore/README, all code under apps/api and packages/contracts, migrations, local seed/setup, health/auth, tests. Lead owns docs/ARCHITECTURE.md, docs/API.md, docs/STATUS.md, docs/USER_REQUEST.txt. No frontend dependent implementation until contracts are fixed.
2. Backend journey agent (same model; sole owner of schema/dependencies): approval, menu, order state machine, mock/cash bookkeeping, receipts, integration/security tests. Lead reviews security/financial rules.
3. Web agent (same model): only apps/web and frontend tests; backend contract fixed. Build usable role-based journey with visible errors, loading states and printable receipt. Any shared changes go through lead.
4. Integration: root runs full tests, local persisted smoke journey, security/finance review and browser check if available. Keep concise handover and unresolved scope accurate.

Default one implementation agent. At most two when scopes are independent. Work on local feature branches; use separate worktrees for concurrent conflicting scopes. No duplicated tasks or repeated retries: after two failed attempts report exact error and proposed next step.

## Validation
Use `npm test` for meaningful unit/API tests. Cover fresh/repeated migrations, persistence after reopen, health, authentication/session expiry/revocation, unauthorized role escalation, CSRF, cross-tenant access, unavailable menus/restaurants, server-owned totals, idempotency conflict, allowed/forbidden transitions, financial rounding, exactly-once commission and HTML-escaped receipt. Add a reproducible `npm run smoke` that uses an isolated temporary DB. Root run scripts should work on Windows without POSIX shell assumptions. README must give exact local start/seed/test commands and clearly state limitations.
