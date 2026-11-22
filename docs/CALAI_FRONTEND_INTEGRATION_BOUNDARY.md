# Calai business frontend integration boundary

## Implemented, tested and deployed

This record concerns only the Calai business frontend work for the 22 November
2026 combined-business brief. Cal-Eats backend, portal and manager-app work is
documented separately.

**Implemented:** a frontend-only candidate and applicable
[tracked review package](../integration/calai-business-frontend/README.md),
including the [exact tested patch](../integration/calai-business-frontend/calai-business-frontend.patch).
The full candidate and additional ignored local evidence remain under
`artifacts/calai-business-frontend-20261122/`. The candidate extends the existing
Calai React/Vite business application. It does not create a replacement portal.

**Tested:** ten isolated protocol/permission checks, JSX parsing of five modified or
new JSX files, patch applicability, exact changed-path allowlisting and protected
frontend byte comparisons. The complete candidate also passed its existing
`vite build` in a separate ignored artifact copy, reusing the pinned
`npm ci --ignore-scripts` installation from the official npm registry. The updated
permission candidate built in 14.17 seconds. No deployment script,
protected host operation, original backend or provider operation was executed.
The original 314-file source snapshot was compared with its downloaded archive:
zero byte differences. These checks are not an authenticated two-product Surface
UAT or a production release. Build logs and output hashes are recorded alongside
the patch; Vite reports the application's existing large-chunk warning.

**Deployed:** no Calai change. No source push, host command, container operation,
infrastructure change, migration, bank action, call, order or print was performed.

## Actual source and application structure

The read-only source is `calai-operation/calai-platform` at
`dec58e32f9fffff16ffc5409a4ba3369193ad68c`, downloaded on 15 November. Archive
SHA-256:
`ac0b3631c40d60e5f3728a021b77ad31c9182cd824be2cd6076e614fc89aa69d`.
Authenticated GitHub inspection on 22 November verified that `main` still points
to this exact commit. The immutable archive EOCD/comment and all 314 source
snapshot files match. Source access is therefore resolved. The commit actually
serving `calai.info` remains unproven; verified GitHub main is not proof of the
production deployment.

Native Calai is React/Vite under `frontend/`, with Express/Prisma/PostgreSQL under
`backend/`. The business startup address remains
`https://calai.info/owner/dashboard`; public sign-in remains `/auth/login`.
`DashboardLayout` keeps its original Sidebar, Header, Outlet, OfflineBanner and
LiveOrderPopup. Native business settings remain under `/owner/settings/*`.

The candidate changes exactly these existing frontend source files:

| File | Change |
| --- | --- |
| `frontend/src/layout/DashboardLayout.jsx` | Add isolated workspace provider and persistent child surface around the existing Outlet |
| `frontend/src/components/layout/Sidebar.jsx` | Label native Calai navigation and append separately permitted Cal-Eats navigation below it |
| `frontend/src/pages/owner/Dashboard.jsx` | Add source-qualified daily order counters without modifying native values or calculations |
| `frontend/src/router/router.jsx` | Add owner account/connection and Cal-Eats presentation routes |

It adds only `frontend/src/components/cal-eats/CalEatsWorkspace.jsx`, its pure
`workspace-model.mjs` and focused test. Authentication, native Header/popups,
settings forms, dependencies/lockfile, Vite/Vercel settings, Dockerfile, nginx
configuration and the other 139 original frontend files are byte-identical.

## Owner workflow and isolation

Calai-only owners continue using the native application when Cal-Eats is absent,
disabled, signed out or unavailable. Accounts & connections opens the separately
authenticated Cal-Eats connection UI in the same window, using the dedicated
`https://eats.calai.info/business/embedded` route. There is no startup redirect,
compulsory product chooser or Intune change.

The child iframe remains mounted when the owner moves through native Calai
navigation, including the original settings pages. It is not conditionally
unmounted or assigned `display:none`. Its own authenticated Cal-Eats receiving
client and server-validated operational-tablet presence remain responsible for
contact; the parent does not invent Surface heartbeats or report `online=true`.
Actual browser timer throttling, sleep and hardware remain physical-Surface
verification dependencies. The backend must truthfully mark contact stale if
the browser stops sending it.

Native and integration requests do not share Axios clients or forms. The Calai
patch makes no fetches and does not read/write/remove native Access-Token cookies,
refresh cookies, localStorage or auth context. Its iframe uses its own existing
Cal-Eats sign-in and separate source-owner proof. Native Calai forms keep their
existing default, validation, submit and saved-value behaviour.

Native Calai `useAxiosSecure` logs the user out on 401/403. It is intentionally
not used by the integration, so a Cal-Eats failure cannot invoke native logout.

The combined navigation/counters appear only after the child reports an
authenticated association whose verified native Calai account AND source-user
IDs match `useAuth.user.businessId` and `useAuth.user.id`. Both products must be
administrator-permitted, connected and ready. This is display isolation; all
actual rights are enforced independently by the Cal-Eats/integration backend.
Finance, menu, device and order links also require explicit Cal-Eats capability
flags; native Calai ownership does not grant those rights.

