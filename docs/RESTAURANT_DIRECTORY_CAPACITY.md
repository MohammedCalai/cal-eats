# 10,000-restaurant directory check

8 November 2026. This is evidence for directory browsing and filtering, not certification that the current hosting can support 10,000 trading businesses. Raw observations are in [RESTAURANT_DIRECTORY_LOAD_RESULTS_2026-11-08.json](./RESTAURANT_DIRECTORY_LOAD_RESULTS_2026-11-08.json).

## What changed

Discovery still applies postcode, cuisine, keyword, promotion/category filters and ordering before its bounded page limit. Menu terms, rating count/average and recent-order counts are now hydrated with grouped queries for only the returned restaurant IDs. An ordinary anonymous page executes four SQL statements whether it contains one, fifty or one hundred restaurants; signed-in discovery adds one marketing-consent check. Popularity ranking still computes the matching directory's ordering before pagination, then uses three statements for its returned anonymous page.

Before this change, menu terms reused one prepared statement but executed it separately for every returned restaurant. Rating and popularity counts also used correlated subqueries inside the directory query. Preparing a statement and executing a statement are different counters; the recorded before/after results retain both.

## Isolated scenario

Run `node scripts/load-marketplace.js --directory-capacity` from the repository root. The original mixed-order harness remains unchanged unless this explicit mode is selected. The directory mode creates a fresh synthetic SQLite file under ignored `artifacts/`; it never opens the application database. Its loopback HTTP child receives a minimal environment, no provider secrets, local simulated-payment mode and no background worker loops. All requests are anonymous directory GETs. It creates no real accounts, sends no messages, places no orders and contacts no external provider.

The dataset contains **10,000 restaurant records, 200,000 menu items, 50,000 synthetic historical completed orders and 20,000 ratings**. One impossible-to-authenticate synthetic customer satisfies historical-row foreign keys; this does not model 10,000 restaurant logins or their customers. Historical order rows are browsing fixtures, not a validated financial ledger. No image bytes are allocated or downloaded.

Eight HTTP clients walked all 200 pages of fifty restaurants. Every one of the 10,000 restaurant IDs appeared exactly once, with the expected ordering, correct final-page flag and no oversized page. Additional checks covered an empty page, a rare menu keyword in the last restaurant, cuisine, postcode, popular ranking, free delivery and quick ranking. All direct-query results matched the reviewed discovery implementation from commit `a52cdb699cf54df8977cbc9ed9715824d1c9e6e3`.

## Observed results

The recorded run made **209 real loopback HTTP requests with zero errors**. Median response time was 21.05 ms, 95th percentile 41.22 ms and maximum 85.08 ms. The largest response was 129,084 bytes. These are short local warm-cache observations, not production service targets.

| Direct query | Executions before → after | Median before → after |
| --- | ---: | ---: |
| First 50 restaurants | 51 → 4 | 1.69 → 1.09 ms |
| Last 50 restaurants | 51 → 4 | 4.17 → 3.89 ms |
| 100 restaurants in a cuisine | 101 → 4 | 4.00 → 3.70 ms |
| Popular ranking | 51 → 3 | 16.56 → 16.81 ms |
| Rare menu keyword | 2 → 4 | 95.65 → 95.45 ms |

Only three direct timing samples were taken per case. The stable finding is the bounded SQL execution count and unchanged results; small timing differences are not a statistical performance claim. Substring menu search and whole-directory popular ordering remain substantially more expensive than a normal page.

## Remaining capacity gates

- **Image storage:** 100 MB per business is an allowance, not preallocated hosted capacity. At full use, 10,000 businesses require **1 TB of image bytes alone**, before database overhead, write-ahead logs, backups and retained versions. Move image bytes behind the reviewed storage adapter/object-storage plan, preserving visibility controls, tenant quotas and deletion behavior. Exercise real representative image traffic and restore behavior separately.
- **Database and workers:** API handlers currently share synchronous SQLite connections and the main process also runs background cycles. SQLite WAL permits only one writer at a time and requires clients on the same host. Current Railway volume services cannot use replicas. A shared multi-connection database and independently claimed worker queues require an explicit migration and failure/recovery tests before horizontal deployment.
- **Queues and notifications:** Bounded email/push jobs provide safety but do not prove peak drain rate. For example, the default weekly-statement budget is 25 per minute; 10,000 due statements need at least 400 minutes before network/processing time. Long expiry/outbox transactions and notification fan-out must be bounded and measured with the expected live workload.
- **Clients and older endpoints:** The current customer ScrollView retains appended restaurant cards rather than virtualizing a large loaded list. Some legacy finance/operations routes still materialize all matching rows before slicing or reporting, even though the newer admin workspaces paginate in SQL. Those paths need their own bounds and UI checks.
- **Acceptance workload:** Agree peak simultaneous customers/tablets, orders per minute, historical retention volume, provider limits and latency/availability targets. Then exercise checkout/idempotency, tenant isolation, message fan-out, worker backlog recovery, large exports, image upload/download, database migration and restore under that workload. This directory result proves none of those production properties.

Primary references: [Node 24 DatabaseSync semantics](https://nodejs.org/download/release/v24.19.0/docs/api/sqlite.html#class-databasesync), [SQLite WAL concurrency](https://sqlite.org/wal.html#concurrency), [Railway volume limitations](https://docs.railway.com/volumes/reference#caveats).
