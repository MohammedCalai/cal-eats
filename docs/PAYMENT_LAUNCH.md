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

Focused fixtures cover the discounted delivery example, zero commission, a platform voucher, separate processing costs, duplicate confirmation/transfer protection and preservation of foreign-mode jobs. They make no real provider transactions.

## Admin visibility

`GET /api/admin/finance/payment-launch?page=1&pageSize=25` is admin-only and read-only. The payment-readiness page shows configuration checks, restaurant bank readiness, accepted commercial terms, effective commission and outstanding test handover. Secret values are never returned. Configuration presence is not proof of a working live connection.

The prospective `CALAI_STRIPE_LIVE_ACCOUNT_ID` is inventory-only: it lets the report show a staged live account without replacing the currently active sandbox `CALAI_STRIPE_ACCOUNT_ID`. It does not switch the runtime.

## Separate Cal-Eats connection

Use a dedicated restricted server key and separate platform/connected-account event connections within the existing approved Calai live account. Keep the original Calai subscription keys, webhook, business profile and platform bank-payout schedule untouched.

Prepared live endpoint paths are `/api/provider-events/stripe-live` and `/api/provider-events/stripe-live/connect`. They deliberately reject requests while the runtime is in test mode. Do not claim successful signed live delivery until the reviewed live environment can receive and reconcile it.

Live credentials require explicit approval of their permissions and storage. Keep secrets in private Git-ignored files and the Cal-Eats hosting secret store; never commit or include them in reports.

## Before activating real orders

1. Confirm the restaurant bank-payout schedule. Weekly Monday is currently the development default, not a confirmed live instruction. Do not change Calai's own platform payout schedule.
2. Decide how cash commission is collected. Real automatic cash collection is not connected; a card-only launch must be enforced if selected.
3. Complete genuine restaurant business/bank onboarding and accepted non-demo terms, using the correct commission base. Do not relabel demo agreements as accepted real terms.
4. Design the test-to-live data handover. The current restaurant account table has one active account per restaurant and rejects switching an existing sandbox binding to live. Preserve old account references and pending history, or isolate live data in a separately reviewed environment.
5. Review the launch catalogue and audience. Current testing apps use the same public API; changing that API to live affects those apps too. Fictional demonstration restaurants must not become real checkout destinations.
6. Confirm the live business activity and customer/restaurant payment terms cover the Cal-Eats marketplace as well as Calai's subscription activity. Existing card capability does not establish that this review is complete.
7. Verify the dedicated account identity, minimum permissions, separate signed event delivery, restaurant payout readiness and available platform funding for vouchers/fee costs.
8. Review the exact activation change and obtain approval before enabling real payment mode. A real charge or payout is completed by the account holder, not by an unattended test.

The admin report documents these gaps; it does not bypass them or certify the app ready for public launch.
