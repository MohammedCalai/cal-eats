# Calai business frontend review package

This is a reviewable frontend-only patch retained in the Cal-Eats feature
repository. **It has not been applied to the original Calai repository or
deployed.** It includes no full source checkout, dependencies, compiled assets,
credentials or machine-specific paths.

Baseline: `calai-operation/calai-platform` commit
`dec58e32f9fffff16ffc5409a4ba3369193ad68c`. The downloaded archive SHA-256 is
`ac0b3631c40d60e5f3728a021b77ad31c9182cd824be2cd6076e614fc89aa69d`.
Authenticated GitHub inspection on 22 November verified that `main` still points
to this commit. Its immutable archive EOCD/comment and all 314 snapshot files
match. The source commit actually serving `calai.info` remains unproven.

- [The exact tested patch](calai-business-frontend.patch) changes four existing
  frontend files and adds three frontend files. Native login, settings, existing
  controls and the startup address remain in place.
- [Manifest](manifest.json) records the seven paths, before/after hashes, patch
  hash, tests and isolated build result.
- [Protected file hashes](protected-file-hashes.json) records 139 unchanged
  candidate frontend files and 314 original snapshot files matching the archive.

Verification completed: ten protocol/permission tests passed; five JSX files
parsed; patch applicability and protected-file checks passed. The complete
candidate passed its existing `vite build` in a separate ignored artifact copy
using the previously pinned `npm ci --ignore-scripts` installation from the
official npm registry. Package manifests and Vite configuration remained
unchanged. The updated build took 14.17 seconds
and reported a large-chunk warning (main JavaScript approximately 2.17 MB before
gzip). This does not establish physical Surface operation, authenticated
two-product UAT or a production release.

The iframe now delegates autoplay and the supported loopback permission only to
`https://eats.calai.info`. Modern browsers receive `loopback-network`; older
managed Edge uses its documented `local-network-access` fallback. It adds no
wildcard origin, modern LAN permission, sandbox expansion, authentication change
or kiosk/header change. Browser permission and actual Surface sound/contact still
require physical verification. See [Microsoft's iframe guidance](https://learn.microsoft.com/en-us/deployedge/ms-edge-local-network-access)
[Chrome's loopback guidance](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access)
and [Chrome's autoplay guidance](https://developer.chrome.com/blog/autoplay).

**Release blocker:** establish the existing frontend-assets-only publication and
rollback route for the actual `calai.info` host. The inspected Vercel project
uses `frontend` / Vite / Node 24 but lists only `calai-platform.vercel.app` as its
production domain. Its latest main deployment is Blocked because its commit
author lacks contributing access; Vercel's Hobby private-repository collaboration
restriction is not permission to change the author, account or plan.
`calai.info` currently responds through nginx/1.31.3. Neither observation proves
an authorised asset-only release route for that host. No Vercel change was made.
The reviewed container deployment is not permitted for this task. Do not alter
Calai's host, containers, backend, database, runtime, authentication, proxy,
printer service, DNS or deployment pipeline to apply this package.

See the [boundary report](../../docs/CALAI_FRONTEND_INTEGRATION_BOUNDARY.md) and
[release guide](../../docs/UNIFIED_BUSINESS_RELEASE_AND_TABLET_GUIDE_2026_11_22.md).
Ignored local evidence remains under
`artifacts/calai-business-frontend-20261122/`; it is not part of this package.
