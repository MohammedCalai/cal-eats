# Business payment adjustments

Implemented in migration 61. Activation is **off by default** through
`CALAI_BUSINESS_PAYMENT_ADJUSTMENTS_ENABLED`. This release preparation does not
create an adjustment, transfer money, change a payout schedule or enable the flag.

## Administrator and owner workflow

Admin Finance → Payment adjustments provides a business search, a draft, a
recorded review and a separate explicit confirmation. Each instruction records
its amount in integer pence, reason, effective London Monday, creator, reviewer,
confirmer, environment and exact platform/destination payment accounts. Confirmed
terms cannot be edited or deleted. Corrections require a separate instruction.
The current limit is £10,000 per instruction.

Owners have a read-only Adjustments view within Earnings & payouts. Reasons,
references, effective weeks, applied amounts, reserved amounts, pending balances
and carry-forward are included in CSV and weekly statements. Weekly statements
separate movements during the period from the position when generated.

## Money rules

- The order's saved 7% commission, discounted order value, delivery fee, voucher
  funding and processing-cost policy remain unchanged.
- A credit is a separate platform-funded transfer. It requires verified
  available GBP funds and the reviewed restaurant account. It never masquerades
  as an order or voucher. Known pending platform-funded commitments are reserved.
- A deduction reserves only new, untransferred completed-order earnings. It
  cannot debit the restaurant's bank, alter a past transfer, or resize an
  existing in-flight provider instruction. Any shortfall carries forward.
- Partial deductions produce a frozen settlement snapshot with original net,
  deduction and actual transfer amounts. Full withholding records an internal
  settlement and creates no zero-value/fictitious provider transfer.
- Confirmed refunds restore previously applied deductions before recovering any
  remaining amount from the actual transferred earnings. An undispatched
  snapshot affected by a refund can be cancelled only with durable proof that no
  provider dispatch occurred. Its payload and key remain intact; a new immutable
  revision uses a distinct key for the remaining earnings.
- Transfers allocate funds for the existing automatic Monday bank schedule once
  cleared. Neither an adjustment nor a transfer proves that a bank deposit was
  paid; existing verified payout evidence remains the source of bank-paid status.

## Retry and reconciliation controls

Both credit and adjusted-order instructions persist dispatch evidence before a
provider mutation. Ambiguous retries reuse the exact payload and key. A no-ref
dispatch is held after 20 hours, before a provider can expire its idempotency
record. Existing references are read back. Signed transfer events can recover a
lost response using a tightly scoped operation identity, followed by authoritative
provider retrieval and full amount/account/mode/metadata checks.

Held instructions retain reservations. Operators must reconcile the original
provider result; they must not create a replacement payment, change its key or
release an uncertain dispatch. External manual reversals of standalone credits
require operator reconciliation and are not an in-app adjustment action.

## Local validation

Tests use isolated databases and injected provider transports only. Focused cases
cover role checks, immutable terms, idempotency conflicts, original commission,
partial/full withholding, carry-forward, pre-dispatch refunds and revisions,
post-dispatch uncertainty, recovery with consumed balance, signed-event recovery,
mode/destination isolation, bank-paid provenance, reports and adapter fields.
No real transfer or live restaurant history was changed during implementation.

Primary provider references: [separate charges and transfers](https://docs.stripe.com/connect/separate-charges-and-transfers),
[transfer creation](https://docs.stripe.com/api/transfers/create),
[idempotent requests and retention](https://docs.stripe.com/api/idempotent_requests).
