# API contract v1 (local milestone)

This is the original foundation contract. Implemented finance, product operations, offers/notifications and schema-v7 account access extend it in LOCAL_COMPLETION.md, PRODUCT_OPERATIONS_API.md, OFFERS_API.md and ACCOUNT_ACCESS_API.md. See STATUS.md for the current completed scope.

Success JSON is `{ "data": ... }`; failure is `{ "error": { "code": "...", "message": "..." } }`. Use HTTP 400 validation, 401 session missing, 403 role/origin denial, 404 inaccessible resource, 409 conflict, 413 body too large, 415 media type and 429 rate limit. No stack traces. IDs are UUID strings, money integer pence, dates ISO UTC. Response DTOs camelCase; DB names may use snake_case. Same-origin cookies; browser writes send JSON.

Foundation endpoints:
- `GET /health/live`: status/service.
- `GET /health/ready`: status/database/migration check, 503 if not ready.
- `POST /api/auth/register` `{name,email,password}`: creates only customer and session; 201 `{user}`.
- `POST /api/auth/login` `{email,password}`: 200 `{user}` plus session cookie.
- `GET /api/auth/me`: 200 `{user}` with `{id,name,email,role}`.
- `POST /api/auth/logout` `{}`: revoke cookie/session; 200 `{loggedOut:true}`.

Journey endpoints (backend agent implements before frontend starts):
- `GET /api/restaurants`: public approved restaurant array.
- `GET /api/restaurants/:id/menu`: approved restaurant + active menu.
- `GET /api/restaurant/restaurants`: member's restaurant array (all approval states).
- `GET /api/restaurant/restaurants/:id/menu`: member-only `{restaurant,items}` including unavailable menu items.
- `POST /api/restaurant/restaurants` `{name}`: authenticated restaurant role creates pending restaurant + membership.
- `POST /api/restaurant/restaurants/:id/menu` `{name,description,priceMinor}`: member adds menu item; 201 item.
- `PATCH /api/restaurant/restaurants/:id/menu/:itemId` `{name?,description?,priceMinor?,available?}`: member changes item.
- `PATCH /api/restaurant/restaurants/:id/delivery` `{enabled,outcodes,deliveryFeeMinor,minDeliverySubtotalMinor}`: member configures postcode-based delivery; exact validation and bounded values.
- `GET /api/admin/restaurants`: admin all restaurants.
- `PATCH /api/admin/restaurants/:id/approval` `{status:"approved"|"rejected"}`: admin approval + audit.
- `POST /api/orders` `{restaurantId,items:[{menuItemId,quantity}],paymentMethod:"mock_card"|"cash",fulfillment:"collection"|"delivery",deliveryAddress?:{line1,line2?,city,postcode}}` + Idempotency-Key: customer; 201 order (200 replay). Server validates delivery area/minimum and computes fee/total; never accepts client monetary fields.
- `GET /api/orders`: own customer orders.
- `GET /api/orders/:id`: own/member/admin order detail with items/events/ledger as authorized.
- `GET /api/restaurant/restaurants/:id/orders`: member order array.
- `PATCH /api/restaurant/orders/:id/status` `{status}`: member allowed transition, 200 order. Repeated current status returns unchanged order (no new event/ledger).
- `GET /api/admin/orders`: admin all orders.
- `GET /api/admin/ledger`: admin financial entry array.
- `GET /api/orders/:id/receipt`: authorized HTML receipt with print styles, escaped snapshots and visible mock/cash label. No automatic print side effects.

Proposed DTO fields to finalize during backend milestone:
Restaurant `{id,name,status,createdAt,delivery:{enabled,outcodes,deliveryFeeMinor,minDeliverySubtotalMinor}}`; MenuItem `{id,restaurantId,name,description,priceMinor,available}`; Order `{id,restaurantId,restaurantName,customerId,status,currency,subtotalMinor,deliveryFeeMinor,totalMinor,deliveryAddress,commissionMinor,paymentMethod,paymentStatus,fulfillment,createdAt,updatedAt,items,events}`. Detail may include ledger. Ledger `{id,orderId,restaurantId,kind,amountMinor,currency,createdAt}` with explicit kinds to be finalized. Public responses never include customer info, credentials or memberships.

Front-end must use documented real responses, not synthesize success. Updates can poll own orders every 5 seconds and must stop on logout. Payment mocks are deterministic local adapter behavior, not Stripe sandbox verification.

## Frozen response details for web integration
All list routes return `data: [...]`. Menu GET routes return `data: {restaurant,items:[MenuItem]}`. Create/update routes return the DTO directly in data; auth routes are the documented `{user}` exception. Order items snapshot `{menuItemId,name,unitPriceMinor,quantity}` (may also include id). Order events contain kind/fromStatus/toStatus/createdAt. Ledger kinds: `commission_mock` or `commission_cash_receivable`; do not sum different kinds as cash received. Mock card payment states `mock_authorized`, `mock_captured`, `mock_cancelled`; cash states `cash_due`, `cash_collected`, `cash_cancelled`. No refunds in this milestone. Delivery settings are the `delivery` object documented above.


Checkout price review (28 October 2026): new browser and native clients include optional `expectedTotalMinor` when posting an order. The value is part of the idempotency fingerprint. The server compares it with its authoritative food-after-promotion plus owner-set delivery fee inside the order transaction, before payment authorisation or order/grant reservation. A mismatch returns HTTP 409 `PRICE_CHANGED`, leaving no new order; clients refresh the price and require another explicit place-order action. Exact retries of a successfully created request return its original snapshot even after menu/fee changes. The field remains optional for existing test clients. It never overrides server prices.
