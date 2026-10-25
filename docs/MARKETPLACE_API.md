# Marketplace API (frozen additive contract)

All money is integer GBP pence. Timestamps are UTC ISO strings. Existing endpoints and response shapes remain unchanged. New list responses use `{data:{items,nextCursor}}`; single resources use `{data:...}`. Financial records expose `providerMode: "local_simulator"|"stripe_test"`, never an unverified paid/payout claim.

## Finance

Owner-only routes:

- `GET /api/restaurant/restaurants/:id/finance/summary?from&to` → `{data:{restaurantId,currency,providerMode,grossSalesMinor,commissionMinor,refundsMinor,adjustmentsMinor,netEarningsMinor,cashCollectedMinor,cashCommissionOutstandingMinor,pendingMinor,availableMinor,heldMinor,paidTransfersMinor,inTransitTransfersMinor,historicalGrossSalesMinor,historicalCommissionMinor,historicalNetEarningsMinor,nextPayout}}`. Gross recognises mock-card capture and accepted cash orders once; `cashCollectedMinor` recognises the later completed restaurant-held cash sale. Gross and commission totals include the explicitly labelled historical fields for preserved orders created before marketplace operations existed. `pendingMinor` is the current merchant net of non-cash orders not completed; `availableMinor` is completed card merchant net less card holds and paid/in-transit payouts; `heldMinor` is per-order merchant net under an explicit settlement hold. Cash never enters card availability, so restaurant-held cash is not subtracted from it again.
- `GET /api/restaurant/restaurants/:id/finance/orders?cursor&from&to` → `{data:{items:[OrderFinance],nextCursor}}`.
- `GET /api/restaurant/restaurants/:id/finance/payouts?cursor` and `GET .../payouts/:payoutId` → payout DTOs with `status`, included postings, provenance, failure and required-action fields.
- `GET /api/restaurant/restaurants/:id/finance/statement.csv?from&to` → CSV. Oversized reports return `202 {data:{jobId,status:"queued"}}`; `GET /api/report-jobs/:id` returns scoped status and a download URL only when complete.
- `GET /api/restaurant/restaurants/:id/finance/commission-policy` and `POST .../commission-policy/accept` (owner, `Idempotency-Key`) expose/accept the current development agreement. Policy DTO: `{id,rateBasisPoints,base:"food"|"food_plus_delivery",startsAt,endsAt,durationMonths,version,developmentAssumption,acceptedAt}`.
- `GET/POST /api/restaurant/restaurants/:id/finance/cash-mandate`; POST `{action:"create"|"authorize_simulation"|"revoke"}` with `Idempotency-Key`.
- `POST /api/restaurant/restaurants/:id/finance/cash-collections` with `{amountMinor,outcome?:"succeeded"|"failed"|"delayed"}` and `Idempotency-Key`. Only an authorised mandate can collect; simulation is labelled.

Admin-only routes mirror summaries/details under `/api/admin/finance/restaurants/:id/...`; `GET /api/admin/finance/summary?from&to`, `GET /api/admin/finance/exceptions?cursor`, and `POST /api/admin/finance/workers/run` provide aggregate cost/margin, exceptions and an explicit local worker cycle.

Additional read-only admin surfaces are `GET /api/admin/users` → `{data:[{id,name,email,role,phone,emailVerified,createdAt}]}`, `GET /api/admin/restaurants/:id/menu` → `{data:{restaurant,items}}`, `GET /api/admin/restaurants/:id/devices` → `{data:{printers,devices,jobs}}` with no credentials/receipt payloads, and sanitized `GET /api/admin/operational-settings` → `{data:{runMode,paymentProviderMode,secureCookies,bodyLimit,workerMode:"explicit_local_cycle"}}`. User suspension is not invented; restaurant suspension remains the existing reviewed control.

`OrderFinance` contains `{orderId,restaurantId,orderTotalMinor,foodMinor,deliveryMinor,refundsMinor,commissionMinor,providerCostMinor,merchantNetMinor,paymentMethod,paymentState,settlementState,holdReason,policySnapshot,providerMode,createdAt}`. Journal/posting DTOs are append-only and include `{id,operationKey,groupId,account,direction,amountMinor,currency,sourceType,sourceId,providerMode,createdAt}`.

## Provider boundary

The default deterministic adapter is `local_simulator`. Stripe is `stripe_test` only and rejects live keys/mode. Provider onboarding status is informational until capability/requirements confirmation: `GET/POST /api/restaurant/restaurants/:id/finance/provider-account`, POST `{action:"create_test"|"refresh"}`. Return URLs never mark onboarding complete. No API accepts credentials. Persisted Stripe-test results distinguish operation `status` from `paymentState`; only `paymentState:"captured"` establishes capture, and settlement additionally requires provider availability evidence (`latestChargeId`/`availableOn`). Generic `status:"confirmed"` never turns an authorised-only payment into captured funds.

## Refund cases

