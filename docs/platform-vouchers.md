# Platform-funded customer vouchers

Admin → Customers & vouchers is the customer directory, with numbered pages and customer search. Administrators can issue a voucher with an amount, message, expiry and audited internal reason, inspect order credits, or withdraw its unused balance. The customer receives an in-app notification and sees the wallet above restaurant offers in both customer clients.

## Money model

- Restaurant-funded promotions reduce food/delivery first. The saved commission rate is applied to that remaining food plus charged delivery (currently 7%).
- A Cal-Eats voucher is a payment contribution funded by the platform. It does **not** reduce the restaurant's order value, commission basis or net earnings.
- `orders.total_minor` remains the restaurant's full order value. `customer_payable_minor` is the amount charged to the customer; `platform_voucher_minor` is the platform contribution. Their sum must equal the order value. Old orders use `customer_payable_minor ?? total_minor`.
- Quote responses use `totalMinor` for the customer total and also expose `orderValueMinor`, `customerPayableMinor`, `platformVoucherMinor`, `voucherId` and an immutable voucher snapshot. Order responses preserve `totalMinor` for restaurant/admin consumers and include the separate customer amount.
- A fully covered order uses the genuine internal `voucher` payment method. No card session, PaymentIntent, authorization or mock charge is created. Merchant confirmation consumes its reserved voucher balance; rejection releases it.
- Partial vouchers work with digital payment. Cash orders can use a voucher only if it covers the entire order. A nonzero card remainder must meet the existing GBP 30p minimum; excess voucher credit remains in the wallet with an explanation at checkout.
- Example: £12 food less a £2 restaurant offer plus £2.50 delivery = £12.50 restaurant value. Commission is 88p; restaurant earnings are £11.62. A £12.50 platform voucher makes customer payment £0 without changing either figure.

## Lifecycle and settlement

Schema migration 38 preserves historical orders, child records and operational indexes while adding the voucher method, payment split and voucher/redemption tables. Back up the database before applying it.

Issuance is administrator-only and idempotent by issuing administrator/request key/body hash, with an audit entry and deduplicated notification. Vouchers are customer-scoped, have an expiry and can retain value across orders. One eligible voucher is chosen automatically per order, prioritizing the largest usable contribution then earlier expiry. Quotes have no side effects.

Order creation verifies the reviewed customer total, locks the database transaction, and reserves the exact amount against the current available balance. A competing order cannot reserve the same value. Checkout retries retain the original body and key. The reservation belongs to that order until confirmation or a known cancellation; ambiguous card results never release it early. Confirming an order honours an existing reservation even if the voucher has since expired or its unused balance was withdrawn.

Confirmation redeems the reservation and records one balanced `platform_voucher_credit` operation: debit `platform_voucher_expense`, credit `order_captured`. The separate customer capture records only the customer-funded balance. Reporting includes both as restaurant sales, and subtracts voucher expense when calculating platform margin. Statements, receipts, exports and customer emails show the split.

Completed orders become eligible for the restaurant's full net earnings. Voucher-backed bank transfers use the platform's available provider balance, without binding a larger transfer to a smaller customer charge. The transfer worker rechecks the recipient account, payout readiness, provider mode/platform account, completed order, immutable amount/commission snapshot and redeemed voucher entitlement before provider I/O. Insufficient provider funds or an ambiguous response does not mark a payout paid. Payout history and actual bank receipt remain distinct from an internal restaurant credit.

Provider references: [Stripe transfer API](https://docs.stripe.com/api/transfers/create) permits an optional source transaction and requires available platform funds. [GBP minimum charge](https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts) is currently 30p. These were checked on 4 November 2026.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/admin/voucher-customers?q=&page=1&pageSize=25` | Numbered customer directory; page sizes 10, 25 or 50 |
| GET | `/api/admin/customers/:id/vouchers` | Customer details, vouchers and order-credit history |
| POST | `/api/admin/customers/:id/vouchers` | `{title,amountMinor,expiresAt,message?,reason}`; requires `Idempotency-Key` |
| PATCH | `/api/admin/vouchers/:id` | `{action:"revoke",reason}`; protects existing order commitments |
| GET | `/api/account/vouchers` | Signed-in customer's wallet |
| POST | `/api/orders/quote` | Optional `autoApplyVouchers`, `voucherId`, `paymentMethod` |
| POST | `/api/orders` | Explicit resolved `voucherId` and reviewed `expectedTotalMinor` |

Issue limits are £0.50–£1,000 per voucher and expiry within one year. No withdraw-to-bank or customer-to-customer transfer exists. Restaurant refunds remain disabled by the separate business-direct-resolution policy.

## Validation

`apps/api/test/platform-vouchers.test.js` covers issuance/access/idempotency, reservation races, expiry/revocation, cross-customer isolation, digital-payment minimum, full and partial funding, commission/restaurant earnings, provider amount binding, bank-onboarding gate, settlement revalidation, no duplicate transfers, and schema 37→38 historical preservation. Checks use local fixtures and injected provider adapters, with no real transactions or outgoing email.
