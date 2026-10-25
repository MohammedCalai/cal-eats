# Reference test discovery incident — 25 October 2026

The source-reference inspection was intended to be read-only, including no execution of its scripts. During implementation an agent invoked the inherited root `npm run check`. That command ended with unrestricted `node --test`, which recursively discovered tests under the ignored `reference/calai-platform-ab138fd` folder. Git ignore and read-only file attributes do not prevent execution. This violated the no-reference-execution instruction.

The run completed in approximately 38 seconds. Four reference entry points failed at import because Prisma/Express were not installed: `backend/test-print-flow.js`, `backend/test/live-usage.test.js`, `backend/test/operations.test.js`, and `backend/test/owner-dashboard.test.js`. Dependency-free reference tests did execute, including receipt/email formatting, working hours, request construction, reporting with injected fetch, and webhook helpers with mocked persistence/HTTP. They must not be counted as Cal-Eats validation.

The observed output and static inspection of the executed tests show pure logic or injected test doubles; no original server, database, migration, seed, bridge installer or production endpoint was observed executing. This is source/output evidence, not an independent network packet capture. No original repository write or deployment action was performed.

After the run, all 364 selected reference files were SHA-256 compared against their exact entries in the pinned downloaded archive: **364 matched, zero mismatches**. They retain read-only attributes. No original dependencies were installed in the reference.

The root `test` script now explicitly names only Cal-Eats API, browser, portal, print-bridge and local-script test files. `check` invokes that bounded script. Mobile checks are also explicit. Future validation must never use unrestricted recursive test discovery from the workspace root. The reference stays excluded from Git, Docker context and release packaging. This incident is preserved rather than describing the original source as never executed.
