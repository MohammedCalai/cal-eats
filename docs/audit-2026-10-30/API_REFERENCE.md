# API and authentication handover

Source baseline `b94092ee4657b01d93466a4ddf282155f76a0fa2`, reviewed 30 October 2026. This is an inventory of the current API, not a proposed replacement or a claim that every endpoint has passed production verification. Route dispatch is in `apps/api/src/app.js`. Source path/line references below are repository-relative.

## Calling conventions

Use the configured same HTTPS origin for hosted browser writes. JSON requests require `Content-Type: application/json`; default body limit is 16 KiB, with explicit larger limits for image/import/webhook routes. Browser authentication uses the HttpOnly `calai_session` cookie, not JavaScript storage. Native routes return opaque Bearer tokens; business and customer audiences are distinct. Neither a restaurant ID nor a Calai activation flag supplied by a client establishes authorisation.

Success responses normally contain `{data: ...}`, but data may be an array, a DTO or a paged object. Errors contain `{error:{code,message}}`. Common outcomes are 400 validation, 401 unauthenticated, 403 forbidden/origin/host, 404 unavailable or inaccessible resource, 409 state/idempotency conflict, 410 expired messaging window, 413 body too large, 415 media type, 429 throttled and 503 unavailable provider. CSV, HTML receipts, image media and SSE are non-JSON exceptions. Do not blindly JSON-decode those responses.

Mutation idempotency is route-specific. Orders, refunds, promotions, support replies, finance operations and device claims use durable keys/tokens in different scopes; inspect the handler before calling. A retry must retain the original key and payload. Do not create a new key after an ambiguous network result. Concurrent order-message retries have a confirmed defect described in [the backend audit](BACKEND_DATABASE.md).

Symbols: `R` restaurant ID, `O` order ID, `I` menu item ID, `C` case ID, `U` user ID; braces are path substitutions. Actor `member` means a restaurant user with current membership in that exact restaurant; `owner` also requires its owner permission. Actor `participant` means the resource's customer, permitted restaurant user, or an explicitly permitted admin—not any signed-in user.

## Public and identity endpoints

| Method | Endpoint | Authorisation / implementation |
|---|---|---|
| GET | `/api/runtime`, `/health/live`, `/health/ready` | Public after host check; `app.js:78-85`. Readiness verifies registered migration presence only. |
| GET | `/api/restaurants`, `/api/restaurants/{R}/menu` | Public approved-restaurant discovery/menu; `journey.js:120-142`. List filters: `postcode`, `fulfillment`, `q`, `cuisine`; currently unbounded. |
| GET | `/api/service-availability` | Public postcode/fulfilment service-area check; `service-areas.js:58`. |
| POST | `/api/location/postcode` | Rate-limited public location lookup; `service-areas.js:70`. Fixed provider, bounded input. |
| GET | `/api/media/{id}` | Published restaurant media, or admin/owner checks for unpublished media; `polish.js:51,59`. |
| GET | `/api/payments/config` | Public provider-mode/availability configuration; `payments/stripe-connect.js:79`. No credentials returned. |
| POST | `/api/auth/register`, `/api/auth/restaurant-register`, `/api/auth/login` | Public, host/origin checks and database-backed rate limiter; `app.js:102-160`. Restaurant signup stays pending; cannot self-select admin role. |
| GET / POST | `/api/auth/me` (GET), `/api/auth/logout` (POST) | Current browser session / revoke browser token; `app.js:162-170`. |
| POST | `/api/auth/password/forgot`, `/api/auth/password/reset` | Rate-limited recovery; reset requires valid one-use token; `account-access.js:35-57`. Delivery is a local sink in this source. |
| POST | `/api/auth/email-verification/send`, `/api/auth/email-verification/confirm` | Send requires user; confirm requires token; both rate-limited; `account-access.js:59-73`. |
| POST | `/api/native/auth/register`, `/api/native/auth/login`, `/api/native/business/auth/login` | Separate native customer/business token issuance; `native-auth.js:21-31`. No native admin audience. |
| GET / POST | `/api/native/auth/me` (GET), `/api/native/auth/logout` (POST) | Native session required; `native-auth.js:33-34`. |
| POST | `/api/native/auth/forgot-password`, `/api/native/auth/reset-password` | Aliases handled in account-access routes. |

