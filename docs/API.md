# API contract v1 (local milestone)

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
- `POST /api/restaurant/restaurants` `{name}`: authenticated restaurant role creates pending restaurant + membership.
- `POST /api/restaurant/restaurants/:id/menu` `{name,description,priceMinor}`: member adds menu item; 201 item.
- `PATCH /api/restaurant/restaurants/:id/menu/:itemId` `{name?,description?,priceMinor?,available?}`: member changes item.
- `GET /api/admin/restaurants`: admin all restaurants.
- `PATCH /api/admin/restaurants/:id/approval` `{status:"approved"|"rejected"}`: admin approval + audit.
- `POST /api/orders` `{restaurantId,items:[{menuItemId,quantity}],paymentMethod:"mock_card"|"cash",fulfillment:"collection"}` + Idempotency-Key: customer; 201 order (200 replay).
- `GET /api/orders`: own customer orders.
- `GET /api/orders/:id`: own/member/admin order detail with items/events/ledger as authorized.
- `GET /api/restaurant/restaurants/:id/orders`: member order array.
- `PATCH /api/restaurant/orders/:id/status` `{status}`: member allowed transition, 200 order. Repeated current status returns unchanged order (no new event/ledger).
- `GET /api/admin/orders`: admin all orders.
- `GET /api/admin/ledger`: admin financial entry array.
- `GET /api/orders/:id/receipt`: authorized HTML receipt with print styles, escaped snapshots and visible mock/cash label. No automatic print side effects.

Proposed DTO fields to finalize during backend milestone:
Restaurant `{id,name,status,createdAt}`; MenuItem `{id,restaurantId,name,description,priceMinor,available}`; Order `{id,restaurantId,restaurantName,customerId,status,currency,subtotalMinor,commissionMinor,paymentMethod,paymentStatus,fulfillment,createdAt,updatedAt,items,events}`. Detail may include ledger. Ledger `{id,orderId,restaurantId,kind,amountMinor,currency,createdAt}` with explicit kinds to be finalized. Public responses never include customer info, credentials or memberships.

Front-end must use documented real responses, not synthesize success. Updates can poll own orders every 5 seconds and must stop on logout. Payment mocks are deterministic local adapter behavior, not Stripe sandbox verification.
