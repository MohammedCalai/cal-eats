# Stripe payments and restaurant payouts

## Current status — 28 October 2026

The customer app, business tablet platform and Cal-Eats Admin source share the independent Cal-Eats payment APIs. Administrator tools are a restricted role within the business platform. The current hosted preview at `eats.calai.info` is deployed and still selects `local_simulator`, with live payments disabled. The owner selected the **Cal-Eats sandbox within the existing Calai Stripe account**. Dashboard verification confirmed a separate sandbox (not shared test mode), account `acct_1UVAdqHSgkhglViC`, with live mode unavailable. An owner-approved restricted sandbox key was created and a real read-only API call confirmed the same account ID and GB country. The API reported `charges_enabled=false` and `payouts_enabled=false`; the owner deferred Stripe's owner/director verification task. Signed-webhook and end-to-end payment verification remain pending; no real charge, transfer, refund or bank payout was created. Original Calai live payments remain untouched.

Owner bank/payout visibility and per-order financial breakdowns are now implemented in [Business finance details](BUSINESS_FINANCE_DETAILS.md). Bank data is masked, bank editing stays in Stripe Express, expected payout arrival and paid-event dates remain distinct, and order commission/promotion/refund calculations use immutable snapshots. Simulator mode does not invent a connected bank or actual paid payout. Hosted service email has separately been connected; this does not activate Stripe payments or payouts.

## Customer payment and restaurant earnings

Card checkout is hosted by Stripe; Cal-Eats never accepts card numbers or bank details. The server prices the basket, reserves an eligible restaurant-funded offer and creates a pending order. One server-owned idempotency key identifies that order's Checkout Session, even if the browser changes its retry key. Customers can continue an interrupted checkout or refresh its authoritative payment status.

The PaymentIntent uses manual capture. A verified authorization makes the order visible to the restaurant and produces its new-order notification. Restaurant acceptance captures the card; a durable per-order decision claim serializes acceptance and rejection. Confirmed capture, cancellation and amounts are retrieved from Stripe rather than inferred from a return URL. Abandoned sessions and authorizations are expired/cancelled before releasing the offer. A captured payment discovered during expiry is preserved for reconciliation.

The agreed 7% rate and the order's accepted food or food-plus-delivery commission basis remain unchanged. Discounts reduce the charged food; immutable allocations govern refunds. A £20 commissionable sale yields £1.40 gross platform commission and £18.60 restaurant earnings before later refunds. Processing fees are borne by the platform under the existing model, so gross commission is not profit. Actual Stripe balance-transaction fees are reconciled separately; missing fees remain pending rather than being invented.

## Restaurant Connect onboarding and payouts

Owners use **Stripe setup** in the restaurant portal. Stripe Express collects business verification and bank details on Stripe's own pages. Returning to Cal-Eats does not prove verification. The server refreshes actual charges-enabled and payouts-enabled flags and keeps a mode-bound readiness snapshot. An unverified restaurant cannot accept card orders. Test and live account references cannot be reused across modes.

