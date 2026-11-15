# Combined Calai and Cal-Eats platform administration

## Scope and source boundary

This work joins the platform administrator's workspace. Restaurant-owner,
manager, customer and ordering-tablet access remain separate roles. The native
restaurant companion is a separate application named Cal Eats Admin.

The original Calai Operations repository is **read-only**:
`https://github.com/calai-operation/calai-platform`, inspected at
`dec58e32f9fffff16ffc5409a4ba3369193ad68c` (main, 7 November 2026).
An authenticated GitHub browser download supplied a filtered local read-only
copy. Its archive SHA-256 is
`ac0b3631c40d60e5f3728a021b77ad31c9182cd824be2cd6076e614fc89aa69d`.
No original source was executed, edited, committed, pushed or deployed. No Calai
database migration or shared signing-secret change is part of this integration.
Only the Cal-Eats repository is an implementation destination.

## Existing systems

| Area | Original Calai | Cal-Eats |
| --- | --- | --- |
| Platform administrator | `SYSTEM_OWNER` | `admin` |
| Admin pages | `/admin/*` | `/business/admin/*` |
| Protected API | `/api/system-owner/*` | `/api/admin/*` |
| Authentication | Access JWT plus HttpOnly refresh cookie | Opaque server session with HttpOnly host-scoped cookie |
| Primary data | Separate PostgreSQL/Prisma domain | Existing Cal-Eats database |
| Administration structure | Dashboard, AI training, tenants, subscriptions/billing, settings, telephony | Restaurants, orders, customers, finance, support, operations, access and service areas |

The original current source has no wired OIDC/SAML issuer, JWKS, user-info or
token-introspection endpoint. Its login, refresh and protected role checks can
support a Cal-Eats-side connection. Existing browser role cookies, email matches
or decoding a JWT alone must never grant platform administration.

## Combined login

The combined entry point is `/business/admin/login`. A one-time connection must
prove both an existing Cal-Eats administrator account and the intended Calai
system-owner account. The mapping uses immutable source account IDs, not email
matching or restaurant/business IDs.

Subsequent combined sign-in authenticates with Calai, proves current active
account status and current verified system-owner role, checks the explicit
mapping and the local administrator's enabled role, then creates the ordinary
Cal-Eats opaque session. Original credentials are not stored. Provider tokens
stay encrypted on the server, scoped to that exact session and source account.

The administrator switches between clearly identified Calai and Cal-Eats areas
within the same workspace. Existing Cal-Eats administration remains available.
Original Calai endpoints are reached only through fixed, validated adapters;
there is no arbitrary URL proxy, tenant impersonation or database merge.

A separate local Cal-Eats administrator sign-in remains available for recovery.
Upstream failure never silently changes the authentication method.

## Authority and logout limits

Current Calai login/refresh checks active account status; its protected API
middleware checks the current database role and verified state. Both proofs are
needed. In particular, the protected API check alone does not establish current
active status.

Linked authority fails closed on unavailable or invalid proof. Source and
Cal-Eats identifiers, totals and financial meanings remain separate. Existing
Cal-Eats payment, commission and payout rules are not replaced.

Signing out of the combined workspace revokes its own session and removes its
stored provider credentials. The original Calai service does not provide server
revocation of every already-issued access/refresh token. This integration cannot
promise to sign out another already-open original Calai browser session without
an upstream capability change.

## Installation and activation

The integration is opt-in and defaults off. Build the existing portal with
`npm run portal:build`; the ordinary Cal-Eats API serves it under `/business/`.
Migration 66 adds explicit identity mappings, encrypted federated sessions and
an administrator request/review journal. It does not migrate Calai's database,
merge tenants with restaurants or alter payment records. Take and verify the
existing Cal-Eats backup before a hosted migration. Restorable backups revoke
identity links and federated sessions and remove their provider tokens,
preventing an old backup from reviving linked administrator authority. Historical
request records and aliases remain available for safe ambiguity recovery.

| Server setting | Value / purpose |
| --- | --- |
| `CALAI_PLATFORM_ADMIN_ENABLED` | `true` only for an explicitly activated connection; default `false` |
| `CALAI_PLATFORM_ADMIN_ENCRYPTION_KEY` | A new private 32-byte base64url value; never reuse Calai's JWT secret |
| `CALAI_PLATFORM_ADMIN_ORIGIN` | Fixed to `https://api.calai.info`; another origin is rejected |
| `CALAI_PLATFORM_ADMIN_RESPONSE_LIMIT_BYTES` | Default 8 MiB; permitted server-only range 1–32 MiB |

