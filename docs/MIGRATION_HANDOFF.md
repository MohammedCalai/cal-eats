# Cal-Eats / Calai future migration handoff

This prepares a reviewed export contract and a later developer-led migration. **No combination, live integration, shared sign-in, original Calai data migration or provider migration has been performed.** The original Calai application, repositories, databases, credentials, tablets and printers remain read-only throughout this work.

The Cal-Eats customer app, Cal-Eats Admin phone app and business tablet platform already use one Cal-Eats backend. The phone app must not create another restaurant, customer or order database. Platform administrator controls remain a restricted role inside the business platform; the restaurant phone app does not grant that role.

## Source evidence and architecture

The static source audit is [SOURCE_BACKEND_AUDIT.md](SOURCE_BACKEND_AUDIT.md), using `reference/calai-platform-ab138fd` at commit `ab138fd17c9ac4fc6e0b34ef5044754be643056c`. Its manifests and Prisma schema were read; original startup scripts, migrations, seeders and provider workers were not run. This snapshot is a historical reference, not a claim about the current production database.

Original Calai is **Node/Express, Prisma/PostgreSQL and React**, with Redis, Vapi/voice services and separate SaaS subscription billing. It is not the earlier assumed Laravel system. Cal-Eats currently uses Node 24, SQLite, React business/customer previews and Expo/React Native app source. A later shared PostgreSQL backend requires an explicit data/transaction/worker port. A visual match does not make the schemas or authentication systems interchangeable.

## Identity and tenant mapping

Every exported record has a system-qualified `sourceId`, for example `cal-eats:restaurant:<uuid>` or `cal-eats:user:<uuid>`. Composite identities include each encoded key, such as `cal-eats:membership:<restaurantUuid>:<userUuid>`. `sourceKeys` retain the original local primary-key components; `links` contain qualified related identities. `values` contain only the explicitly allowlisted business fields. The export contract uses source column names deliberately and is versioned as `cal-eats.migration-package.v1`.

Reserve a separate `calai:<entity>:<id>` namespace for any future, independently approved Calai export. This exporter does not read or manufacture Calai records. Equal UUIDs, email addresses, business names or customer names across the two systems do not establish identity.

`source-id-mapping-template.json` leaves every target system/entity/ID null and every decision `unreviewed`. The dev team must record an explicit approved mapping, the supporting evidence, reviewer and review time before linking identities. Preserve this mapping as an audited crosswalk and keep stable aliases for existing Cal-Eats restaurant/order URLs and native API identifiers.

| Original Calai concept | Cal-Eats concept | Required migration decision |
|---|---|---|
| `User` | `users` with customer, restaurant or administrator role | Verify identity and permission separately. Never promote a matching email to administrator or restaurant owner. Guest order contact details are not registered customer accounts or marketing consent. |
| `Business.ownerId` and `UserBusiness` | `restaurants` and explicit `restaurant_memberships` owner/staff permission | Map every business and membership explicitly. Do not select a user's first owned business or rely on global role alone. Preserve suspension and tenant access checks. |
| `Item` with floating-point `price`, category and voice-agent reference | Integer-pence `menu_items`, scoped modifier groups/options, allergens, dietary tags and photos | Review currency conversion and rounding. Voice-agent references are not menu ownership. Source group/option IDs are scoped to their menu item and receive qualified fragment IDs in the package. |
| `BusinessSetting` | Restaurant hours, holiday dates, delivery outcodes, fees/minimums, pause/busy state | Preserve Europe/London and overnight intervals. Map delivery/collection explicitly. Restaurants provide their own drivers; no Calai courier fleet is implied. |
| Voice-linked `Order`, `OrderItem`, `Call` | First-class web/native orders and immutable order-line/payment/commission snapshots | Original `Order.callId` cannot remain a mandatory prerequisite for imported web/native orders. Do not infer paid status from call confirmation or a phone transfer. Preserve unknown/unpriced history for review. |
| `Printer` and `PrintJob` | Restaurant printer inventory and scoped device/job protocol | Inventory names may map; device identities and pairing credentials must be issued afresh. Completed jobs must remain completed and must not automatically print again. |
| `Plan`, `Subscription`, `Invoice` | Separate from marketplace orders, commission, refunds and restaurant payouts | Calai's SaaS billing is a different financial context. Do not use subscription status or its Stripe credentials as evidence of an order payment. |

Accounts do not carry passwords, browser/native sessions, access/refresh/reset tokens or device tokens in this export. Plan an approved reauthentication/invitation/recovery process; do not copy original Calai JWT/session material or silently add global SSO. Cal-Eats Admin and the customer app retain separate secure device token stores while using the same underlying account/tenant model. Revoke or expire old browser, customer-native and business-native sessions at the agreed cutover boundary.

## What the exporter does