## Account and customer endpoints

| Method | Endpoint | Authorisation / implementation |
|---|---|---|
| GET, PATCH | `/api/account` | Own account; `product.js:34-44`. PATCH name/phone only. |
| GET | `/api/account/export`, `/api/native/account/export` | Own retained records; native alias dispatches to product handler; `product.js:46-55`, `app.js:193`. |
| GET, POST | `/api/account/deletion-requests` | Own request records/create request; `product.js:57-61`. This is a review workflow, not immediate erasure. |
| POST | `/api/native/account/deletion-request` | Alias of deletion-request creation; `app.js:197`. |
| GET, PATCH | `/api/account/preferences` | Own legacy merchant-offer preference, synchronised to marketing preferences; `polish.js:34-35`. |
| GET, PATCH | `/api/account/marketing-preferences` | Customer own in-app/push consent; `loyalty.js:80-83`. |
| GET | `/api/account/sessions` | Own browser and native sessions; `polish.js:36`. |
| DELETE / POST | `/api/account/sessions/{id}` (DELETE), `/api/account/sessions/revoke-others` (POST) | Own session revocation; `polish.js:37-39`. |
| GET, POST / PATCH, DELETE | `/api/account/addresses`; `/api/account/addresses/{id}` | Own saved address CRUD; `polish.js:40-44`, limit 10 addresses. |
| GET | `/api/account/recent-addresses` | Customer own recent order addresses; `service-areas.js:69`. |
| GET | `/api/notifications` | Recipient-filtered notifications; `offers.js:65-82`. |
| PATCH | `/api/notifications/{id}` | Mark own notification read; `offers.js:83-90`. |
| GET | `/api/notifications/stream` | Signed-in recipient, current session and membership rechecked; `order-messaging.js:86-89`, `notification-stream.js`. Three streams per user per process. |
| GET / PATCH | `/api/offers` (GET), `/api/offers/{id}` (PATCH) | Customer's grants/viewed state; `offers.js:95-109`. |
| GET / POST | `/api/promotions` (GET), `/api/promotions/{id}/claim` (POST) | Customer consent/first-order eligibility; `loyalty.js:70-79`. |
| GET | `/api/customer/conversations` | Customer's own conversation inbox; `customer-relationships.js:281`. |
| GET, POST / POST | `/api/customer/conversations/{id}/messages`; `/api/customer/conversations/{id}/read` | Thread ownership, expiry and idempotency; `customer-relationships.js:284-289`. |

## Orders and restaurant operations