Keep the encryption key in the existing private hosting configuration, never in
Git, client builds or logs. Rotating it invalidates encrypted connections, so
administrators must reconnect. Held ambiguous operations remain held through
reconnection and key rotation. No injected adapter is accepted in hosted mode.

Activation steps:

1. Complete the existing compatible backend/tablet rollout before deploying the
   stacked branch. It also contains the separate restaurant Admin app changes;
   do not enable its tablet requirement on an unenrolled live restaurant.
2. Install the server settings and deploy the matching API and portal together.
3. Use the existing **Cal-Eats administrator** recovery sign-in, with its secured
   private password. Open **Platform connection** and enter both the current
   Cal-Eats administrator password and the intended Calai system-owner login.
   This is an explicit, audited link; no restaurant owner can create it.
4. Verify the displayed source identity, then test the combined sign-in at
   `/business/admin/login`. It uses the linked Calai credentials and provides
   the Calai / Cal-Eats switch. A successful link replaces the old opaque session.
5. Run controlled authenticated read checks of both services before authorising
   any real Calai management change. Keep the independent recovery login usable.

No production administrator credentials, identity links or hosting settings have
been entered by this implementation work. Local test data and adapters cannot
connect to Calai, email, telephony or payment providers.

## Screens and source integration

The administrator shell changes only the platform administrator's routes.
Restaurant owner/staff, ordering-tablet, customer and native-app shells keep
their own permissions and navigation.

| Combined page | Connected original Calai functions |
| --- | --- |
| Dashboard | Tenant/subscription counts, live voice calls, dated operations/call/failure/printer tables |
| AI Training | Agents, rule/menu PDF training, special-offer PDF upload, explicit enable/disable, removal |
| Tenant Management | Search, 25-row pages, tenant details, agents/calls/orders/billing; supported create/edit/remove |
| Telephony | Existing connected numbers, available tenant agents, supported connect/edit/disconnect |
| Subscriptions & Billing | Authoritative plans, source billing totals and invoice records |
| Settings | Current platform logo through a bounded same-origin image route and supported image upload |

Calai tenant impersonation is deliberately excluded. The adapter allows only
known method/path/query/body combinations. PDF uploads require matching type,
extension and signature, at most 5 MiB per file; rule/menu training requires both
files and at most 10 MiB total. Raster logo uploads are at most 2 MiB. Raw upload
bytes are transient and original local filenames are not sent upstream or stored
in the journal. Source responses and images are bounded, redirects are refused,
and provider tokens never reach browser JavaScript. Logo fetches accept only the
fixed source's raster `/uploads/` path and forward no administrator credentials.

The Calai source does not supply currency on every billing DTO. Those amounts
are labelled as currency unconfirmed rather than inventing pounds or combining
Calai subscriptions with Cal-Eats restaurant payouts. Source list endpoints
remain unpaginated; the response cap and browser pages do not certify the
original service's capacity for 10,000 tenants.

## Ambiguous changes and recovery

Each real source mutation has a durable, administrator-scoped intent key and
journal entry. Repeated taps share the same request. A successful provider reply
can confirm the change; a timeout, lost response, unexpected reply or ambiguous
upstream failure stays held. The source sometimes reports delegated failures as
HTTP 400 after another service may have acted, so that response is not proof that
the change did not happen. No automatic retry of an ambiguous write is performed.

**Check request status** performs a read-only lookup by request reference or the
original intent key, including aliases created by deduplication. If the request
cannot be located, the form stays paused. A source/connection outage may require
explicit reconnection before the result can be inspected.

For an unknown result, first inspect the actual affected Calai record. The
administrator can then record **applied** or **not applied**, re-entering the local
administrator password and describing the evidence. This is clearly an operator
report, not provider confirmation. It never resends the original action. Only an
explicit new intent after a recorded not-applied check can submit another change.
An interrupted dispatch becomes eligible for that review after the guarded wait;
it does not silently become retryable after a restart.

Unlinking removes all local linked-session credentials. Local logout also wipes
its encrypted provider tokens. There is no source-wide revocation promise, and
independent original Calai browser sessions keep the original source's behaviour.

## Verification boundary

A read-only unauthenticated probe of the fixed Calai role-check endpoint returned
HTTP 401 with “No token provided”, confirming the protected route is present.
That is not a successful authenticated integration test.

The filtered source copy was compared byte-for-byte with its downloaded archive:
all 314 retained source files matched and the archive hash above was unchanged.
The original Calai repository is absent from implementation Git remotes. Local
browser and automated results are recorded in
[the validation log](UNIFIED_PLATFORM_ADMIN_VALIDATION.md).
