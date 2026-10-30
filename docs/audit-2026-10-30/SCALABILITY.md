# Scalability assessment — 30 October 2026

## Decision and evidence boundaries

**The accessible build is not validated for 10,000 participating businesses.** There is direct evidence of an expensive discovery path, multiplicative dashboard polling and small worker batches. Business count, registered customers, active sessions, concurrent requests and orders per second are different quantities. No production or hosted load was generated for this audit; no production sizing or availability promise follows from these measurements.

Baseline: commit `b94092ee4657b01d93466a4ddf282155f76a0fa2`, Windows x64, Node 24.19.0, npm 11.17.0, bundled SQLite 3.53.3, Intel i5-1335U, 16 GiB RAM. See [validation evidence](VALIDATION.md), [database review](BACKEND_DATABASE.md) and [payment/printer review](PAYMENTS_PRINTING.md).

## Measurements and source-derived bounds

### Actual discovery route, increasing tenant cardinality

The audit called the existing `routeJourney` implementation of `GET /api/restaurants` against freshly migrated **in-memory** databases with 20 available dishes per approved restaurant and zero historical orders. It measured the handler and response serialization, without HTTP transport or concurrent customers. The 10,000-business child process was terminated when its route budget expired. No normal database was opened.

| Businesses | Menu items | Observed route times | Response bytes |
| ---: | ---: | --- | ---: |
| 100 | 2,000 | 18.01, 13.60, 14.84 ms | 95,190 |
| 1,000 | 20,000 | 1,191.83, 1,168.76, 1,163.22 ms | 953,790 |
| 10,000 | 200,000 | Did not complete within 30,000 ms | Not measured |

Raw evidence: [discovery-results.json](evidence/discovery-results.json). Reproduction: [discovery-benchmark.mjs](evidence/discovery-benchmark.mjs), run from the repository root using `node docs/audit-2026-10-30/evidence/discovery-benchmark.mjs`; results are written beside that script. These few samples do not establish p95/p99, a saturation limit or sustained throughput. Other audit work could consume host resources. In-memory storage and zero order history omit important real costs.

The mechanism is confirmed in `apps/api/src/journey.js:127`: all approved restaurants are selected, a correlated menu concatenation runs for each restaurant, and location/search filtering is subsequently performed in JavaScript. Fresh-schema query plans show menu scans; menu and order-child query plans are in [backend evidence](BACKEND_EVIDENCE.json). Because `DatabaseSync` executes synchronously, a long query occupies its API process's event loop. A server request timeout does not pre-empt the running SQLite operation.

### Existing short benchmark is not 10,000-business evidence

[The 25 October run](../SCALE_VALIDATION.md) recorded 100 restaurants, 2,000 items, 9,900 customers, 20 concurrent customer workflows, 20 simulated printers and 120 orders in 13.832 seconds; 1,521 requests and zero HTTP errors. It used two API processes on one disk, no initial order history, simulated payments and 500 ms worker polling. That is a useful historical correctness exercise, not proof for 10,000 restaurants or current code. A rerun against the current source is recorded separately in [validation](VALIDATION.md); never silently substitute the old passing result for it.

### Request amplification, calculated from current defaults

| Source | Formula | At 2,000 active businesses/devices | At 10,000 |
| --- | --- | ---: | ---: |
| Visible owner dashboard | Six API reads every five seconds | 2,400 requests/s | 12,000 requests/s |
| Idle print bridges | One claim poll every three seconds | About 667 requests/s | About 3,333 requests/s |
| Print heartbeat | One per 30 seconds | About 67 requests/s | About 333 requests/s |

Dashboard evidence: `apps/portal/src/OwnerDashboard.jsx:15,87-89,110,126-129`. Five status lists plus the dashboard request are refreshed together. Hidden-tab checks and in-flight suppression help; latency, jitter and disconnections affect actual traffic. Stream events, focus events and global new-order alerts add reads. The calculations assume fast successful requests and continuously visible dashboards; they are demand estimates, **not measured served rates**.

Printer evidence: `apps/print-bridge/config.example.json`, `src/bridge.js`; default jitter makes these approximate. Claims enter write transactions even when looking for work. Fleet polling load can exceed checkout traffic before a single meal is ordered. Test long polling or event wakeups with jittered fallback after correcting the lease safety issue.