| Method | Endpoint | Authorisation / implementation |
|---|---|---|
| POST | `/api/orders/quote`, `/api/orders` | Customer; server validates/reprices basket and eligibility. Creation requires `Idempotency-Key`; `journey.js:233-234,286-402`. |
| GET | `/api/orders`, `/api/orders/{O}`, `/api/orders/{O}/receipt` | Own customer list; detail/receipt use participant access; `journey.js:235-238,269-282`. Customer 90-day/active-order history applies before dispatch. |
| POST | `/api/orders/{O}/checkout`, `/api/orders/{O}/payment/refresh` | Owning customer and Stripe eligibility; `payments/stripe-connect.js:80-84`. |
| GET, POST | `/api/restaurant/restaurants` | Restaurant identity; creation restricts existing staff-only users; `journey.js:143-159`. |
| GET, POST | `/api/restaurant/restaurants/{R}/menu` | Read member; create owner; `journey.js:161-173`. |
| PATCH | `/api/restaurant/restaurants/{R}/menu/{I}` | Owner, item scoped to R; `journey.js:175-184`. |
| PUT / POST | `/api/restaurant/restaurants/{R}/menu/order` (PUT), `/menu/import` (POST) | Owner; exact item permutation / validated idempotent import; `polish.js:47-48,55`. |
| POST, DELETE | `/api/restaurant/restaurants/{R}/cover`, `/api/restaurant/restaurants/{R}/menu/{I}/photo` | Owner; validated image content, per-restaurant quota; `polish.js:49-58`. |
| PATCH | `/api/restaurant/restaurants/{R}/delivery`, `/profile` | Owner; validated business settings; `journey.js:186-206`. |
| GET | `/api/restaurant/restaurants/{R}/readiness` | Owner; `polish.js:45`. |
| GET, POST | `/api/restaurant/restaurants/{R}/staff` | Owner; creating a new staff identity, not promoting arbitrary existing users; `product.js:16-32`. |
| GET | `/api/restaurant/restaurants/{R}/orders` | Member; owner-only ledger/commission fields; `journey.js:247-257`. `page`, `pageSize`, `status`; unpaged compatibility path remains. |
| GET | `/api/restaurant/orders/pending-confirmation` | Restaurant user, optional scoped restaurantId; 100-row cap plus total; `journey.js:239-245`. |
| PATCH | `/api/restaurant/orders/{O}/status`, `/preparation` | Order's current restaurant membership and allowed transition; `journey.js:267,405`, `marketplace.js:129`. |
| GET | `/api/restaurant/restaurants/{R}/dashboard` | Member; finance/insight fields only for owner; `business-dashboard.js:104-124`. Period, view and bounded page/pageSize. |
| GET | `/api/restaurant/restaurants/{R}/dashboard/metrics.csv`, `/orders.csv` | Owner; bounded export; `dashboard-exports.js:105-116`. |
| GET, PATCH | `/api/restaurant/restaurants/{R}/message-settings` | Member read / owner update; `order-messaging.js:110-118`. |
| GET, POST | `/api/orders/{O}/messages` | Customer/restaurant participant; admin reads need reason and audit; admin cannot send; `order-messaging.js:134-165`. |
| POST, PUT, PATCH | `/api/orders/{O}/messages/read` | Order participant, selected message belongs to order and is unexpired; `order-messaging.js:120-132`. |
| POST | `/api/orders/{O}/message-incidents` | Non-admin participant; bounded incidents; `order-messaging.js:90-98`. |
| POST / PATCH | `/api/orders/{O}/print-jobs` (POST), `/api/print-jobs/{id}` (PATCH) | Browser print tracking under order/user access; `operations.js:90-108`. This is distinct from device print jobs. |

## Restaurant CRM, offers, support and disputes

| Method | Endpoint | Authorisation / implementation |
|---|---|---|
| GET | `/api/restaurant/restaurants/{R}/customers`, `/inbox` | Owner only; server-paged directory/inbox; `customer-relationships.js:242-246`. |
| GET, PATCH | `/api/restaurant/restaurants/{R}/customers/{U}/profile` | Owner and established relationship; `customer-relationships.js:247-260`. |
| GET, POST, PATCH / POST | `/api/restaurant/restaurants/{R}/customers/{U}/conversation`; `/conversation/read` | Owner/restaurant-customer relationship; `customer-relationships.js:261-278`. |
| GET, POST | `/api/restaurant/restaurants/{R}/offers` | Owner; targeted grants, explicit consent/eligibility; `offers.js:92-94,113`. |
| GET / PATCH | `/api/restaurant/restaurants/{R}/loyalty`, `/loyalty/suggestions` (GET), `/loyalty/settings` (GET/PATCH) | Owner; `loyalty.js:61-65`. |
| GET, POST | `/api/restaurant/restaurants/{R}/loyalty/promotions` | Owner; `loyalty.js:67-69`. |
| GET, POST | `/api/support` | Own help requests / create scoped request; `support-cases.js:102-139` shadows old product handler. |
| GET | `/api/restaurant/restaurants/{R}/support` | Member, only customer support assigned to R; `support-cases.js:103-109`. |
| GET, PATCH / POST | `/api/support/{C}`; `/messages`, `/read` | Requester or assigned restaurant team/admin; replies encrypted, creation text plaintext; `support-cases.js:140-189`. |
| GET, POST | `/api/refund-cases` | Customer own cases/create case; `marketplace.js:109-110`. |
| GET | `/api/refund-cases/{C}`, `/resolution`, `/evidence/{id}` | Case-specific customer/owner/admin access; `marketplace.js:111,114`, `dispute-resolution.js:59`. |
| POST | `/api/refund-cases/{C}/evidence`, `/reply` | Evidence: scoped customer/restaurant owner/admin; reply: owning customer in permitted state; `marketplace.js:112-113,221,258`. |
| GET / POST | `/api/restaurant/restaurants/{R}/refund-cases`, `/{C}` (GET), `/{C}/reply` (POST) | Owner and case belongs to R; `marketplace.js:120`. |
| POST | `/api/restaurant/restaurants/{R}/refund-cases/{C}/proposals`, `/proposals/{id}/fulfil` | Restaurant owner with exact nested case/proposal checks; `dispute-resolution.js:61,65`. |
| POST | `/api/refund-cases/{C}/proposals/{id}/respond`, `/confirm-fulfilment` | Owning customer and proposal/case relationship; `dispute-resolution.js:63,67`. |

