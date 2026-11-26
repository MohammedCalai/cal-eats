# Media and discovery capacity

Each business has a separate 100 MB (100,000,000 bytes, decimal MB) allowance for its cover and menu item images. The existing JPEG/PNG, 1 MiB per image and 4,096-pixel dimension limits remain. This is the cover/menu image collection; there is no separate general-purpose asset library. Upload and removal responses expose used, remaining and maximum bytes. Replacement checks the tenant and available space inside a `BEGIN IMMEDIATE` transaction and credits only an old image that can actually be deleted. A failed replacement rolls back its changes. Existing `/api/media/:id` URLs and image visibility rules remain.

Migration 35 adds tenant-scoped image accounting, image-reference, menu, membership and restaurant discovery indexes. Apply the migration through the normal release process. Discovery filtering now runs in SQL before pagination, and menu search terms and 30-day popularity counts are generated only for the selected page. `/api/restaurants?page=1&pageSize=50` retains its `data` array and adds `pagination: {page,pageSize,hasNext,hasPrevious}`. Default page size is 50 and maximum is 100; ordering is restaurant name then ID. Clients must request subsequent pages to reach all restaurants. Filters apply across the directory before paging. Deep offset pages, substring search and postcode JSON matching still require increasing database work; no full-text or geographic search service is implemented.

**This release is not certified for 10,000 production restaurants.** The deployed default still stores images as BLOBs in the same SQLite database on one persistent volume, and writes use SQLite's single-writer coordination. At 10,000 businesses using their full allowance, image bytes alone total about 1 TB, before database overhead, write-ahead logs, backups and retention. The quota is an allowance, not a reservation of hosted disk space. No new hosting capacity, concurrent-user benchmark, 1 TB restore drill or production-scale readiness validation has been performed.

Before rolling out at that scale, move image bytes behind a storage adapter to object storage and a CDN while retaining the public media URL contract and private-image authorization. Keep tenant IDs and immutable asset IDs in object keys, validate bytes before publication, reserve/release quota atomically, and reconcile failed or abandoned uploads. Move relational data to a managed multi-connection database such as PostgreSQL when deployment and measured write concurrency require it. Test migration, tenant isolation, peak discovery/checkout concurrency, image delivery, backup restoration and operational disk alerts against an agreed production target before declaring readiness. Financial and commission behavior is unchanged by this capacity work.

## Optional private object storage preparation (8 November)

Migration 56 adds tenant-bound immutable object metadata and a durable cleanup queue. `CALAI_MEDIA_STORAGE=database` is the default. Object-backed storage requires a dedicated private versioned bucket and credentials restricted to the Cal-Eats image prefix.

When explicitly enabled, new uploads retain `/api/media/:id` URLs and the same100,000,000-byte allowance per business, but put image bytes in object storage rather than the order database. Validation precedes upload; the final database transaction rechecks tenant ownership and quota after the network operation. Failed and interrupted uploads retain a durable cleanup reservation. Replacing or deleting an image queues cleanup only once no menu/cover references it. The bounded cleanup worker runs independently of payment-worker failures.

The adapter verifies an immutable object version, byte length, MIME type and SHA-256 before publication. Every read requests that exact version, checks its bytes and rechecks restaurant visibility after awaiting storage. Pending, suspended, archived or private media keeps its authorization checks. Storage failures return a generic temporary error without credentials or provider details. Current delivery still goes through the API; CDN and large-volume delivery throughput have not been validated, and no broad browser security-policy exception was added.

Set `CALAI_MEDIA_STORAGE=s3` for a provider that implements conditional creation, or `CALAI_MEDIA_STORAGE=b2` for Backblaze B2. Both modes use `CALAI_MEDIA_S3_BUCKET`, `CALAI_MEDIA_S3_REGION`, `CALAI_MEDIA_S3_ACCESS_KEY_ID`, `CALAI_MEDIA_S3_SECRET_ACCESS_KEY`, and optional `CALAI_MEDIA_S3_FORCE_PATH_STYLE`. Set the provider's HTTPS origin using `CALAI_MEDIA_S3_ENDPOINT` when applicable. B2 requires its matching regional `https://s3.<region>.backblazeb2.com` origin. Only uploads confirmed to have an immutable version ID can be published. Existing database-backed images remain readable alongside new object-backed images.

B2 appends an immutable version on each upload. Cal-Eats reserves a fresh random key for each image write or relocation attempt, submits each B2 upload once, and binds the exact returned version after verification. Reads and backups use only that exact version and checksum, even if a newer version of the same key exists. Cleanup applies a delete marker by key and checks that B2 acknowledges it. Keep all versions and use a bucket- and prefix-scoped integration key with read and write access for image operations. Keep permanent version deletion authority separately controlled.

