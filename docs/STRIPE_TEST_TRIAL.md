# Stripe sandbox trial — 29 October 2026

The existing Cal-Eats general sandbox under Calai is connected to the existing preview at https://eats.calai.info. The provider is `stripe_test`; live payments remain disabled. Original Calai live credentials, payments and verification were not changed.

## What was exercised

The customer browser browsed **Cal-Eats Stripe Test Kitchen · No real food**, added a £5 test meal and reviewed its owner-configured £1 delivery fee. Both £6 orders used genuine Stripe-hosted Checkout with Stripe's published test Visa card, then returned to Cal-Eats. Restaurant confirmation captured the authorisation, set an ETA and notified the customer. Preparation, ready, out-for-delivery and completed transitions were verified. Separate authenticated restaurant API sessions exercised the normal business transition endpoints.

Two-way order messages, notifications and a consent-respecting personalised 50p offer were verified for the first test customer. No real food was prepared or delivered.

| Evidence | First order | Second order |
| --- | --- | --- |
| Order reference | E502CE97 | F1040CBC |
| Customer charge | £6.00 test | £6.00 test |
| Stripe authorisation/capture | Confirmed | Confirmed |
| Customer updates and ETA | Confirmed | Confirmed |
| Full refund | £6.00 confirmed | £6.00 confirmed |
| Final commission/restaurant earnings | £0 / £0 | £0 / £0 |
| Refund completion | Provider-evidenced recovery after initial adapter failure | Normal background worker; no maintenance repair |

Before refund, the food-only 7% commission was 35p and restaurant earnings were £5.65. The first Stripe test balance transaction independently reported a 39p processing cost; that was not represented as platform commission or profit.

## Problems found and fixed

- Genuine Stripe Checkout URLs include a fragment; the adapter now preserves it while requiring the exact Stripe HTTPS origin, no credentials and no nondefault port.
- The pinned Stripe API uses `payouts[schedule][weekly_anchor]`, rather than the newer array field. Weekly Monday configuration was verified against Stripe.
- Stripe Refund objects omit `livemode`. The adapter now proves the mode through the exact authoritative parent PaymentIntent, including ID/currency/amount checks. Unverified responses cannot establish success.
- PaymentIntent/refund events now bind to the saved order payment with tenant, account and financial checks, preserving already captured/refunded facts.

The first refund existed and succeeded at Stripe before the old adapter failed to recognise it. After deploying the fix, the existing refund was retrieved and fully validated against the original order/case, then reconciled through the normal refund finaliser with an audit event. No second refund was requested for that order. A second independent order subsequently verified automatic worker completion. Historical failed/unmatched events from the initial diagnosis were preserved.

The final focused adapter, event, worker and checkout checks passed **39 tests**. Release packaging checks passed. No broad suite was repeated after those targeted fixes.

## Restaurant bank and payout limits

Stripe-generated test onboarding details were used, including its test bank ending **2345**. The business API reads masked bank details, weekly Monday scheduling and an empty payout history. Payouts Read was corrected for connected accounts on the previously approved restricted test key. No payout-creation permission was added.

Both orders were fully refunded, so no restaurant payout was due. Actual bank settlement, a paid bank-payout event, live fees and live funds have not been verified by this trial. The initial charge's test availability date was 5 November 2026; it was not described as immediate available funds.

## Repeat the customer test

Use the customer app at https://eats.calai.info/order/ and choose **Cal-Eats Stripe Test Kitchen · No real food** in LU1. Use card **4242 4242 4242 4242**, future expiry **12/34**, CVC **123**, and a fictional billing name. These are [Stripe's test-card values](https://docs.stripe.com/testing), valid only in testing.

The restaurant account is available in the business platform at https://eats.calai.info/business/. Select the same test kitchen to confirm the order, set its ETA and progress delivery. Other demo restaurants retain their previous simulator banking records and are not silently converted into Stripe-connected businesses.

Secrets and detailed private receipts remain outside Git. No real bank/card details, OTPs or authentication credentials are included in this document.
