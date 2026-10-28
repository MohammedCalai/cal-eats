# Restaurant confirmation, customer ETA and three-minute escalation

Migration 26 adds durable merchant-visibility, confirmation and escalation records. It does not accept orders automatically, create real payments or reuse original Calai infrastructure or secrets.

## Confirming an order

`PATCH /api/restaurant/orders/:orderId/status` now accepts:

```json
{"status":"accepted","estimatedReadyAt":"2026-10-28T18:45:00.000Z"}
```

The historical field name remains `estimatedReadyAt`. On confirmation it represents expected **arrival** for delivery and **ready for collection** for collection. Explicit estimates must be valid ISO timestamps after server time and no more than 24 hours ahead. Legacy clients omitting an estimate receive a default from that restaurant's delivery/collection estimate plus its busy allowance. Current clients should always show the proposed estimate and require the owner to confirm it.

ETA validation and current membership checks happen before any Stripe capture/cancellation request. The existing durable Stripe accept/reject claims, authoritative provider bindings, idempotent capture keys and refund checks remain in use. An ambiguous capture leaves the order unconfirmed; an unpersisted request-body ETA must never be shown as agreed. Accepted status, the agreed ETA and `confirmed_at` commit together. A repeated accept returns the original committed ETA, even if a retry supplies a different estimate. Deliberate changes use the existing preparation endpoint.

`PATCH /api/restaurant/orders/:orderId/preparation` with `{estimatedReadyAt}` changes an accepted/preparing order's ETA, emits one customer update for an actual change and preserves idempotent identical retries. It does not confirm a placed order.

Order DTO additions:

- `merchantVisibleAt`, `confirmationDueAt` and `confirmedAt`.
- `customerEtaAt`, `customerEtaType` (`delivery_arrival|collection_ready`) and `defaultCustomerEtaMinutes`.
- `confirmationOverdue` and `confirmationState` (`awaiting_payment|awaiting_confirmation|confirmed|closed`).

The customer receives **Order confirmed** with the agreed estimate after successful confirmation, and **Out for delivery** after the explicit delivery transition. Collection and delivery keep their existing status paths. Status `accepted` is retained in storage and APIs for compatibility; customer wording is confirmed.

## Pending-order queue

`GET /api/restaurant/orders/pending-confirmation` returns `{data:{items,total,limit:100}}` across the caller's current restaurant memberships. Optional `restaurantId` is membership checked and scopes both the total and the bounded result, so another restaurant cannot consume the selected restaurant's queue allowance. Only placed, merchant-visible, payable orders are included. Unpaid Stripe checkout sessions are excluded.

The existing own-restaurant orders endpoint additionally accepts `page`, `pageSize` (maximum 100) and `status=all|placed|accepted|preparing|ready|out_for_delivery|completed|rejected`. Supplying page controls returns `{data:{items,pagination}}`; the old no-page array response is preserved. All forms retain existing card-authorization visibility filters and tenant checks.

## Escalation clock and durable delivery

The three-minute clock starts when `notifyNewOrder` first makes an order actionable to the restaurant. Cash and simulator orders start immediately. Stripe starts only after a verified authorization/capture makes the placed order payable. Duplicate notifications/webhooks cannot reset that clock. Existing rows are backfilled from their earliest new-order notification where present; Stripe fallback uses its known verified-state update timestamp rather than its original checkout creation time.

The alert worker checks every five seconds and catches overdue orders after restart. At 179 seconds no escalation is due; at 180 seconds the order becomes eligible. Each order has one unique escalation record and one deduplicated platform-administrator in-app notification. Queue processing is bounded, so transport or backlog can add delivery time beyond the threshold; there is no guarantee that a remote inbox receives an email at an exact millisecond.

The durable `order_confirmation_email_outbox` stores a safe short order reference, restaurant business name/phone and an administrator review link. Customer names, contact details, delivery addresses, card and payment details are omitted. Worker leases prevent competing dispatch. Current order state is checked before claiming, after claiming and at the transport's final `beforeSend` boundary. Confirmation, rejection or expiry before dispatch cancels unsent delivery. A stable Message-ID aids operator reconciliation but is not treated as an SMTP idempotency guarantee.

Statuses are `pending`, `claimed`, `local_saved`, `sent`, `failed`, `unknown`, or `cancelled`. A known pre-dispatch/configuration failure remains failed. An uncertain network outcome or an expired lease after dispatch began remains unknown and is **never blindly resent**. Recovered leases that never started dispatch can safely return to pending. Switching email modes does not silently promote an old local pending record into an external send. Once dispatch has begun it cannot be recalled; the recorded result remains visible even if the restaurant confirms shortly afterwards.

`GET /api/admin/order-confirmation-alerts?page=1&pageSize=25` exposes bounded records, current order state, attempt/error information, status totals and sanitized email readiness. It never returns passwords. This is an administrator-only view. There is no public endpoint that triggers sends or bypasses these state checks.

## Email connection boundary

The default is a private **local mailbox sink**, writing one deterministic `.eml` file under the database directory's `local-mail/order-alerts` folder. `local_saved` does not mean an email was sent. The independently connected desktop Outlook plugin does not grant the deployed app persistent mailbox access.

Configuration names are `CALAI_ORDER_ALERT_EMAIL_MODE=local|smtp|off`, `CALAI_ORDER_ALERT_RECIPIENT`, `CALAI_ORDER_ALERT_FROM`, and `CALAI_ORDER_ALERT_LOCAL_DIRECTORY`. No personal recipient is hardcoded. The recipient is selected by the owner and belongs in private runtime configuration. Missing local-recipient configuration uses an invalid demonstration address and never sends externally.

The optional SMTP transport additionally requires explicit `CALAI_ORDER_ALERT_SMTP_ENABLED=true`, host, port, user and private password settings. No SMTP host is assumed from the domain registrar; the default host is empty. Its reviewed allowlist currently permits only explicit IONOS SMTP endpoints, using port 465 implicit TLS or port 587 required STARTTLS, verified certificates and TLS 1.2 or newer. It is a future optional adapter, not evidence that the current mailbox uses IONOS. The selected mailbox is Microsoft 365; a separately approved Microsoft Graph/OAuth runtime adapter is the intended connection route unless the owner explicitly chooses a different verified service. This code provides no Microsoft basic-password SMTP workaround and does not read desktop-plugin tokens or original Calai secrets. [IONOS SMTP documentation](https://www.ionos.co.uk/help/email/general-topics/ionos-mail-server-details-for-imap-pop3-and-smtp/) documents the optional transport settings.

Transport interface: `async (message, {beforeSend}) => {status,errorCode?}`. An externally sending adapter must call the supplied synchronous `beforeSend()` immediately before initiating transmission and cancel if false. Credentials and raw provider errors must not be logged or returned. `sent` means accepted by the sending server, not confirmed inbox arrival or reading. Configuration readiness is not a live connection test.

## Focused verification

Five changed-area tests passed: atomic/default/updated customer ETA and confirmed/delivery notifications; 179/180-second boundary and delayed Stripe visibility; cancellation on confirmation/rejection/expiry after claim; failed/unknown state without blind retry and expired-lease recovery; explicit safe SMTP settings using an injected fake transport. Two targeted existing Stripe regressions also passed: full authoritative checkout/capture/onboarding idempotency and capture-timeout recovery without a second capture. No external SMTP connection or real automated email was sent by these checks.
