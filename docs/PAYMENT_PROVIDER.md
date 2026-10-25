# Stripe test-only provider boundary

## Status

`apps/api/src/payments/stripe-test.js` is a dependency-free Node 24 HTTP adapter for a future, separately authorised Stripe sandbox integration. It has not made a Stripe request, received credentials, processed a payment, created an account, registered a webhook, or activated a provider. The existing deterministic local simulator remains the default.

The adapter pins Stripe API version `2025-06-30.basil`, the version identified by the official [Stripe API versioning reference](https://docs.stripe.com/api/versioning). Changing the pinned version requires a contract review and sandbox regression run; it must not silently inherit an account default.

## Provider interface

`createStripeTestAdapter(config)` requires an `sk_test_` secret supplied only to server configuration and refuses live keys or non-test mode. No route accepts provider credentials. The returned frozen object exposes:

- connected accounts: `createConnectedAccount`, `refreshConnectedAccount`, `createAccountLink`;
- payout policy: `configureWeeklyPayouts`;
- card funds: `authorizePayment`, `capturePayment`, `cancelPayment`, `retrievePayment`;
- marketplace movement: `refundPayment`, `createTransfer`, `retrieveTransfer`, `reverseTransfer`;
- cash-commission mandate: `createCustomer`, `retrieveCustomer`, `createCashMandateSetup`, `retrieveSetupIntent`, `retrieveMandate`, `collectCashCommission`, `retrieveCashCollection`;
- payout reconciliation: `listPayouts`, `retrievePayout`.

Foundation’s required methods return normalized `{ok,status,providerReference?,providerCostMinor?,capabilities?,requirements?,errorCode?}`. `status` is `confirmed`, `pending`, `failed`, or `unknown`. Payment results additionally distinguish `paymentState` (`authorized`, `captured`, `cancelled`, `action_required`, `processing`, `requires_confirmation`, `requires_payment_method`, or `unknown`), so a successful cancellation operation is not misreported as a failed cancellation. Expanded retrieval exposes the latest charge, actual balance-transaction fee and fund-availability timestamp when Stripe supplies them. Hosted onboarding additionally returns a single-use `actionUrl`; SetupIntent creation returns its client secret for a future reviewed Stripe.js confirmation flow. Neither value indicates onboarding or a mandate completed.

All mutations require a bounded operation-level idempotency key and send `Idempotency-Key`. The caller must persist the same operation key across retries. Network errors, timeouts, HTTP 409/429/5xx and Stripe API errors are `unknown`, never falsely marked failed. The caller reconciles unknown results with the corresponding retrieve method before retrying money movement.

The adapter imports no database code. Provider calls belong outside SQLite transactions. Foundation persists normalized results, provider references, journal postings and reconciliation work in a separate transaction.

## Payment and marketplace model

Card authorization creates one PaymentIntent for the order, confirms it with `capture_method=manual`, and captures only after restaurant acceptance. Cancellation is explicit. The adapter accepts only server-side integer GBP pence and pre-tokenized PaymentMethod references; it never accepts PAN, bank details or a secret key from a browser.

Transfers use Connect separate charges and transfers, associated by a server operation group and the captured charge as `source_transaction`. The caller must wait for the authoritative captured charge and persist that reference before transfer creation. Stripe documents that the platform is responsible for refund/transfer reconciliation: refunding a platform charge does not automatically reverse associated transfers. The adapter therefore exposes refund and transfer reversal as distinct idempotent operations. See [Stripe separate charges and transfers](https://docs.stripe.com/connect/separate-charges-and-transfers) and [transfer reversals](https://docs.stripe.com/api/transfer_reversals/create).

Connected-account onboarding uses an Express account and a single-use hosted Account Link. A return URL is never treated as completion; `refreshConnectedAccount` checks enabled capabilities and outstanding requirements. See [Account Links](https://docs.stripe.com/api/account_links/create).

`configureWeeklyPayouts` configures Stripe’s automatic weekly connected-account payout schedule through Balance Settings and a connected-account header. The application must not run a second bank-payout scheduler. Its local workers may establish transfer eligibility, create transfers and reconcile results, but must not create competing Payout objects. See [automatic payout schedules](https://docs.stripe.com/connect/manage-payout-schedule).

## Bacs cash-commission collection

Cash-order commission is a platform receivable, never bank-payout funds. `createCashMandateSetup` creates a Bacs Direct Debit SetupIntent for `off_session` reuse. A separately reviewed Stripe.js/hosted flow must collect the bank details and mandate acceptance directly with Stripe; the API must never receive those details. A successful SetupIntent and returned mandate/payment-method references are prerequisites to `collectCashCommission`, which creates an off-session Bacs PaymentIntent.

Bacs processing is asynchronous. `processing` remains pending, and webhooks or retrieval must establish success or failure. The system must retain the mandate reference, customer authority, required notices and evidence; the adapter alone does not establish regulatory compliance. See the official [SetupIntent reference](https://docs.stripe.com/api/setup_intents) and Bacs Direct Debit documentation before sandbox activation.

## HTTP and secret controls

- The default origin is exactly `https://api.stripe.com`; a custom origin is permitted only when an injected mock transport explicitly enables it for unit tests.
- Requests use a bounded timeout and `redirect: "error"`.
- Live keys, live objects and live webhook events are rejected.
- The adapter never logs request headers, keys, client secrets, webhook secrets or response bodies.
- Mutation input is form encoded with bounded IDs, metadata and amount validation. Currency is fixed to GBP.
- Secret keys remain adapter-constructor state and are not included in normalized results or errors.

## Webhooks

`verifyStripeWebhook` requires the exact raw request bytes captured before JSON parsing, a `whsec_` endpoint secret, a signed timestamp within the default five-minute tolerance, and at least one matching v1 HMAC-SHA256 signature. Comparison uses `timingSafeEqual`. `parseStripeWebhook` verifies first, then parses, rejects malformed events and rejects every event whose `livemode` is not exactly `false`.

The route integration must persist and deduplicate event IDs before applying transitions, return success for already-processed retries, and retrieve the provider object when an event or request outcome is ambiguous. Stripe explicitly requires the unmodified raw request body and signature header; see [webhook signature guidance](https://docs.stripe.com/events/manage-webhook-endpoints#signature-errors).

The adapter does not expose an HTTP webhook route, because foundation owns routing, raw-body limits, persistence, idempotent event handling and state transitions.

## Required sandbox verification before activation

The implementation currently has mocked-HTTP unit coverage only. Before enabling `stripe_test`, a separately authorised sandbox exercise must prove:

1. Express account creation, hosted onboarding, return/refresh behavior, capability refresh and weekly automatic payout configuration.
2. Manual PaymentIntent authorization, restaurant-acceptance capture, rejection cancellation, authentication-required and declined paths.
3. Separate transfer creation, delayed availability, insufficient platform balance, partial/full refund and independent partial/full reversal.
4. SetupIntent mandate completion, required Bacs notices, off-session collection success, asynchronous failure, revocation and duplicate callbacks.
5. Timeout-after-provider-commit reconciliation for every mutation, replay with the same idempotency key, and conflict handling.
6. Raw-body webhook verification, rotation strategy, duplicate/out-of-order events and retrieval recovery.
7. No live key, live event, live object, browser-supplied credential or non-GBP amount can cross the adapter boundary.

Until this evidence exists, UI and records must say `stripe_test`, pending, test, or simulated as appropriate—never paid, verified, transferred or refunded merely because a request was attempted.