Unknown or failed counters display **Unavailable**. Product totals and native
account references remain separate. No combined ledger, financial balance,
commission calculation or cross-product order is created.

## Embedded message protocol

The host accepts messages only from the exact iframe `contentWindow` and exact
origin `https://eats.calai.info`. The child accepts navigation only from its exact
parent window and `https://calai.info`. Both use version 1 and fixed message
types. Replacing the native user/account resets the child frame identity and
clears the host's account-specific display state.

Child-to-parent type: `cal-eats-workspace:state`, containing only authentication
state, business reference/name, per-product permission/link/readiness state,
verified native account references, safe integer order counters, explicit
Cal-Eats capability booleans and the current Surface state. Tokens, passwords,
cookies, customer data, order contents and financial details are excluded.

Parent-to-child type: `cal-eats-workspace:navigate`, allowing only
`dashboard`, `orders`, `payouts`, `menu`, `accounts`, `devices`. There is no supplied
URL, account ID, operational order action, activation or unlink command.
The child defaults to its safe connection view, not customer-order details.

The child emits its minimal state at least every 30 seconds. After 90 seconds
without a valid child update the host labels the integration unavailable; this
display freshness rule does not replace server-side Surface monitoring or alter
Cal-Eats enablement/availability.

The persistent iframe delegates autoplay and companion loopback permission only
to `https://eats.calai.info`. Where the browser reports support for the granular
`loopback-network` feature, it receives that feature without modern LAN access.
Older managed Edge receives its documented combined `local-network-access`
fallback. No wildcard origin, sandbox expansion, top navigation, parent-header
change or kiosk-policy change is introduced. [Microsoft iframe guidance](https://learn.microsoft.com/en-us/deployedge/ms-edge-local-network-access),
[Chrome loopback guidance](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access)
and [Chrome autoplay guidance](https://developer.chrome.com/blog/autoplay) describe
these browser requirements.

Delegation does not itself grant the user's browser permission, activate audio,
pair a terminal or establish application presence. Parent navigation messages are
not user gestures. Actual first-use permission, blocked-permission recovery,
message/order sound, background receiving, sleep/wake and printer output still
need the real Surface check. The companion continues accepting only its exact
Cal-Eats origin, process CSRF/window proof and authorised signed requests.

## Native authentication and statements

Existing Calai login and refresh endpoints check current active user status.
Protected BUSINESS_OWNER reads check the JWT, current role, verification and
native-business suspension. The owner profile DTO contains only
`id,email,firstName,lastName,avatar,role`; it does not expose active status or a
native business identifier. Therefore a copied browser access token alone is
not accepted as proof of current active source authority. No source token is
forwarded by this frontend patch.

The native login response separately includes `user.businessId` together with
the native user ID and role. Its existing AuthProvider retains that login
context; the host uses those values for its display-only identity comparison.
It does not add fields to the native profile or change authentication storage.

`GET /api/business-owner/business-hour` returns the authenticated native business
reference/name. The snapshot resolves it through the current owner rather than
accepting an arbitrary branch ID. Additional owned branches cannot be selected
by inventing a source API; current-source confirmation is required if a
multi-business owner needs a different branch.

The native subscription and billing-history workflow remains
`/owner/settings/subscription`, using its existing API and formatting. Existing
owner order/call export and receipt workflows remain native. No authorised
native monthly-statement-generation/export API was found in this snapshot; the
candidate links the existing native workflow rather than replacing its backend.
`GET /subscription/my-subscription` can expire a subscription in its existing
`checkPlanLimits`; it is not added as a background integration read. Existing
authorised native user navigation retains that original behaviour.

Source review also found that the native call-summary list and summary/transcript
detail GETs fetch provider data and upsert summaries; the list can update call
duration. Those paths are excluded from the new integration adapter even though
they use GET. Calls use the original `/owner/call-summary` screen instead.
Native dashboard `/stats` can similarly repair call durations and is excluded;
the separately reviewed `/dashboard/insights` endpoint only queries source data.
The allowed order list/detail, business-hour, profile/contact/business details,
agent list, menu list, plans and billing-history handlers were inspected as
query-only in the pinned source. Native `/dashboard/live` reads the existing
live-usage projection and provider reports; it does not persist call repairs.

## Native Cal-Eats permission boundary

The integration reads current native Cal-Eats memberships and explicit manager
flags. Finance viewing, device viewing, menu management and marketing management
are independent capabilities. A current native owner or scoped platform
administrator can grant or revoke those four flags on a different active human
staff member; the endpoint cannot change a role, principal, ownership, password,
service status or Calai permission. Changes record the actor and previous/current
native permissions. Terminal principals are excluded from the staff list.

Financial viewing allows recorded figures, statements and requested exports to
the authenticated account's own email. Delayed report delivery rechecks the
current grant. It does not grant bank-management links, onboarding, commercial
acceptance, tablet enrolment, staff administration or service enablement. Those
actions keep their stronger existing owner/administrator checks. New native
Cal-Eats flags never supply authority for Calai records.

A registered Cal-Eats tablet can read permitted Calai operational data only
while its enrolment issuer retains proof for the exact linked native Calai
account. The backend rechecks that delegation; a cached browser flag is ignored.
The terminal read scope excludes Calai sales analytics and mutating call-summary
GETs. Calai's original native application and permissions are unaffected.

## Headers and release boundary

Read-only unauthenticated checks on 22 November returned:

| URL | Observed response |
| --- | --- |
| `https://calai.info/owner/dashboard` | 200 HTML, no CSP, CSP-Report-Only, X-Frame-Options, COOP, COEP or CORP response header |
| `https://calai.info/auth/login` | 200 HTML with the same observed header absence |
| `https://eats.calai.info/business/embedded` | 200 HTML, `frame-ancestors https://calai.info`, no conflicting X-Frame-Options header |
| `https://eats.calai.info/business/owner/dashboard` | Normal owner route retains `frame-ancestors 'none'` and `X-Frame-Options: DENY` |

These probes do not authenticate or execute the application, establish its
production source commit or verify physical browser behaviour. The dedicated
Cal-Eats HTML entry now permits the exact authorised Calai parent; other owner
pages remain protected against framing. No Calai header change is needed for
this direct parent/child arrangement. Calai CSP/proxy/firewall/CORS settings are
unchanged.

Read-only inspection found an existing Vercel project for
`calai-operation/calai-platform`, rooted at `frontend`, using Vite and Node 24.
Its Domains page lists only `calai-platform.vercel.app` as Production, not
`calai.info`. Its latest main deployment, `99THchaG5ezTNWj9EfpibocxuExe`, is
**Blocked**, dated 7 November, at the verified `dec58e32...` commit. Vercel states
that commit author `NKRifat47` lacks contributing access and that Hobby
private-repository collaboration requires Pro. This is an observed existing
project restriction, not permission to change the author, account or plan.
No redeploy, upgrade, domain, authentication or project-setting change was made.
The actual `calai.info` host reports `nginx/1.31.3`; the inspected Vercel project
does not establish a release or rollback route for that host.

The source Docker Compose setup defines a separate frontend service, but its
Dockerfile copies `dist` inside a frontend nginx image. The documented normal
release rebuilds/restarts all services and the backend startup applies Prisma
migrations. That release is forbidden for this task. A frontend-only Compose
replacement could technically avoid backend dependencies, but still changes a
protected Calai container and is not treated as an authorised assets-only route.

**Exact Calai release dependency:** verify the production asset provenance and
the already-supported static-asset publication/rollback route for the actual
`calai.info` host. GitHub main and the immutable source baseline are verified.
The remaining route must change only frontend assets, without replacing protected containers,
restarting/redeploying the backend, changing host/proxy settings or modifying the
deployment pipeline. No such verified route is available from the inspected
source/accounts. Do not use `docker cp`, host mounts, DNS changes, a new deployment
pipeline or another Vercel domain as a workaround.

Once that route is established, check patch applicability against current source,
review only the seven allowlisted frontend paths, build in an authorised
isolated frontend environment with existing dependencies/configuration, release
only those assets and record the asset hashes. Rollback republishes the previous
verified frontend assets through that same existing route. Neither release nor
rollback restores operational databases or changes native accounts/history.

## Reproduce the completed checks

From the Cal-Eats workspace, run:

```text
node artifacts/calai-business-frontend-20261122/verify-iframe-permissions.mjs
```

The existing local verification helper checks the exact seven changed paths,
all protected frontend bytes, JSX parsing and ten focused tests, and produces
`iframe-permission-review.json`, `iframe-permission-tests.log` and the applicable
`calai-business-frontend.permissions.patch`. Patch applicability uses an explicit
baseline directory so no hunk is silently excluded by the current Git directory.
The reviewed patch and sanitized result are retained in the tracked integration
package. `original-source-boundary.json` records the separate 314-file archive
comparison. These artifact helpers are local evidence, not files included in a
fresh clone. None of these checks deploys or executes the original application.

The complete candidate build ran only in `build-check/`, copied from the
candidate with its unchanged baseline package manifests and Vite configuration.
Its inspected build script is only `vite build`. Dependency lifecycle scripts
were disabled during installation, and every locked dependency URL used
`registry.npmjs.org`. The current `iframe-permission-review.json` records the
successful build, preserved manifest hashes and generated asset hashes; the
prior build record remains historical evidence. The updated 14.17-second build
completed successfully; the largest JavaScript chunk is approximately
2.17 MB before gzip. No configuration or chunking change was introduced to hide
that warning.