The integration uses [separate charges and transfers](https://docs.stripe.com/connect/separate-charges-and-transfers). A completed, captured order becomes eligible for a restaurant transfer only when its mode-bound account is ready and no active case blocks settlement. The queue records an immutable source-charge/account/net-earnings snapshot; the worker checks it again before submitting a transfer. Cash is excluded. Duplicate retries use the same provider operation key.

Stripe is configured for weekly automatic bank payouts on Monday. Arrival depends on available funds, verification, Stripe and bank processing; Monday is not a guaranteed arrival date. Cal-Eats does not run a competing bank-payout scheduler. Internal restaurant transfers and actual bank payouts are separate records. The owner sees payout status and expected arrival; administrators can see confirmed bank-payout activity and failures. [Stripe payout schedule guidance](https://docs.stripe.com/connect/manage-payout-schedule).

## Refunds, reversals and recovery

Restaurant-approved and admin-approved card remedies enter the same durable Stripe refund worker. Approval does not create a refund record or claim a successful refund. Pending outcomes retain their provider reference for retrieval; confirmed amounts, currency, PaymentIntent and tenant bindings must match before the case and ledger are finalized. Duplicate events cannot finalize twice.

A platform refund does not automatically reverse a restaurant transfer. Confirmed refunds separately queue the restaurant-funded transfer reversal, net of the documented commission reversal. Each reversal is idempotent and bounded by the original transfer. A failed recovery remains visible for review. Insufficient connected-account funds, already-paid-out money and chargebacks still require the platform's operational ownership; this code cannot guarantee recovery from an empty restaurant balance.

Workers claim one job at a time, recover expired leases and assert ownership inside the same transaction as financial updates. Provider I/O stays outside database transactions. Ambiguous results are retrieved or replayed with the same key; changed settlement snapshots are held for review. Confirmed money state cannot regress to unknown. Simulator workers cannot consume Stripe jobs or simulate a card refund/payout.

Cash orders remain direct payments to the restaurant, with a separate commission receivable and evidenced cash-refund process. The adapter includes a Bacs boundary, but the hosted mandate/notice/collection workflow is **not activated or connected**. Cal-Eats must not claim it has collected cash commission automatically.

## Configuration and activation

`.env.example` documents names only. Secrets belong in private local/server configuration and must never be pasted in chat, committed or returned by an API.

- Default: `CALAI_PAYMENT_PROVIDER=local_simulator` and `CALAI_LIVE_PAYMENTS_ENABLED=false`.
- Sandbox: `CALAI_PAYMENT_PROVIDER=stripe_test`, `CALAI_STRIPE_ACCOUNT_ID`, `CALAI_STRIPE_TEST_SECRET_KEY`, `CALAI_STRIPE_TEST_WEBHOOK_SECRET`, `CALAI_STRIPE_TEST_CONNECT_WEBHOOK_SECRET`.
- Live additionally requires `stripe_live`, explicit live enablement, production hosted HTTPS, the separately confirmed platform account, both live webhook secrets and approved non-demo restaurant commercial terms. A live key cannot be used in test mode or vice versa.
- Platform webhook: `/api/provider-events/stripe-test` or `/stripe-live`.
- Connected-account webhook: the corresponding path followed by `/connect`, with its separate signing secret.

The approved local sandbox key is stored in the ignored `.env.stripe-test` file, separately from the normal simulator settings, with Windows file access restricted to the current user. Run `npm run stripe:sandbox:check` for a read-only identity check. It checks the configured account binding without opening a database or creating payment objects, and prints only safe account/readiness facts. This command does not activate checkout or prove webhook delivery. Do not run the normal server with this file until genuine platform and Connect webhook secrets and onboarding are ready.

The key is named **Cal-Eats local sandbox server**. Owner-approved Write permissions: Checkout Sessions, Payment Intents, Charges and Refunds, Accounts, Account Links, Login Links, Transfers. Read permissions: Balance, Balance Transaction Sources, Payout Settings, Payouts. All other permissions were left None; manual bank payout creation and webhook-management access were excluded. Only account retrieval has been exercised against Stripe, so further permission requirements must be confirmed during the sandbox trial rather than assumed. Credentials remain excluded from Git and Docker.

Next payment prerequisites: the owner completes Stripe's deferred ownership verification task; Connect is enabled/configured for the sandbox; genuine platform and connected-account webhook delivery is connected to the reviewed app. The earlier hosting hold was superseded by the owner's approved preview deployment; source is now deployed independently at `eats.calai.info`. The hosted service remains in simulation until the real provider prerequisites are met. No tunnel or dummy signing secret was used to bypass readiness.

Hosted login follow-up: the saved restaurant account successfully signed in at `/business/login` and reached its owner dashboard on 27 October. At the owner's explicit request, the saved restaurant and administrator login details and customer app link were emailed to the approved recipient through the connected Outlook account. No password was changed. This login check does not deploy the local changes or complete Stripe verification.

Webhook intake checks the signed raw body, timestamp and exact mode, then persists a deduplicated routing envelope. Account updates refresh authoritative readiness; Checkout updates expose payable orders; bank-payout events update actual payout records. Money operations still require immutable provider facts. Use only the selected Cal-Eats sandbox account ID and its sandbox credentials. Original Calai live/shared-test credentials must not be used. Restricted `rk_test_` keys are supported and preferred; their permissions must cover the operations enabled for the sandbox trial. A key alone does not enable card checkout: both genuine webhook signing secrets and account readiness are still required.

The adapter pins `2025-06-30.basil`. Its Balance Settings request uses that version's `payouts[schedule]` fields, not the newer wrapper. Accounts may legitimately omit `livemode`; only an explicitly identified Account object gets that exception. Financial objects must prove the configured mode. References: [pinned Balance Settings API](https://docs.stripe.com/api/balance-settings/update?api-version=2025-06-30.basil), [Account object](https://docs.stripe.com/api/accounts/object?api-version=2025-06-30.basil), [hosted onboarding](https://docs.stripe.com/connect/hosted-onboarding). GBP card orders must meet Stripe's [£0.30 minimum](https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts).

## Verification limits

Local checks use injected provider responses, fictional accounts and the existing API test harness. They verify contracts and money-state invariants, not Stripe account approval or real network behavior. Before live activation, the separate sandbox must demonstrate onboarding, authentication/decline, acceptance capture, cancellation/expiry, partial/full refund, transfer/reversal, payout failure, signed webhooks and ambiguous retry recovery. Real device return behavior and live operating terms remain deployment-stage checks. Source and fake-provider checks do not establish live Stripe readiness or store approval.

Local verification completed: focused payment, webhook, transition, refund, settlement, reporting and simulator-regression tests passed; portal production build, native type checking and release packaging passed (79 JavaScript files and 21 required release files). Migration 22 on an isolated copy preserved 4 users, 2 restaurants, 3 menu items, 5 orders, 6 order items and 2 dispute cases, with zero foreign-key violations and SQLite integrity OK. Temporary messages were excluded by the managed backup used for the copy. The normal local database and hosted deployment were not changed.