### Moving existing covers and menu photos

Run the operator script from the deployed Cal-Eats release. The read-only plan reports image counts and byte lengths without opening an object storage connection. It checks the schema and recorded sizes; the apply step validates each selected image's bytes and dimensions.

```sh
node scripts/migrate-media-to-objects.js --plan --db /data/calai-eats.sqlite
```

1. Take a verified Cal-Eats database backup. Enable versioning and verify storage access with the dedicated Cal-Eats bucket credentials. Deploy the matching configuration to every Cal-Eats API process before relocating any existing images. Test an approved upload and fetch in the matching environment. Confirm anonymous access is denied and the original version remains readable after a name-only deletion. For B2, confirm the original version also remains readable after appending different bytes to the same synthetic key.
2. Apply a one-image batch and check its existing cover or menu photo URL. Then continue in bounded batches until `inlineImages` is zero. The script defaults to 25 images and accepts at most 100 per batch. A failed `put` or read-back stops the batch. A malformed inline image is counted and remains available from its source bytes for investigation. A failed batch exits with a nonzero status and can be retried after resolving its reported failure.

   ```sh
   node scripts/migrate-media-to-objects.js --apply --db /data/calai-eats.sqlite --limit 1
   node scripts/migrate-media-to-objects.js --apply --db /data/calai-eats.sqlite --limit 25
   ```

3. Verify another read-only plan, check representative customer and owner photo URLs, take a new database backup, and verify every referenced object version against the backup as described below. SQLite can reuse freed image pages for future writes; its file size may remain the same. Treat any file compaction as a separately scheduled database-maintenance action.

Each relocation uploads to a tenant-scoped immutable key, reads back the exact version, and compares its byte length and checksum before changing the database. A short SQLite transaction binds the version and clears the inline bytes together. IDs, photo URLs, cover and menu references, and the 100 MB allowance use the same saved metadata after relocation. Concurrent replacement or deletion takes precedence. Abandoned upload attempts enter the ordinary object cleanup queue. A rerun skips versions already bound. Once any image is object-backed, keep its matching bucket available to every release that serves it, including during rollback.

### Backups, restoration and later Calai migration

Database backups preserve immutable object-version references and write a `.media-objects.jsonl` sidecar when external images exist. This inventory is **not a backup of object bytes**. Keep those object versions and their independent backups for as long as a retained database snapshot references them. The application never permanently deletes an object version: cleanup only removes the current key. Provider lifecycle rules and backup retention must be reviewed together before activation.

On an isolated database backup, `scripts/verify-media-objects.js <snapshot.sqlite> <private-proof.json>` reads and checks every exact referenced version with the matching private storage connection, without writing to storage or the source. `restore-check.js` requires that proof and its pinned SHA-256 (using `--media-proof` and `--media-proof-sha256`) in addition to the independent privacy suppression ledger before granting restore clearance. An integrity-only database check explicitly reports external image versions as unverified. Local tests cover a replaced image remaining recoverable through its saved object version.

The catalog migration export carries the image checksum and backend/key/version references without any storage credentials. `--include-media` fails explicitly if external versions require a separate storage transfer; it cannot emit a misleading complete-images package. The future combined Calai migration must copy/verify the referenced private object versions, reconcile stable source IDs, and review the privacy ledger before cutover. No original Calai data or infrastructure was modified.

### Remaining production capacity work

The directory scenario below proves browsing behavior at10,000 restaurants, not simultaneous operation by10,000 businesses. Before broad rollout, measure realistic concurrent order creation/confirmation, messaging, device notifications, provider retries, weekly statement throughput, image reads/uploads and recovery on the intended infrastructure. The current database and in-process workers remain a single-host architecture. A managed relational database with safe concurrent transactions, separately deployable leased workers, region/search indexes and monitored versioned object storage/CDN are still deployment and migration work; no production capacity claim follows from the local directory result.

Focused local verification covers the exact quota boundary, replacement rollback and reclamation, separate tenant allowances, stable pagination and filters finding restaurants beyond the first page. These checks validate behavior; they are not a production load test.

The later [10,000-restaurant directory check](./RESTAURANT_DIRECTORY_CAPACITY.md) uses real synthetic restaurant/menu/history rows and walks every bounded HTTP page. Per-page menu terms, ratings and recent-order hydration now use grouped queries. That check excludes image bytes, checkout, active-business concurrency and production infrastructure; it does not change the scale limitations above.