### Worker and notification limits

`apps/api/src/main.js` invokes background work serially at startup and every 60 seconds with a process-local overlap guard. Provider-event reconciliation, the combined Stripe operations worker and weekly statements each default to a batch of 25. Transfers, refunds and reversals share the Stripe worker's batch; they do not each receive 25 slots. Nominal steady-state single-process service rate is at most 25 jobs/minute per such batch if each cycle finishes within a minute, and lower if it runs longer. Statement queueing for 10,000 due recipients needs at least 400 batches (roughly 6 hours 40 minutes at that cadence, with timing and delivery overhead); recipients may outnumber restaurants. Do not multiply workers without auditing ownership and all side effects.

The notification hub consumes at most 500 new rows per one-second tick per process, iterates clients for each row, and revalidates sessions while writing. It has per-user stream limits and buffered-byte safeguards, but no demonstrated global connection capacity. Its reconnect gap above 100 historical events is separately reproduced. See `apps/api/src/notification-stream.js:42-74`.

## Proposed staging workload contract

These are explicit planning assumptions to agree with the business and replace with privacy-preserving observed demand. They are not forecasts. Use a **separate testing repository and staging environment**, synthetic identities, local mail sinks and virtual printers. Full-scale payment throughput runs use an injected deterministic Stripe transport with measured/explicit latency, 429 and ambiguous-error distributions. Real Stripe sandbox contract/reconciliation tests are a separate, bounded campaign within agreed provider limits; never point the full fleet load generator at Stripe. No production endpoints, live credentials, customer database copies or physical kitchen jobs. Use a synthetic call-event provider first; coordinate sandbox telephony limits before provider testing.

Seed 10,000 businesses with skewed cuisine/location and opening hours; 50 items each (500,000 items); 1,000,000 synthetic customer accounts; 10,000 provisioned printers; 90 days of realistic order history. At an assumed 50 orders per business per day that is 45 million orders, approximately 135 million item rows at three items/order and 225 million event rows at five events/order. Stage smaller 1m/10m histories first and justify retention/archive policy before provisioning the full set. Do not extrapolate empty-database results to this history size. Include a few large tenants, 20% of tenants receiving 80% of traffic, staff/owner differences and London daylight-saving boundaries.

| Scenario | Explicit arrivals and concurrency | Duration/purpose |
| --- | --- | --- |
| A: routine trading | 2,000 active restaurants; 10,000 active customers each requesting one browse/menu read every 15s (~667 customer reads/s); 100 active restaurants receiving one order/minute (1.67 orders/s); all 10k bridges online | 30-minute warm-up, two-hour measured baseline |
| B: dinner peak | 5,000 active restaurants; 50,000 customers averaging one browse/menu read every 10s (5,000 reads/s); 1,000 restaurants at one order/minute (16.67 orders/s), 70% card/30% cash | Ramp 10/25/50/100%, then 60 minutes at target |
| C: broad fleet peak | 10,000 visible dashboards and 10,000 bridges; 100,000 customers at one read/10s (10,000 reads/s); each restaurant averages one order every five minutes (33.33 orders/s) | 30 minutes after lower stages pass; exposes present polling demand |
| D: hot-tenant burst | 100 selected restaurants at one checkout/second each (100 orders/s) on top of normal browse load; 10% client retries using the same key | Five-minute burst; hot rows, basket price changes and duplicate suppression |
| E: weekly finance | 10,000 due statements, eligible transfers and recent refunds mixed with B | Measure completion deadline, per-tenant fairness, provider limits and reconciliation |
| F: reconnect/soak | B at 50% for 24h; restart workers, drop 10% of streams/bridges for 15min, then stagger reconnect; replay and reorder provider/call events | Backlog drain, memory/WAL growth, crash recovery and retained invariants |

Active users are not simultaneous requests. At 33.33 checkouts/s and an assumed two-second application response, Little's Law suggests about 67 requests in flight; a 30-second external authentication step produces a different number of pending payment journeys. Generate open-loop arrivals independently of response time, count dropped/scheduled-but-unsent iterations, and report offered versus achieved rates to avoid hiding overload. Account separately for each order's confirmation/status/refund/notification/print/ledger writes. Exercise native polling as well as browser traffic.

