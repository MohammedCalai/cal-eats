# Test provider events and reconciliation

This module is an intentionally unregistered integration boundary for Stripe **test mode only**. It adds durable webhook intake and read-only provider reconciliation without changing Cal-Eats' default `local_simulator` behaviour. It contains no key, performs no call during migration or import, and does not make a simulated order provider-paid.

## Integration contract

Migration v17 is exported by `apps/api/src/payments/provider-events-migration.js`:

- `PROVIDER_EVENTS_MIGRATION_VERSION` (`17`)
- `PROVIDER_EVENTS_MIGRATION_SQL`
- `PROVIDER_EVENTS_MIGRATION`
- `applyProviderEventsMigration(db)` for isolated tests

The SQL is idempotent and creates only `provider_events` and `provider_event_object_state`. The foundation migration sequence must register `PROVIDER_EVENTS_MIGRATION`; the helper deliberately does not write `schema_migrations`.

The route export is:

```js
await routeProviderEventWebhook({ req, res, url, db, config });
```

It returns `false` for every path except `POST /api/provider-events/stripe-test`; a handled request returns `true`. It must be called after the existing Host check but **before** session lookup, origin enforcement, JSON parsing, or any other body consumer. The handler owns a bounded raw-body read. Its successful response is:

```json
{"data":{"received":true,"eventId":"evt_...","status":"queued","replayed":false}}
```

The worker export is asynchronous:

```js
await runProviderEventReconciliation(db, config, {
  workerId, limit, maxAttempts, leaseMs, baseBackoffMs
});
```

It returns counters named `claimed`, `completed`, `delayed`, `failed`, `unmatched`, and `ignored`. In simulator mode it returns the zero counters plus `skipped: "provider_disabled"`. It can be called from the existing explicit worker cycle. Claims and final writes use short database transactions; every provider retrieval is awaited between them, never while a transaction is open. Leases make concurrent cycles safe, while expired leases and a terminal max-attempt guard make crashes recoverable without an endlessly claimed row.

Required configuration, only when `paymentProviderMode === "stripe_test"`:

- `paymentProvider`: the existing `StripeTestAdapter` (or a local injected fake in tests)
- `paymentProviderWebhookSecret`: a test endpoint secret beginning `whsec_`
- optional `providerWebhookBodyLimit`: 1 KiB to 1 MiB; default 256 KiB

No webhook setting is needed in `local_simulator`; the endpoint rejects the request before reading or writing, and the worker makes no provider call.

## Intake safety

The route verifies the signature against the exact raw bytes with the existing five-minute tolerance. Missing, invalid, stale, malformed, or live-mode events are rejected before any event row is written. An accepted event stores a SHA-256 payload fingerprint and a small normalized routing envelope, not the raw provider payload. Reuse of an event ID with the identical fingerprint is an acknowledged replay; reuse with different bytes is a conflict.

Supported routing families are connected accounts, payment intents (including charge/refund notifications routed to their payment intent), transfers, payouts, setup intents, and mandates. Other signed test events are durably marked ignored. A supported event is mapped through existing test-mode provider references before any adapter call. Missing mappings are retried with exponential backoff and deterministic jitter, then marked unmatched. Duplicate mappings, connected-account disagreement, or cross-tenant object state are terminal conflicts and never reach the adapter.

## Reconciliation rules

Webhook payload fields are not treated as proof of money movement. A supported notification triggers the appropriate current-state retrieval on the existing adapter:

- `refreshConnectedAccount`
- `retrievePayment`
- `retrieveTransfer`
- `retrievePayout` scoped to the mapped connected account
- `retrieveSetupIntent`
- `retrieveMandate`

Only existing rows whose `provider_mode` is `stripe_test` can change. Reconciliation may update `provider_accounts`, `marketplace_operations`, `payout_batches`, or `cash_mandates`. It never updates `orders.payment_status`, inserts journal postings, creates transfers/refunds/payouts, or changes a `local_simulator` row. Provider fees are recorded only as observed operation metadata; no ledger entry is inferred from them.

Captured payment operations and paid payouts cannot be regressed by later retrieval results. Per-object state records the greatest applied provider event time; an older out-of-order event is completed as stale without another provider call. Events sharing the provider's one-second timestamp are allowed to retrieve current state, because provider event IDs do not define a trustworthy order. Ambiguous network/provider results remain delayed until the bounded attempt limit instead of being converted to success or a definitive financial failure.

The existing `cash_mandates.provider_reference` has room for only one provider object. A successful setup-intent reconciliation promotes it from the setup-intent reference to the returned mandate reference. That supports subsequent mandate events but means later notifications for the superseded setup-intent reference are safely unmatched. Direct cash-collection reconciliation is limited to its mapped `marketplace_operations` payment-intent record because `cash_collections` has no provider-reference column.

## Verification and limits

`apps/api/test/provider-events.test.js` uses only in-memory/local SQLite state, signed local buffers, and injected adapter responses. It covers rejection before writes, replay/fingerprint conflict, retrieval outside transactions, captured-funds non-regression, out-of-order events, an offline/restart retry, and complete simulator-mode inactivity. No test contains credentials or contacts Stripe.

This is not a production payment launch. Provider endpoint creation, secret provisioning/rotation, HTTPS exposure, Stripe dashboard configuration, live credentials, real webhooks, deployment, and operational alerting remain explicitly out of scope. Enabling any of those requires a separate security and financial-readiness review.
