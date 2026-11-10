# Cal-Eats payment launch preparation

Reviewed 6 November 2026. The hosted preview remains in test mode; this change does not enable real charges.

## Money calculation

- Standard commission is 700 basis points (7%). Its base is food after restaurant-funded discounts plus the delivery fee actually charged.
- Example: £15 food minus £4 restaurant offer plus £2 delivery gives a £13 base, £0.91 commission and £12.09 restaurant earnings.
- A restaurant's disabled commission or active commission-free period produces a zero rate for new orders. Existing orders retain their saved rate and figures.
- Cal-Eats-funded vouchers reduce customer payment without reducing the restaurant's entitlement or the commission base. Cal-Eats must fund that difference.
- Normal processing, Connect and bank-payout costs belong to Cal-Eats. Provider costs are recorded separately and are not deducted again from restaurant earnings.
- Checkout authorises the card. Restaurant confirmation captures it. Completion makes the saved restaurant net eligible for transfer; a transfer to a payment balance is distinct from a bank payout.
- Provider calls use persisted operation keys and verified order/account/amount bindings. Workers claim, recover and fail only jobs belonging to their configured test or live mode.

Focused fixtures cover the discounted delivery example, zero commission, a platform voucher, separate processing costs, duplicate confirmation/transfer protection and preservation of foreign-mode jobs. They also place an order during a scheduled free period, confirm/complete it after expiry and verify that its commission stays zero while a new order returns to 7%. They make no real provider transactions.

Hosted Checkout explicitly offers the supported card method with manual capture. The adapter keeps Stripe API `2025-06-30.basil` pinned; weekly bank setup sends the legacy `payouts[schedule][weekly_anchor]` field and verifies the saved Monday schedule before reporting success. Singular weekly/monthly anchors are normalised into the existing app schedule arrays. Live Stripe rejected the former array request with a version-gate error requiring `2025-07-30.preview` or newer; generated version-selected documentation did not establish actual support. [Stripe's historical SDK pins Basil](https://github.com/stripe/stripe-node/blob/v18.3.0/src/apiVersion.ts) and [retains the legacy anchor fields](https://github.com/stripe/stripe-node/blob/v18.3.0/types/AccountsResource.d.ts). This compatibility fix does not upgrade the payment API or change bank accounts. Schedule retries use a new stable anchor-policy idempotency key; partial setup refreshes the saved restaurant account rather than creating another one. Live startup rejects reused platform/Connect signing secrets.

## Admin visibility

`GET /api/admin/finance/payment-launch?page=1&pageSize=25` is admin-only and read-only. The payment-readiness page shows configuration checks, restaurant bank readiness, accepted commercial terms, effective commission and outstanding test handover. Secret values are never returned. Configuration presence is not proof of a working live connection.

The prospective `CALAI_STRIPE_LIVE_ACCOUNT_ID` is inventory-only: it lets the report show a staged live account without replacing the currently active sandbox `CALAI_STRIPE_ACCOUNT_ID`. It does not switch the runtime.

## Separate Cal-Eats connection

Use a dedicated restricted server key and separate platform/connected-account event connections within the existing approved Calai live account. Keep the original Calai subscription keys, webhook, business profile and platform bank-payout schedule untouched.

Because this uses the existing live Calai account, captured Cal-Eats customer charges enter that same platform Stripe balance. A separate key does not create a separate financial balance. Cal-Eats records the order attribution and retained commission, then transfers each completed order's saved restaurant net into that restaurant's connected-account balance. Available connected-account funds are paid to the restaurant bank on its weekly plan; settlement and bank processing affect arrival. Processing costs are paid from the platform balance.

Prepared live endpoint paths are `/api/provider-events/stripe-live` and `/api/provider-events/stripe-live/connect`. They deliberately reject requests while the runtime is in test mode. Do not claim successful signed live delivery until the reviewed live environment can receive and reconcile it.

Live credentials require explicit approval of their permissions and storage. Keep secrets in private Git-ignored files and the Cal-Eats hosting secret store; never commit or include them in reports.

## Before activating real orders

1. Confirm the restaurant bank-payout schedule. Weekly Monday is currently the development default, not a confirmed live instruction. Do not change Calai's own platform payout schedule.
2. Live mode enforces card-only checkout: the server rejects cash orders even when an older restaurant preference enables cash, and owners cannot enable cash while live mode is active. The business settings and customer payment choices reflect this restriction. Local simulator and sandbox cash testing remain available. Real automatic cash-commission collection is not connected; supporting live cash later requires a separately reviewed collection flow and policy change.
3. Complete genuine restaurant business/bank onboarding and accepted non-demo terms, using the correct commission base. Do not relabel demo agreements as accepted real terms.
4. Design the test-to-live data handover. The current restaurant account table has one active account per restaurant and rejects switching an existing sandbox binding to live. Preserve old account references and pending history, or isolate live data in a separately reviewed environment.
5. Review the launch catalogue and audience. Current testing apps use the same public API; changing that API to live affects those apps too. Fictional demonstration restaurants must not become real checkout destinations.
6. Confirm the live business activity and customer/restaurant payment terms cover the Cal-Eats marketplace as well as Calai's subscription activity. Existing card capability does not establish that this review is complete.
7. Verify the dedicated account identity, minimum permissions, separate signed event delivery, restaurant payout readiness and available platform funding for vouchers/fee costs. Voucher-funded transfers use the platform's available balance. A voucher's internal redemption record does not reserve provider funds; exhausted failed transfers need monitored recovery after funding, rather than an assumption that adding balance automatically requeues them.
8. Review the exact activation change and obtain approval before enabling real payment mode. A real charge or payout is completed by the account holder, not by an unattended test.

The admin report documents these gaps; it does not bypass them or certify the app ready for public launch.

## First real restaurant preparation

The administrator selected Arndale Market Curry Centre (`027d8cb9-f2ee-4aab-b893-1b1e2997c367`) for the first real pilot. It remains collection-only and paused until real menu/prices, business details, accepted non-demo terms and bank onboarding are ready. Sample menu items and offers must not be published as genuine restaurant data. Other catalogue entries are archived reversibly; their orders and financial history remain.

`CALAI_LIVE_ONBOARDING_RESTAURANT_IDS` is an explicit allowlist for real bank preparation through the existing owner finance endpoints. It does not enable real customer checkout, live payment events or live transfer workers. Its provider exposes bank-onboarding and read methods only, without charge/capture/transfer methods. Existing sandbox bindings are refused rather than overwritten.

Before accessing real banking, the owner and every enabled platform administrator must choose new secure passwords through the app. `POST /api/auth/password` verifies the current password, records only a credential fingerprint, revokes other sessions and invalidates old reset links. The banking policy is tied to the current hash, so a subsequent password reset cannot reuse stale approval. The agent does not choose or enter these new passwords. Real financial account creation and bank entry are user initiated.