`scripts/export-migration-package.js` is a local, read-only exporter. Its default invocation is a **dry run** containing counts, selected-field coverage and integrity/link/money checks only. It does not print customer or account records. It opens SQLite with `DatabaseSync({ readOnly: true })`, sets `PRAGMA query_only=ON` and reads inside one snapshot transaction. It does not migrate, checkpoint, vacuum, seed or update the source.

Only managed Cal-Eats `.sqlite` files beneath this project's `data`, `artifacts` or `backups` directories are permitted. Canonical paths are checked; original/reference, Git/config and outside-project paths are rejected. The tool never reads `.env`, encryption-key files, original Calai settings or external services.

Examples from the repository root:

```powershell
# Counts and coverage only, on the fictional local fixture.
node scripts/export-migration-package.js --source artifacts/business-phone-demo.sqlite

# Create a new catalog package, including menu photo bytes where present.
node scripts/export-migration-package.js --source artifacts/business-phone-demo.sqlite --write --include-media

# Explicitly include private accounts and historical order/finance records.
node scripts/export-migration-package.js --source artifacts/business-phone-demo.sqlite --write --include-accounts --include-orders --include-media
```

`--write` can create only a new timestamped directory beneath ignored `artifacts/migrations`. Existing output is never overwritten. Output files use private file modes where supported; the package is not encrypted, so use approved private storage and transport for any package containing real identities or orders. No upload, email, database import or deployment is performed.

| Selection | Included data |
|---|---|
| Default catalog | Restaurants, menu items/options, catalog media inventory/hashes, restaurant loyalty thresholds and canned order-message settings. Business contact/location details may be present. |
| `--include-media` | Exact menu/restaurant image bytes plus their inventory IDs, MIME, dimensions, length and SHA-256. It does not copy refund evidence images. |
| `--include-accounts` | Allowlisted customer/business/admin identity fields, saved addresses, tenant memberships, promotion-consent records, restaurant customer follow-up statuses and printer inventory. Private CRM note text and authentication material are excluded. |
| `--include-orders` | Historical orders/lines/events; accepted contract/commission snapshots; commission ledger and balanced journal postings; refund/case/remedy metadata and evidence inventory; offer campaigns/grants; settlement/transfer/cash/payout reference records. Historical order addresses, contact snapshots and allergy notes are private data and are included by this explicit flag. |

The package contains one JSON file per selected entity, a source-ID mapping template, `manifest.json` and `manifest.sha256`. The manifest records the source schema version, counts, included/excluded/missing fields, omitted tables, qualified source identities, each data/asset file's bytes and SHA-256, and the source validation results. The manifest's own digest is in `manifest.sha256`. A failed write leaves `INCOMPLETE.txt`; a package with that marker is not usable.

True exported entity links must resolve within the package. References to omitted user identity records are explicitly counted as deferred identity links; a catalog or order-only package is not permission to infer those users. Journal group identifiers receive `group_source_id`; audit references carry a source-context type/key and qualified ID, and recognised commission-ledger reference types are also qualified links. Historical provider IDs and audit-reference type/key pairs are not global target IDs. `sourceKeys` and historical snapshot values must be retained for reconciliation even where a target ID is remapped.

## Immutable history and money

Preserve integer pence, GBP currency, quantities, paid item/modifier/allergen snapshots, gross food, discounts and their allocations, delivery fees, total charged, payment state, the accepted commission base/rate/version and refund allocations. Never recalculate historical orders using a current menu, current restaurant name/price, current discount or a newly configured commission rule. A missing legacy snapshot is a review item, not permission to invent a paid amount or assume a zero.

Keep original Calai historical float values as source evidence while agreeing a documented conversion/reconciliation policy. Source voice-order confirmation is not verified card authorization/capture. Do not retrospectively charge commission or move money for uncertain legacy payments.

The exporter checks SQLite integrity/FKs, selected cross-tenant menu/media/order/refund links, integer-safe money fields, order total arithmetic and balanced debit/credit journal groups. Journal balancing is scoped by restaurant, provider mode, group and currency. Optional financial totals retain per-restaurant order/payment-method, commission-ledger and journal account/direction/provider-mode totals. Aggregate `restaurant_id` fields are original source keys and must be resolved through the qualified crosswalk before target comparison. These checks help reconcile an export; they do not constitute an independent accounting audit or prove Stripe/bank settlement.

Marketplace customer charges, restaurant transfers, actual bank payouts, refunds, transfer reversals and cash commission receivables must remain distinct. Cal-Eats Connect account IDs and sandbox/live modes remain bound to the separately confirmed Cal-Eats Stripe platform. Provider object IDs are historical references, not credentials or authority to replay an operation. The exporter excludes checkout URLs, provider payloads, worker leases/retry keys and operational queues. It does not activate or copy a bank mandate; even exported mandate inventory/reference records require separate approved provider verification before use. Never import Calai SaaS billing keys or reinterpret its subscriptions/invoices as marketplace money.