## Finance, printers and administration

| Method | Endpoint family | Authorisation / implementation |
|---|---|---|
| GET / POST | `/api/restaurant/restaurants/{R}/contract` (GET), `/contract/accept` (POST), `/statement` (GET) | Owner; legacy contract/statement paths remain active; `operations.js:40-68`. |
| GET | `/api/restaurant/restaurants/{R}/finance/summary`, `/orders`, `/orders/{O}/breakdown`, `/payouts`, `/payouts/{id}`, `/commission-policy`, `/statement.csv` | Owner, nested order/payout scope; `marketplace.js:95-100`, `finance-details.js:52`. Statement may return 202 report job. |
| POST | `/api/restaurant/restaurants/{R}/finance/commission-policy/accept`, `/cash-collections` | Owner and operation idempotency; `marketplace.js:98,102`. |
| GET, POST | `/api/restaurant/restaurants/{R}/finance/cash-mandate`, `/provider-account` | Owner; simulator/provider boundaries apply; `marketplace.js:101,103`. |
| GET | `/api/restaurant/restaurants/{R}/finance/stripe`, `/finance/stripe/payouts`, `/finance/stripe/banking` | Owner; Connect state, payouts and banking details; `payments/stripe-connect.js:85-98`. |
| POST | `/api/restaurant/restaurants/{R}/finance/stripe/onboarding`, `/refresh`, `/dashboard` | Owner; Stripe mode/configuration guards; same source. |
| GET, PATCH | `/api/restaurant/restaurants/{R}/weekly-statements/settings` | Owner; `business-weekly-statements.js:185`. |
| GET | `/api/restaurant/restaurants/{R}/weekly-statements`, `/weekly-statements/{id}.csv` | Owner, statement belongs to restaurant/recipient; same source. |
| GET | `/api/report-jobs/{id}`, `/api/report-jobs/{id}/download` | Requesting actor/admin with scoped report checks; `marketplace.js:108`. |
| GET, POST / PATCH | `/api/restaurant/restaurants/{R}/printers`; `/printers/{id}` | Owner; `marketplace.js:121-122`. |
| POST | `/api/restaurant/restaurants/{R}/printers/{id}/pairing-code`, `/reprints` | Owner, exact printer scope; `marketplace.js:123-124`. Manual reprint is a new auditable operation. |
| POST | `/api/devices/pair`, `/heartbeat`, `/jobs/claim`, `/jobs/{id}/ack` | Pairing secret or device bearer plus claim proof; `marketplace.js:125-128`. Not browser owner credentials. |
| POST | `/api/provider-events/stripe-test`, `/stripe-live`, with optional `/connect` suffix | Correct webhook signature, mode/account and durable deduplication; `payments/provider-events.js:15`. |
| GET | `/api/admin/restaurants`, `/orders`, `/ledger`, `/users`, `/contracts`, `/statements`, `/audit`, `/jobs`, `/integrations`, `/operational-settings` | Admin; `journey.js`, `operations.js`, `marketplace.js`. Several remain unbounded. |
| GET | `/api/admin/restaurants/{R}/menu`, `/devices`, `/readiness` | Admin read views; `marketplace.js:92-93`, `polish.js:46`. |
| PATCH | `/api/admin/restaurants/{R}/approval`, `/suspension` | Admin, validation and audit; `journey.js:212-231`. |
| POST | `/api/admin/orders/{O}/refunds`, `/api/admin/restaurants/{R}/cash-settlements` | Admin, idempotent financial workflow; `operations.js:62-74,117-181`. |
| GET | `/api/admin/reports/orders.csv`, `/ledger.csv`; `/api/admin/dashboard/metrics.csv`, `/orders.csv`, `/restaurants.csv` | Admin; legacy exports materialise all rows; newer dashboard exports bound rows. |
| GET | `/api/admin/finance/summary`, `/exceptions`, `/restaurants/{R}/{summary|orders|payouts}`, optional payout ID | Admin; `marketplace.js:104-107`. |
| POST | `/api/admin/finance/workers/run` | Admin explicit local worker trigger; `marketplace.js:106`. Do not use as a load test against a live environment. |
| GET | `/api/admin/finance/stripe/readiness`, `/payouts` | Admin provider readiness/payout views; `payments/stripe-connect.js:99-108`. |
| GET | `/api/admin/refund-cases`, `/api/admin/refund-cases/{C}` | Admin; `marketplace.js:115-116`. |
| POST | `/api/admin/refund-cases/{C}/actions`, `/decision`, `/cash-confirmation`, `/escalate`, `/resolve-override` | Admin with state/audit controls; `marketplace.js:117-119`, `dispute-resolution.js:69`. |
| GET / PATCH / POST | `/api/admin/support`, `/api/admin/support/{C}`, `/messages`, `/read` | Admin-only route alias plus resource helper; `support-cases.js`. Methods as own support variants above. |
| GET, PATCH | `/api/admin/message-incidents` (GET), `/{id}` (PATCH); `/api/admin/deletion-requests` (GET), `/{id}` (PATCH) | Admin; `order-messaging.js:100-108`, `product.js:78-83`. |
| GET | `/api/admin/order-confirmation-alerts`, `/api/admin/customer-emails` | Admin delivery diagnostics; `order-confirmation.js:117`, `customer-emails.js:163`; delegated from `offers.js:62-63`. |
| GET | `/api/admin/loyalty/promotions`, `/vouchers` | Admin; `loyalty.js:55-59`. |
| GET, PUT | `/api/admin/service-areas` | Admin; `service-areas.js:59-67`. |
| GET / PATCH | `/api/admin/governance/accounts` (GET), `/{U}` (PATCH) | Admin account enablement/role governance; `admin-governance.js:15-34`. |
| GET, POST / PATCH, DELETE | `/api/admin/governance/restaurants/{R}/memberships`; `/memberships/{U}` | Admin, exact nested membership, last-owner protection; `admin-governance.js:36-52`. |
| GET, PATCH | `/api/admin/governance/refund-policy` | Admin; `admin-governance.js:54-59`. |

