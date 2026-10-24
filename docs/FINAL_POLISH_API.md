# Final local polish API

All JSON responses use `{data: ...}`. Existing Host, Origin, authentication, body and throttle controls remain in force.

## Customer account

- `GET /api/account/preferences` -> `{merchantOffers:boolean}`. New and migrated accounts default to `false`.
- `PATCH /api/account/preferences` body `{merchantOffers:boolean}` -> the same DTO. Operational order notifications are unaffected.
- `GET /api/account/sessions` -> `[{id,createdAt,expiresAt,current}]` for the signed-in user only.
- `DELETE /api/account/sessions/:id` -> `{revoked:true}`. A user can revoke only their own session.
- `POST /api/account/sessions/revoke-others` body `{}` -> `{revokedCount:number}`.
- `GET /api/account/addresses` -> saved address array.
- `POST /api/account/addresses` and `PATCH /api/account/addresses/:id` use `{label,line1,line2?,city,postcode}` and return `{id,label,line1,line2?,city,postcode,createdAt,updatedAt}`. Maximum ten per user.
- `DELETE /api/account/addresses/:id` -> `{deleted:true}`. Addresses are user-isolated and are snapshots only when copied into an order.

Account export includes preferences, sessions without token or network data, and saved addresses.

## Merchant readiness

- Owner: `GET /api/restaurant/restaurants/:id/readiness`.
- Admin: `GET /api/admin/restaurants/:id/readiness`.
- DTO: `{ready,checks:{contact,address,hours,usableMenu,fulfillment}}`.

New approvals require all checks. Existing approved demo fixtures remain approved. Contract acceptance is excluded pending the commercial policy decision.

## Merchant images

- Owner-only `POST /api/restaurant/restaurants/:id/cover` and `POST /api/restaurant/restaurants/:id/menu/:itemId/photo` body `{mimeType,dataBase64}`.
- Matching `DELETE` routes remove the current image and return `{removed:true}`.
- Upload returns `{id,url,mimeType,width,height}`. Only signature-valid JPEG/PNG images up to 1 MiB decoded and bounded dimensions are accepted. Data is canonicalized and stored in SQLite; SVG, URLs and filesystem paths are rejected. Restaurant storage is capped.
- `GET /api/media/:id` serves bytes only when the restaurant is approved and not suspended, or the requester is its owner/admin. Media responses use `nosniff`, sandbox CSP and `no-store`.
- Restaurant DTOs add `coverImageUrl`; menu items add `photoUrl`, each nullable.

## Menu ordering and import

- `PUT /api/restaurant/restaurants/:id/menu/order` body `{itemIds:string[]}` requires the exact permutation of all restaurant item IDs and returns the ordered menu DTO array.
- `POST /api/restaurant/restaurants/:id/menu/import` requires `Idempotency-Key` and body `{items:[...]}` with 1–100 complete menu-create objects. The authenticated import body limit is 256 KiB. It validates the entire batch and inserts atomically without overwriting existing items. Replay returns the original created items; changed payload conflicts.
- Public and owner menu lists use persisted `sortOrder`, then creation order.

New tailored-offer campaigns may target only eligible customers whose `merchantOffers` preference is true. Existing grants are retained. Owner customer-directory rows add `merchantOffers`.
