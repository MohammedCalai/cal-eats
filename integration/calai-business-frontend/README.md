# Calai business frontend review package

This is a reviewable frontend-only patch retained in the Cal-Eats feature
repository. **It has not been applied to the original Calai repository or
deployed.** It includes no full source checkout, dependencies, compiled assets,
credentials or machine-specific paths.

Baseline: `calai-operation/calai-platform` commit
`dec58e32f9fffff16ffc5409a4ba3369193ad68c`. The downloaded archive SHA-256 is
`ac0b3631c40d60e5f3728a021b77ad31c9182cd824be2cd6076e614fc89aa69d`.
The current remote/production source baseline remains unverified.

- [The exact tested patch](calai-business-frontend.patch) changes four existing
  frontend files and adds three frontend files. Native login, settings, existing
  controls and the startup address remain in place.
- [Manifest](manifest.json) records the seven paths, before/after hashes, patch
  hash, tests and isolated build result.
- [Protected file hashes](protected-file-hashes.json) records 139 unchanged
  candidate frontend files and 314 original snapshot files matching the archive.

Verification completed: eight message-protocol tests passed; five JSX files
parsed; patch applicability and protected-file checks passed. The complete
candidate passed its existing `vite build` in a separate ignored artifact copy
after `npm ci --ignore-scripts` using only the official npm registry. Package
manifests and Vite configuration remained unchanged. The build took 40.90 seconds
and reported a large-chunk warning (main JavaScript approximately 2.17 MB before
gzip). This does not establish physical Surface operation, authenticated
two-product UAT or a production release.

**Release blocker:** verify the current authorised frontend source and an
already-supported frontend-assets-only publication and rollback route. The
reviewed container deployment is not permitted for this task. Do not alter
Calai's host, containers, backend, database, runtime, authentication, proxy,
printer service or deployment configuration to apply this package.

See the [boundary report](../../docs/CALAI_FRONTEND_INTEGRATION_BOUNDARY.md) and
[release guide](../../docs/UNIFIED_BUSINESS_RELEASE_AND_TABLET_GUIDE_2026_11_22.md).
Ignored local evidence remains under
`artifacts/calai-business-frontend-20261122/`; it is not part of this package.
