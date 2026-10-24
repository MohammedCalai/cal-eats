# Calai Eats local runbook

This runbook covers the dependency-free local Node.js demo. It does not deploy services, contact payment providers, or perform a live restore. All people, restaurants, orders and credentials in the seeded dataset are fictional local fixtures. See the repository README for the current demo account credentials; never reuse them elsewhere.

## Start and verify

From the project root with Node.js 24.19 or newer:

```text
npm run db:migrate
npm run db:seed
npm test
npm run check
npm run smoke
npm start
```

The seed command is explicit and idempotent. The app listens only on its documented local address. Keep the terminal open while using the browser preview.

## Create a consistent backup

The backup command reads `data/calai-eats.sqlite` in read-only mode and uses SQLite's online backup API, so committed WAL data is included without stopping or modifying the active database. It creates a uniquely timestamped file directly under `backups/`. The destination is reserved atomically, so concurrent attempts cannot overwrite each other.

```text
npm run backup
```

Direct command equivalent:

```text
node scripts/backup.js
```

An explicit source may be inspected read-only. Explicit destinations must be direct-child `.sqlite` files in this project's real `backups/` directory; nested and redirected paths are rejected:

```text
node scripts/backup.js --source data/calai-eats.sqlite --destination backups/manual-checkpoint.sqlite
```

Treat backups as private customer and merchant data. Store them only in an access-controlled location, do not email or commit them, and remove copies through the organisation's reviewed retention process.

## Verify a backup before considering restore

Run the restore check against the exact backup reported by the backup command:

```text
npm run restore:check -- backups/calai-eats-YYYY-MM-DDTHH-MM-SS-sssZ.sqlite
```

Direct command equivalent:

```text
node scripts/restore-check.js backups/calai-eats-YYYY-MM-DDTHH-MM-SS-sssZ.sqlite
```

The checker copies the backup into a unique temporary directory, opens only that copy, runs SQLite integrity and foreign-key checks, and verifies the expected schema and migration records. It never writes over the live database and removes only its verified temporary directory.

## Reviewed restore plan

There is deliberately no automatic restore command. For a recovery exercise:

1. Stop the local app and record the exact source database and selected backup paths.
2. Run the restore check above and keep its result with the recovery record.
3. Preserve the current `data/calai-eats.sqlite` and its `-wal` and `-shm` companions as a separately named incident snapshot; do not overwrite or delete them.
4. Copy the verified backup to a new, unused database filename.
5. Start the app with `CALAI_DB_PATH` pointing to that new file, then run readiness, tests and smoke checks.
6. Compare expected users, restaurants, orders and financial records before deciding whether to adopt the recovered file.
7. Make any replacement of the normal database a separate, reviewed manual action while the app is stopped.

## Policy draft outlines — business and legal review pending

These are planning prompts for counsel and business owners, not legal advice or approved customer terms.

### Privacy outline

- Identify the operator and contact route.
- Describe account, contact, address, order, support, merchant and operational data used by the service.
- Define purposes, lawful bases, recipients, retention periods, security controls and user request handling after jurisdiction-specific review.
- Explain local demo data, production analytics or processors only when those systems are actually chosen and verified.
- Document incident response, children's data position, international transfers and policy-change notices after review.

### Customer terms outline

- Define the ordering parties, restaurant responsibilities and Calai Eats' role.
- Explain displayed prices, delivery charges, payment methods, cancellations, refunds, allergens and customer contact details using approved operational rules.
- State complaint, support and account processes, acceptable use and availability limitations.
- Add governing law, liability, consumer-right and dispute terms only after qualified review.

### Merchant terms outline

- Define onboarding, authority, menu accuracy, allergens, opening hours, delivery/collection operations and staff access.
- Document the proposed commission, calculation base, taxes, settlement, refund and reconciliation responsibilities only after finance and legal approval.
- Cover suspension, support, data handling, records, service changes, termination and dispute processes.
- Keep the local `demo-v1` contract record clearly separate from an accepted commercial agreement.
