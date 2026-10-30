# Operations and developer handover runbook

This runbook supports review and isolated staging. Production deployment, existing-data migration, credential changes and printer handover still need the approved operational scope. Do not interpret a passing test suite as approval to perform them.

## Access and ownership

The repository owner grants individual GitHub access and configures protected-branch checks. Hosting, Stripe, Microsoft mail, Expo/store and restaurant device owners grant separate staging access. Store values in the authorised secret manager; record only secret names and owners in handover documents. Use synthetic recipients and provider test accounts, with live-payment and external-statement sending disabled. No credentials are included in this branch.

Before a release, record the reviewed commit/image digest, exact API origin, database path/volume, schema version, provider mode, backup destination, secret versions and responsible operator. Both native clients and the tablet share the backend, so their compatibility is part of release acceptance.

## Database preflight and migration control

`npm run db:check -- --database <existing.sqlite>` opens the database read-only, checks release/schema compatibility, integrity and foreign keys, and refuses a missing file rather than creating one. Without an argument it uses `CALAI_DB_PATH` or the documented local path. It prints counts/versions, not customer records. Schedule a full integrity check appropriately for database size; read-only does not mean zero I/O cost.

In reviewed staging, set `CALAI_MIGRATE_ON_START=false` after the approved explicit `npm run db:migrate` step. The API then requires current migration history before starting workers/listening. Missing migrations, newer schema, gaps or changed migration names stop startup. An existing compatible release without this setting retains the previous automatic migration behaviour.

Use restored synthetic or authorised redacted copies to rehearse upgrades. Preserve migration files once released. This batch validates names/versions; it does not add historical SQL checksums. Do not edit migration records merely to bypass a refusal. Investigate which release owns the schema and choose an actually compatible image/database pair.

## Backups and restore checks

- `npm run backup` uses `CALAI_DB_PATH` and the managed `CALAI_BACKUP_DIR`. An explicit `--source` overrides the source. Destination must remain a direct-child `.sqlite` within the managed backup directory and cannot overwrite an existing file.
- Both commands load a local `.env` if present; container/server configuration normally comes from the environment. Default paths are local `data/calai-eats.sqlite` and `backups/`, or container `/data/calai-eats.sqlite` and `/data/backups`.
- The online SQLite backup includes committed WAL data. Only the backup copy is sanitized and vacuumed: ordinary order and customer chat bodies/read-state/rate buckets are omitted per the existing temporary-message policy. Thread/workflow metadata, sequence counters, formal support/dispute/incident records and finance/order data remain under their separate policies.
- `npm run restore:check -- <managed-backup.sqlite>` checks a temporary copy for integrity, foreign keys and required tables. It does not replace a database. Run `db:check` on the staged restored database as a separate application/schema compatibility check.
- Backups on the same volume are not disaster recovery. The operator must arrange protected off-host copies, matching encryption-key escrow, retention/access controls and measured recovery drills. Existing backups are untouched by this source change; any retention cleanup needs its own authorised procedure.

The image now includes `scripts/backup.js`, `scripts/restore-check.js` and `scripts/database-check.js`. Local Docker is unavailable in the development environment; the CI container job builds and checks these paths without starting the API. A successful CI image build still needs runtime/volume/health validation in isolated staging.

## Error triage

Record the failed response's `X-Request-Id`, timestamp, HTTP status and the user-observed action. Find the matching JSON `request_failed` record in server stderr. It contains method/status/duration and a controlled error code, without raw URL/query, headers, tokens, customer content or error stack. Correlate that ID in the approved log store; do not ask operators to paste private request payloads into public issues.

The first batch logs caught 5xx request failures only. It does not add a monitoring backend, success-request histogram, provider trace, worker heartbeat or alert configuration. Set retention/access and escalation ownership before enabling central collection.

For late notifications, refresh authoritative order state. Reconnect now drains bounded pages and respects recipient/session checks. A removed cursor can replay retained event IDs, so consumers must deduplicate by notification ID. Notification replay must never itself create a payment, order or physical print.

## Staged acceptance and rollback

1. Run the complete developer checks and review the CI Linux, Windows and container results. Verify the precise diff and unchanged product/business rules.
2. On a separate staged database, prove read-only preflight, backup and restore, compatible startup, authentication/tenant boundaries and the original customer/restaurant order flows.
3. Confirm this batch contains no new migration. Still verify deployed migration history against the new compatibility guard before considering rollout; legacy name drift or gaps will now refuse startup.
4. If application rollback is needed, choose a release compatible with the current database. Turning migrations off does not make an older application compatible with a newer schema.
5. Do not restore over new orders/payments or restart competing printer consumers as an automatic rollback. Preserve evidence and reconcile provider/device outcomes before any separately approved recovery operation.

## Independent-team acceptance

- [ ] A developer with a fresh checkout completes install and all validation without production credentials.
- [ ] Repository owner reviews CI permissions and makes the agreed successful checks required on the protected branch.
- [ ] Hosting owner confirms actual deployed commit/configuration/volume and approves an isolated staged rollout.
- [ ] Database history compatibility and backup/restore/key recovery are demonstrated, with measured recovery time.
- [ ] Operators can find a sanitized error by request ID and know the escalation owner.
- [ ] Product owner signs off preserved ordering, finance, history and retention rules.
- [ ] Printing, payment reconciliation, external recovery mail, security and scale gaps from the remediation record have owners and follow-up milestones.
- [ ] Production migration/deployment/device actions remain separately reviewed and authorised.