Every shorthand such as `/profile` in a row extends that row's preceding full base path. Braced alternatives list explicit route suffixes, not literal braces to send. API payload details remain in source validators and the existing domain documentation below. An approved next improvement is a generated OpenAPI contract plus negative-authorisation contract tests; do not replace these routes wholesale merely to introduce a framework.

## Existing detailed payload contracts

- [Core API](../API.md), [account access](../ACCOUNT_ACCESS_API.md), [runtime/native API](../RUNTIME_API.md), [final polish](../FINAL_POLISH_API.md).
- [Marketplace](../MARKETPLACE_API.md), [payments](../PAYMENT_PROVIDER.md), [provider events](../PROVIDER_EVENTS.md), [finance detail](../BUSINESS_FINANCE_DETAILS.md), [weekly statements](../BUSINESS_WEEKLY_STATEMENTS.md).
- [Order messaging](../MESSAGING.md), [customer directory/inbox](../CUSTOMER_DIRECTORY_AND_INBOX.md), [dispute resolution](../DISPUTE_RESOLUTION_API.md), [governance](../GOVERNANCE_API.md).
- [Offers](../OFFERS_API.md), [loyalty](../LOYALTY.md), [service areas](../SERVICE_AREAS_AND_LOCATION.md), [order confirmation](../ORDER_CONFIRMATION_BACKEND.md), [printer bridge](../PRINT_BRIDGE.md).

These documents include historical milestone language. Resolve any conflict against the audited source and regression tests, then update the contract under review. In particular, the current source includes live-gated Stripe paths and schema 31; older statements that all Stripe paths are always disabled or that schema 27 is latest are stale.