- `POST /api/refund-cases` `{orderId,reason,itemIds?,description}` where reason is `missing_items|incorrect_items|quality|non_delivery|other`.
- `GET /api/refund-cases?cursor`, `GET /api/refund-cases/:id`.
- `POST /api/refund-cases/:id/evidence` `{mimeType:"image/png"|"image/jpeg",dataBase64}`; `GET /api/refund-cases/:id/evidence/:evidenceId` is private and access checked.
- `POST /api/refund-cases/:id/reply` `{message}` is customer-only while awaiting customer information.
- Admin `GET /api/admin/refund-cases?cursor`, `GET /api/admin/refund-cases/:id`, `POST .../:id/actions` `{action:"under_review"|"request_information"|"ask_restaurant"|"internal_note"|"reopen",message}` and `POST .../:id/decision` `{decision:"approve"|"partial"|"reject",amountMinor?,reason,remedy:"refund"|"goodwill",cashRepayment?:{responsibility,method,confirmationEvidence}}` with `Idempotency-Key`.
- Cash approval stops at `awaiting_cash_return`. Admin `POST /api/admin/refund-cases/:id/cash-confirmation` `{responsibility,method,confirmationEvidence}` with `Idempotency-Key` is the separate acknowledgement step; only then is the cash return recorded and the case marked refunded.
- Owner-only `GET /api/restaurant/restaurants/:id/refund-cases?cursor`, `GET .../:caseId`, and `POST .../:caseId/reply` `{message}`.

Case DTO: `{id,reference,orderId,restaurantId,status,reason,itemIds,description,requestedAmountMinor,approvedAmountMinor,remedy,reviewFlags,evidence,messages,events,execution:{status,providerMode,operationId,error},createdAt,updatedAt}`. Role filtering removes internal notes and cross-restaurant/customer history. Submission does not move money. Approval reserves the refundable amount and queues execution; only confirmed execution yields `refunded`.

## Printers/devices

- Owner-only `GET/POST /api/restaurant/restaurants/:id/printers`, `PATCH .../printers/:printerId`, `POST .../printers/:printerId/pairing-code`, `POST .../printers/:printerId/reprints` `{orderId}`.
- Create printer `{name,enabled}`; patch `{name?,enabled?,revoked?}`. Pairing response `{data:{code,expiresAt}}` returns the single-use code once. Receipt v1 is `{format:"cal-eats-receipt-v1",orderNumber,restaurantName,fulfillment,createdAt,customerName,customerPhone?,deliveryAddress?,items:[{name,quantity,unitPriceMinor,totalMinor,modifiers:[{name,priceMinor}]}],orderNotes?,allergyNotes?,subtotalMinor,deliveryFeeMinor,totalMinor,currency:"GBP",paymentStatus}`.
- Public pairing `POST /api/devices/pair` `{code,name}` → `{data:{deviceId,token,restaurantId,printerId}}`, returning the opaque token once.
- Device bearer-token routes: `POST /api/devices/heartbeat` `{}`; `POST /api/devices/jobs/claim` `{}` → `{data:{job:null}}` or `{data:{job:{id,claimToken,leaseExpiresAt,attempt,receipt,manualReprint}}}`; `POST /api/devices/jobs/:id/ack` `{claimToken,outcome:"printed"|"failed"|"uncertain",detail?}`.

Device tokens and pairing/claim tokens are stored hashed. Claims are atomic leases. `uncertain` is terminal until an owner explicitly creates a labelled reprint; the API never infers physical success.

## Preparation estimates

Restaurant owner/staff may `PATCH /api/restaurant/orders/:id/preparation` with `{estimatedReadyAt}` while an order is accepted/preparing. Order DTOs add nullable `estimatedReadyAt`; snapshots and existing status semantics remain unchanged.

## Provenance and exclusions

The printer job-state vocabulary and provider uncertainty state-machine concept are adapted from original Calai commit `ab138fd17c9ac4fc6e0b34ef5044754be643056c` (`Printer`/`PrintJob` models and `card-payment-transfer.js`). Implementations are newly written against Cal-Eats authorization, hashed credentials, integer money and durable SQLite transactions. No original route, credential, host, voice/call model, webhook, floating-point money code, deployment script or runtime connection is copied or executed.

## Native customer sessions

Native sessions are customer-only opaque bearer credentials stored hashed and revocable server-side. Browser cookies remain unchanged. Native routes do not use cookies and require `Authorization: Bearer <token>` after login:

- `POST /api/native/auth/register` `{name,email,password}` → `{data:{user,token,expiresAt}}`.
- `POST /api/native/auth/login` `{email,password}` → the same DTO; only customer accounts may use this surface.
- `GET /api/native/auth/me` → `{data:{user,session:{id,createdAt,expiresAt}}}`.
- `POST /api/native/auth/logout` `{}` revokes the presented token.
- `POST /api/native/auth/forgot-password` `{email}` always returns `{data:{accepted:true,delivery:"local_simulation"}}`; local-only mail sink behavior remains honest.
- `POST /api/native/auth/reset-password` `{token,password}` uses the same single-use reset token semantics and revokes all browser/native sessions.
- `GET /api/native/account/export` returns the caller's existing sanitized account export.
- `POST /api/native/account/deletion-request` `{reason}` creates the existing reviewable deletion request; it does not silently erase financial/legal records.

Existing customer business endpoints accept either the existing cookie session or a valid native bearer session and apply the same customer ownership/role rules. Native bearer credentials never authenticate restaurant/admin/device routes, are never returned by `/me` or exports, and do not bypass body/rate/Host controls. Origin is required for browser cookie writes; native bearer writes may omit Origin, but a supplied mismatching Origin is still rejected. This is a local single-instance implementation, not a multi-instance capacity claim.

Real provider/device activation remains outside this additive contract. SQLite results do not establish multi-instance PostgreSQL capacity.
