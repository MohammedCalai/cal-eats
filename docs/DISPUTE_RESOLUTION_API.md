# Restaurant-first dispute resolution

Customer submission creates a formal refund case in `awaiting_restaurant`; it never moves money. Restaurant members and administrators receive a deduplicated notification. The existing response policy supplies the restaurant deadline, reminder and escalation timing.

## Resolution API

- `GET /api/refund-cases/:caseId/resolution` returns `{caseId,orderId,restaurantId,phase,escalatedAt,escalationReason,resolvedAt,proposals}` for the case customer, its restaurant members, or an administrator.
- Owner `POST /api/restaurant/restaurants/:restaurantId/refund-cases/:caseId/proposals` requires `Idempotency-Key` and `{type,description,itemIds?,amountMinor?,voucherValueMinor?,expiresAt?,redemptionConditions?}`. Types are `missing_item`, `replacement`, `free_item`, `voucher`, `partial_refund`, and `full_refund`.
- Customer `POST /api/refund-cases/:caseId/proposals/:proposalId/respond` requires `Idempotency-Key` and `{decision:"accept"|"decline"}`.
- Owner `POST .../proposals/:proposalId/fulfil` requires `Idempotency-Key` and `{evidence}` for an accepted non-refund remedy.
- Customer `POST /api/refund-cases/:caseId/proposals/:proposalId/confirm-fulfilment` requires `Idempotency-Key` and `{}`.
- Administrator `POST /api/admin/refund-cases/:caseId/escalate` takes `{reason}`. A reasoned `resolve-override` is available for evidenced, accepted non-refund remedies.

Voucher and free-item remedies require exact conditions and a future expiry. A voucher also requires its value; a free-item description identifies the promised item and quantity. These records document a manual remedy and do not silently create a checkout promotion. All value remedies are owner-only and restaurant-funded. Offer, acceptance and restaurant fulfilment evidence are separate states; only customer confirmation or a reasoned administrator override resolves a non-refund case.

Accepted refund proposals reuse the durable refund job, cumulative net-payment cap, commission reversal, ledger and payout recovery behavior. The financial party is recorded as the restaurant. Card execution remains labelled `local_simulator` until a configured provider confirms it. Cash orders remain in the separate evidenced cash-return workflow.

Declining a proposal escalates rather than rejects the complaint. Deadlines may escalate but never approve, reject or transfer money. Repeat-request flags remain review signals only; the discretionary-goodwill limit does not block genuine refund remedies.