## Deliberate coverage gaps

- Temporary order and persistent customer chats have the current 30-day retention policy. Their ciphertext, read cursors, rate-limit buckets, thread sequence state and notification/outbox records are excluded. They must not be copied into a permanent migration archive by default.
- Support correspondence, formal refund-case messages/events, private CRM notes and fulfilment/evidence contents are not covered by this exporter. It includes case metadata and evidence inventory, not the complete legal/support file. Agree retention, lawful purpose, recipient access, attachment hashes, redaction and an approved separate transfer before migrating such material.
- Message encryption keys remain outside the package, backups and Git. A separately approved correspondence handoff must specify whether to decrypt/re-encrypt within controlled services or transfer keys through a separate secured process. This tool performs neither operation.
- Printer pairing codes, token hashes, device credentials, claim tokens, network/device details and queued receipt payloads are excluded. Fresh tenant-bound pairing and a physical paper test are required after any later move.
- Operational jobs, provider events/state caches, retry/idempotency execution keys, sessions, reset tokens, mail-sink contents and notifications are excluded. Do not resume old external jobs from the archival order records. Unfinished captures/refunds/transfers require an explicit provider reconciliation and approved resume plan.
- Audit tables and unsupported/new schema fields are listed in manifest coverage rather than silently exported. This is not a lossless full-system backup, a production-ready importer or a complete merge. Keep separately verified backups of both source systems and their approved asset stores.

## Developer cutover and rollback checklist

1. Confirm the approved destination architecture, owners, purpose/retention scope, source revisions and business/account mapping. Take consistent, restore-tested backups of both systems and approved media. Keep original Calai untouched during rehearsal.
2. Build an idempotent staging importer against this exact contract version. Reject unknown versions, credential fields, path traversal, missing files, digest/byte-count mismatches and incomplete markers. Validate every mapped identity, role, tenant relation and nested menu ID; do not attach an account by email alone.
3. Rehearse on isolated databases with all provider/payment/printer/email workers disabled. Import catalogs first, explicit approved identities/memberships next and historical orders/financial records as archival state. Record the target IDs alongside every qualified source ID. Test both native apps and tablet routes against the same migrated records.
4. Reconcile counts and each restaurant/currency's order totals, commission, refund allocations, ledger, balanced journal groups, outstanding cash receivables, provider transfers and actual bank payouts. Review pending/unknown operations individually with authoritative provider facts. Check hours/outcodes, modifiers, photos, customer consent, open cases and agreed correspondence gaps.
5. Agree a write-freeze/delta strategy before cutover. Record the final snapshot boundary and the policy for orders accepted during the window. Avoid an unreviewed dual-write period or running both provider/printer workers for the same order.
6. Reconfigure only approved Cal-Eats endpoints, fresh authentication/device credentials and reviewed provider webhooks. Verify customer, owner/staff and platform-admin separation; restaurant isolation; menu/order/history; a bounded sandbox payment/refund/transfer flow; help/offer notifications; and one controlled physical print. Do not enable live money solely because imported flags say an account was previously ready.
7. Define rollback triggers, owner and deadline in advance. Keep the crosswalk and new target-write journal. Before redirecting clients back, stop target workers/writes, reconcile all external payment/printing effects and preserve target records created after cutover. Database restoration cannot undo a bank transfer, refund or printed receipt. Never replay money or print jobs blindly in either direction.
8. Sign off only after independent business, data/privacy and financial reconciliation. Retain old read-only access and backups for the agreed period, then apply the approved deletion schedule. A successful rehearsal/export alone is not production acceptance.

## Local acceptance evidence

The demonstrated source is the fictional local `artifacts/business-phone-demo.sqlite`, now schema 25. A dry run and explicit optional write observed 22 restaurants and 83 menu items, with 84 optional identities and 284 optional orders. Integrity, FKs, seven tenant-link checks, integer money, order total arithmetic and journal balance checks passed at the observed snapshot. The private demonstration package contains 40 files under ignored `artifacts/migrations`; it is not uploaded. Counts may change as the local demo is exercised.

The two focused exporter checks passed. The data test uses an isolated consistent copy of that fixture, checks dry-run privacy, forbidden-path/overwrite protection, credential exclusion, media/file/manifest checksums, qualified links, corrupt-link refusal and unchanged copy bytes. If the ignored rich fixture is unavailable in another checkout, the test creates a small synthetic Cal-Eats fixture under ignored artifacts using this project's own migrations. No original Calai data or normal local database is used by the demonstration. Runtime import, production migration, original Calai extraction, provider rebinding, physical devices and rollback execution remain unperformed.
