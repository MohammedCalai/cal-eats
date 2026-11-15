# Combined platform administrator validation — 15 November 2026

## Confirmed implementation boundary

Implementation is confined to `MohammedCalai/cal-eats`. Its sole Git remote is
that repository. The original `calai-operation/calai-platform` source snapshot
at `dec58e32f9fffff16ffc5409a4ba3369193ad68c` was inspected read-only. All 314
retained text files matched the downloaded archive byte-for-byte; archive SHA-256
remained `ac0b3631c40d60e5f3728a021b77ad31c9182cd824be2cd6076e614fc89aa69d`.
No original source was executed, edited, committed, pushed or deployed. No
protected production Calai data, credentials or management action was used.

## Focused automated checks

- Backend consolidated frozen-source run: **44 passed**, zero failures/skips.
  This comprises 24 unified-administrator integration/security cases, nine
  upload/logo validators, two existing identity/phone cases, one fresh-process
  configuration import and eight existing backup cases.
- A final additional integration regression passed for uppercase UUID aliases
  across tenant, telephony and agent changes: identifier case cannot bypass an
  existing unconfirmed method/path hold. Known UUID query values are canonical.
  The backend now has 25 unified-administrator cases.
- Portal combined-admin/client/upload/read-queue and existing model run:
  **25 passed**. Production portal build passed.
- Independent review reran 16 baseline cases, two initial recovery regressions
  and five final targeted regressions. All passed. These overlap the suites
  above and must not be added as unique feature coverage.

Coverage includes explicit immutable-ID linking, no email auto-provisioning,
restaurant/customer denial, current active/verified/source-role checks, private
Cal-Eats reads/writes, opaque SID rotation, concurrent link/refresh revocation,
AES token binding, logout/expiry, method/query/body allowlists, hostile origins,
redaction, transient multipart bytes, bounded credential-free raster preview,
durable ambiguous-write holds across reconnection/key rotation/changed payloads,
GET-only intent-key lookup/aliases, operator review without provider-confirmation
claims, and a populated migration 65-to-66 preserving existing financial facts.

The review identified and corrected three concrete replay hazards: delegated
telephony HTTP 400 could conceal an already-applied effect; unlink/relink could
otherwise evade a held operation; and encryption-key rotation changes HMAC
fingerprints. The final same-source method/path hold is conservative and requires
an explicit recorded check before a separate new action is allowed.

## Actual local browser UAT

The generated portal was served by the actual Cal-Eats HTTP application at
`http://127.0.0.1:4360` against a new disposable database and an injected synthetic
Calai adapter. The QA process cleared inherited provider settings and blocked
external fetch destinations. It contained 31 synthetic tenants and no real
Calai connection. These observations prove UI-to-backend integration against
that adapter, not live Calai authentication or provider side effects.

Passed observations:

1. Local administrator sign-in opened the existing Cal-Eats overview.
2. Calai data stayed gated before explicit account linking.
3. Entering both synthetic credentials linked the intended source identity and
   displayed the connection/expiry; password fields cleared.
4. Calai / Cal-Eats switches opened the correct administrator areas.
5. All six Calai sections loaded their synthetic DTOs.
6. Tenant pagination showed 25 rows then six; unmatched search showed an empty
   state and reset to page one.
7. A normal tenant edit returned to a freshly updated list.
8. A synthetic edit applied but returned HTTP 400. The form held it as unknown,
   disabled Save and offered read-only request-status checking.
9. A separate tenant detail confirmed the synthetic edit existed. The operator
   check then recorded applied, explicitly labelled as an operator report, with
   no automatic resubmission or provider-confirmed claim.
10. The training form exposed tenant/name and both required PDF fields.
11. Telephony rows and subscription/invoice tables loaded; finance remained
    explicitly separate from Cal-Eats commission and payouts.
12. The protected same-origin logo image loaded. A 1.44 MiB local PNG selected
    through the file chooser uploaded to the synthetic adapter, showed success
    and cleared its selection.
13. Sign-out returned to the combined administrator login. Signing in there with
    only the linked synthetic Calai credentials reopened both admin areas.
14. Captured browser warning/error log was empty during these checks.

Screenshots are kept privately under
`artifacts/unified-platform-admin-20261115/combined-login-qa.jpg` and
`combined-dashboard-qa.jpg`. Test accounts, images, mutation results and financial
figures in them are synthetic. No real upload or telephony action was performed.
The QA process was then stopped, port 4360 was confirmed closed and its uniquely
identified temporary database directory was removed. Cleanup evidence is retained
privately in `artifacts/unified-platform-admin-qa-cleanup.private.json`.

## Full regression check

The first complete `npm run check:developer` run built the portal and passed
732 of 733 core cases. Its one failure was `spawnSync ... ETIMEDOUT` in the
existing ten-second fresh-process configuration-import test while the machine
was running the full default-concurrency workload. That import had already passed
in the focused run. No assertion or timeout was weakened.

Core test workers are now capped at four in the existing test command, bounding
parallel process pressure. The final complete `npm run check:developer` rerun
**passed with exit 0** against the implementation commit and that cap:

| Check | Result |
| --- | --- |
| Core API, customer web, portal, printer and maintenance suites | 734 passed; zero failures/skips |
| Existing customer native suite | 69 passed; zero failures/skips |
| Restaurant Cal Eats Admin native suite | 15 passed; zero failures/skips |
| Portal production build | Passed; existing bundle-size advisory retained |
| Customer and restaurant native TypeScript checks | Both passed |
| Release packaging | Passed; 267 JavaScript source files and 24 required release files checked |

All figures describe executed checks, not restaurants or physical devices tested.
No remaining local test process or QA server is required for this feature.

Independent GitHub verification of implementation commit
`38756e730c5916dc216ed7fce5fa43d32a5295dc` passed all three jobs in
[run 43742683373](https://github.com/MohammedCalai/cal-eats/actions/runs/43742683373):
Windows and Ubuntu each completed the full `npm run check:developer` command;
the container build and packaged recovery-tool checks also passed. This includes
the final UUID alias regression and bounded worker configuration. Documentation
updates after that implementation commit do not change the validated app code.

## Exact remaining live dependency

The integration defaults off. Hosted activation requires its new private
encryption setting, the compatible API/portal rollout, deliberate dual-account
linking by the platform administrator and an authenticated live read smoke test.
The stacked branch also contains the separate restaurant Admin app work; its
real ordering tablet must be enrolled before that terminal requirement is
enabled on a live restaurant. No merge, deployment, source-wide logout, data
merge, public release or financial action has been performed by these checks.
