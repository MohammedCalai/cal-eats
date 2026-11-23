# Restaurant bank payout descriptor

The requested descriptor for Cal-Eats restaurant bank deposits is **CAL-EATS**. This is the connected restaurant account's `settings.payouts.statement_descriptor`, not a customer charge descriptor or a platform-to-restaurant transfer description. Stripe uses this bank-payout setting for automatic payouts, including the existing weekly Monday schedule.

Restaurant onboarding applies the descriptor in a separate, idempotent account-settings request before returning the Stripe onboarding link. The request changes only `settings[payouts][statement_descriptor]`. Account creation and weekly schedule requests retain their existing payloads and keys. A failed/mismatched descriptor confirmation prevents a success link, so the owner can retry the same account. The onboarding-only live provider exposes this settings method without granting charge, transfer or payout-creation methods.

Existing restaurant accounts must be updated explicitly through an authorised, restaurant-bound settings change. Adding onboarding code alone does not backfill them. Before updating, verify the database's restaurant/account/mode binding against Stripe account metadata. Read back the account and balance settings after the update; verify the descriptor and preserve the payout schedule, bank destination and customer charge descriptors. No new payout, refund or transfer is required to change the text.

## Verification record — 23 November 2026

The active live restaurant account was updated from an unset payout descriptor to `CAL-EATS` at 13:35 UTC. Independent Stripe Account and Balance Settings reads confirmed the value. The weekly Monday schedule, bank destination and customer charge descriptors were unchanged. The existing payout created at 00:15 UTC that day predates the change and is not evidence of the new descriptor. Historical deposits cannot be relabelled by changing this default.

For the next payout created after the change, record its ID, automatic flag, status, currency, amount, arrival date and `statement_descriptor` using a read-only connected-account request. A test-mode payout cannot verify a real deposit. Wait for the live payout to reach `paid`, then have the restaurant confirm the exact text on its bank statement, matching amount/date and currency. A cropped or transcribed deposit reference is sufficient; do not collect a full bank statement or credentials.

Stripe verification and bank-display verification are separate: banks can shorten, alter or omit payout descriptors. A Stripe `paid` status and `CAL-EATS` field establish provider-side evidence, not the receiving bank's exact display. Until the restaurant supplies that evidence, record bank appearance as pending. The follow-up must not generate a real payment or payout merely to test the descriptor.

References: [Stripe account payout settings](https://docs.stripe.com/api/accounts/update?api-version=2025-06-30.basil), [pinned Balance Settings](https://docs.stripe.com/api/balance-settings/update?api-version=2025-06-30.basil), [payout statement descriptor and bank-display limitations](https://docs.stripe.com/api/payouts/create).