## Measurements and proposed acceptance gates

These targets need product/operations sign-off before treating them as service commitments:

- Browse/menu p95 <=300 ms, p99 <=1 s; authenticated operational reads p95 <=500 ms; application checkout creation p95 <=1 s excluding the separately measured provider/customer authentication wait. Track payload sizes and full customer journey time.
- Unexpected HTTP errors <0.1%; report deliberate validation/authorization/429 responses separately. Zero tenant data leakage, duplicated financial posting groups, duplicated canonical orders or lost acknowledged events.
- Paid and confirmed orders become visible within five seconds p95; printer claim delivery within five seconds p95, with physical paper timing tested separately. No automatic redispatch when physical outcome is ambiguous; operator review is an expected safety state.
- Provider events durably accepted promptly, normally reconciled within 30 seconds; zero unexplained payment/transfer/refund discrepancies after controlled drain. Weekly statements finish within a proposed one-hour window, subject to mail/provider limits.
- At target load retain >=30% CPU/memory/database-connection headroom; measure event-loop delay, queue age and database lock time rather than assuming hardware capacity. Alert on any persistent SQLITE_BUSY, stalled worker or growing unacknowledged queue.
- Recovery targets to agree: proposed order-data RPO <=5 minutes and RTO <=30 minutes. Demonstrate using off-host backups and reconciliation; these targets are not currently proven or guaranteed by the repository scripts.

Collect per-route throughput/latency/errors; process CPU/RSS/event-loop delay; DB duration, query plans, locks, write latency, WAL size and checkpoint time; SSE count/replay lag; provider latency/429s/idempotency conflicts; oldest queue age and attempts; printer online state/uncertain jobs; financial invariants. Use correlation IDs without card details, secrets, messages, recordings or addresses in logs. Keep tenant identifiers out of unbounded metric labels; use controlled traces for per-tenant diagnosis.

Load-generator machines must be separate from the system under test. Record commit, schema, scenario seed, dataset cardinality, tool/runtime versions, topology, disk, database settings, cache state, autoscaling, raw time series and invariant checks. Run at least three stable repetitions and preserve failed runs. Stop on data-isolation or financial-integrity failure, unexpected live-service traffic or unsafe printing. Do not resolve failures by weakening business rules or removing safety checks.

## Improvement sequence, tied to evidence

1. Preserve baseline contracts and repair reproduced failures. Add measured menu/order-child indexes, database-side discovery filters/pagination and precomputed popularity/search data only after validating query plans on representative history. Index names/order are proposals until staging EXPLAIN and write costs are measured.
2. Consolidate dashboard active-order retrieval and coalesce event refreshes; retain manual refresh and disconnected fallback. Avoid changing the interface or silently hiding active orders. Establish server-side pagination for unbounded customer/admin histories.
3. Separate API lifecycle from durable worker scheduling with bounded concurrency, fencing, leases, dead-letter/review states and fair tenant scheduling. Increase service rate by controlled measurement, not by blindly increasing batch size or running every worker on every API replica.
4. Validate a managed transactional database such as PostgreSQL as the candidate for multiple application hosts. SQLite WAL permits one writer and requires local shared memory; it cannot become a multi-host database by mounting one shared network file. [SQLite WAL documentation](https://www.sqlite.org/wal.html). Keep SQLite until an approved migration/rehearsal; do not rewrite all business logic to evaluate the alternative.
5. Put persistence behind narrow repository methods, rehearse type/constraint/idempotency parity, backfill a staging database, compare counts/totals/FKs and representative order/finance results, then plan a maintenance/cutover/rollback window. A successful PostgreSQL port alone does not fix N+1 queries, polling or worker limits.
6. Add tenant-keyed read caching only to safe public catalog data; private finance/order caching must preserve identity and invalidation. Adopt one reliable broker/pub-sub mechanism only if staged latency/connection evidence warrants it. Keep payment/order writes transactional and use an outbox for external effects.

Infrastructure size, cost, replica count and sustainable order rate remain **unknown pending these tests**. The current measurements justify fixing specific paths; they do not justify a wholesale rewrite or an unqualified claim that SQLite alone is the only blocker.
