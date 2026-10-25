# Admin governance API

This local-demo API adds audited account access, restaurant membership governance and refund response deadlines. Every route requires an authenticated administrator. It does not contact email, SMS or external notification services.

## Accounts

- `GET /api/admin/governance/accounts` returns `{data:{items,nextCursor}}`; each item has `id,name,email,role,enabled,createdAt`.
- `PATCH /api/admin/governance/accounts/:userId` takes `{enabled:boolean,reason:string}`.

Disabling is transactional: the account state changes, all browser and native sessions are revoked, and an audit entry is persisted. Fresh login and session hydration must require `users.account_enabled=1`. Administrators cannot disable themselves or the last enabled administrator. Enabling does not recreate a session.

## Restaurant memberships

- `GET /api/admin/governance/restaurants/:restaurantId/memberships`
- `POST /api/admin/governance/restaurants/:restaurantId/memberships` with `{userId,permission:'owner'|'staff',reason}`
- `PATCH /api/admin/governance/restaurants/:restaurantId/memberships/:userId` with `{permission:'owner'|'staff',reason}`
- `DELETE /api/admin/governance/restaurants/:restaurantId/memberships/:userId` with `{reason}`

The target user must be an enabled restaurant-role account. Every lookup is scoped by both restaurant and user ID. A restaurant must retain at least one owner. Permission remains server-derived from the membership table; client state is never authoritative. Mutations are audited.

## Refund response policy

- `GET /api/admin/governance/refund-policy`
- `PATCH /api/admin/governance/refund-policy` with `{customerResponseHours,restaurantResponseHours,reminderLeadHours}`

Response windows accept 1–720 hours; reminder lead accepts 1–168 hours. Defaults are 48 hours for customer and restaurant responses with a reminder 12 hours before the deadline. These are local operational defaults, not legal promises.

`runGovernanceReminders(db,config)` durably tracks cases in `awaiting_customer` or `awaiting_restaurant`:

- before the deadline, one deduplicated in-app reminder goes to the customer or restaurant owners;
- after the deadline, one deduplicated in-app escalation goes to enabled administrators and an audit event is persisted;
- changing awaiting party creates a new deadline; leaving an awaiting state removes the active deadline.

Registered additive migration v18 stores the specific `request_information` or `ask_restaurant` event ID as the waiting-episode key. If a case leaves and later re-enters the same awaiting status—even entirely between worker cycles—the new request receives its own deadline and deduplicated notification keys rather than reusing the earlier episode.

The runner never approves, rejects, refunds, closes or otherwise changes the case status. Existing in-app notifications are the only delivery channel. Background email, SMS and push are not implemented.

## Audit and privacy

Governance audit rows record actor, action, entity, bounded reason/details and timestamp. APIs never return password hashes, session tokens, native tokens or notification internals. Account and membership changes are administrator-only; restaurant users cannot enumerate another tenant.
