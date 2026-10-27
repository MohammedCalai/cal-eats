# Dispute resolution acceptance

- Submission enters restaurant response without issuing a refund.
- Cross-tenant case, order, item and proposal identifiers return not found or fail binding validation.
- Only restaurant owners can make value-bearing proposals; voucher/free-item proposals require conditions and expiry.
- Proposal creation and customer response are idempotent, and only one proposal may await a customer at a time.
- Decline records escalation and leaves the case visible.
- Non-refund acceptance does not resolve the case. Restaurant evidence plus customer confirmation, or a reasoned administrator override, is required.
- Refund acceptance authorizes the existing durable execution path once, capped by the remaining net amount paid. Restaurant-funded discounts are not refundable.
- Cash repayment remains separate from card-provider execution.
- Deadline expiry records explicit escalation and notifies administrators without an automatic financial or complaint decision.
- The simulator/provider label remains visible; no implementation claim implies live money movement.
