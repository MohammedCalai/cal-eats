# Combined platform administrator validation — 15 November 2026

## Current independent live release

The deployable release is extracted onto original Cal-Eats main `28af540`,
without the restaurant-phone/tablet runtime changes. Published schema 64/65 is
preserved byte-for-byte as preparation, followed by unified-admin schema 66.
Current release validation and live readback are recorded below as completed.
The detailed prototype test counts later in this file belong to its explicitly
identified predecessor and do not by themselves certify the independent extract.

- The platform portal build passed, along with 25 focused admin/model tests and
  22 existing business order/message audio and preference checks.
- Generic NotificationsPanel chimes are disabled at all three portal mounts.
  Existing new-order and repeating customer-message audio controllers are
  byte-unchanged from main.
- Calai source access is read-only by default. Server enforcement, not only
  hidden controls, blocks source data mutations and uploads.
- Before deployment, the existing Cal-Eats service was verified at schema 63:
  quick/integrity checks OK, no foreign-key violations and 34 existing orders.
  A new privacy-sanitized backup was verified at
  `/data/backups/calai-eats-2026-11-15T18-32-22-829Z.sqlite`, SHA-256
  `40fe85ab47b10f97a52b10b2c81dce79616f26ff242fe33e374ab7b8ac1c9768`.
  Order/financial facts matched before, in the backup and after creation,
  including the paid £4.00 / £0.28 / £3.72 pilot. Adjustments stayed off.
- New private connection settings were added only to Cal-Eats, without a
  restart. Enabled + read-only are true; the encryption key is separately saved
  in the operator's private local storage and the existing hosting service.
- Standalone backend/auth/backup/config and migration compatibility: **53 passed**.
  The populated 63-to-66 case preserves both claimed and printed kitchen/test
  jobs, their claim tokens and the £4.00/£0.28/£3.72 financial snapshots, with
  integrity/FK checks. A separate runtime journey proves quote/order creation,
  ordinary owner confirmation with one capture, and the legacy printer's bearer
  claim/acknowledgement all work with zero enrolled terminals.
- Default read-only enforcement passed: explicit linking and reads work;
  source POST/PATCH/DELETE/uploads are denied despite client flags, without a
  source mutation or journal dispatch. Existing Cal-Eats administration works.
- Two historical schema-upgrade test fixtures were corrected to construct the
  actual old schema or name their legacy columns explicitly. Data-preservation
  assertions remain; migration names/SQL were not weakened or renumbered.

Full independent CI and live release readbacks are recorded in the release pull
request. No deployment is allowed while those code checks are failing. Rollback
must retain the now-published migration history; do not start an old schema-63
image against a schema-66 database. Disable the Cal-Eats connection flag to stop
combined source access, preserving the existing Cal-Eats recovery sign-in.

## Historical prototype verification

The following is evidence for the original stacked implementation. The current
main-based extract keeps its tested admin code while excluding tablet runtime
enforcement; its additional compatibility and read-only checks are required.

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

The independent release does not require the restaurant tablet to be enrolled
and does not change its current processing/printing rules. It requires a verified
Cal-Eats-only deployment, deliberate dual-account linking by the platform
administrator and an authenticated read smoke test. Calai remains view-only.
No source-wide logout, Calai code/configuration/data change, data merge or
financial action is part of this rollout.
