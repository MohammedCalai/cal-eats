# Isolated order capacity validation — 8 November 2026

The current ordering handlers completed **600/600 synthetic order workflows with zero HTTP errors**, using a directory of **10,000 restaurants and 200,000 menu items**. This is a bounded local result, not approval for 10,000 simultaneous customers or businesses in production. A background settlement queue limit was observed and remains a capacity gate.

Evidence: [unaltered measured results](./ORDER_LOAD_RESULTS_2026-11-08.json), [source state observed during the run](./ORDER_LOAD_SOURCE_STATE_2026-11-08.json), and [post-run ledger/notification checks](./ORDER_LOAD_INTEGRITY_2026-11-08.json). The earlier [October marketplace baseline](./SCALE_VALIDATION.md) and [directory-only benchmark](./RESTAURANT_DIRECTORY_CAPACITY.md) are retained separately and unchanged.

## Source and environment

Parent commit: `6b85ed508d028853ad77d336a453ea9d78622d38`. This was a working checkout, **not an exact clean checkout**: public static-page routing, support resources, their tests and Android app configuration were being prepared separately. During the run, `git diff --exit-code HEAD` verified that `journey.js`, `marketplace.js`, `order-confirmation.js`, `operations.js`, `financial-environment.js`, `restaurant-discovery.js` and `config.js` remained unchanged from that parent. Their byte hashes and the dirty tracked paths are recorded in the source-state evidence.

Executed harness SHA-256: `d1e163f6b5b61fa726c366a4d1ff4a26e80a5c7975868535390ed0d2c83a14c7`. After the run, the reusable harness received only an additional source-state journal at startup; its ordering/load behavior was unchanged. The exact executed harness and raw per-request samples remain in the ignored local artifact folder `artifacts/order-capacity-2026-11-08T15-42-03.942Z/` as `load-order-capacity.executed.js` and `measurements.json`.

Windows x64; Node 24.19.0; SQLite 3.53.3; Intel i5-1335U, 12 logical processors, 15.64 GiB RAM. Two independently forked API processes shared one isolated SQLite WAL file on this computer. Final API RSS snapshots were approximately 120 and 94 MiB; these are endpoint snapshots, not peak-memory measurements. The final isolated database was approximately 112 MiB. No normal application database was opened.

The fixture contained 10,000 approved synthetic restaurants, 20 menu items per restaurant, 50,000 historical browsing orders, 20,000 ratings and 102 synthetic accounts. Fifty restaurants had active synthetic owners and paired simulated printer clients. Historic orders supplied directory/rating history only and had no financial ledger; integrity checks scoped new orders separately. No image bytes were allocated or downloaded.

Every child received only whitelisted operating-system environment values and explicit local-simulator settings. Provider secrets, normal `.env` files, mail credentials and hosted databases were excluded. HTTP was restricted to loopback. No actual card, bank, email, push, public-service or physical-printer operation occurred.

## Workload and results

Each customer workflow fetched a bounded restaurant page and menu, automatically quoted the basket, submitted **two simultaneous identical checkout requests**, confirmed the order as its owner with an explicit future ETA, advanced preparation and completion, fetched the customer order and read the owner's financial summary. Half were delivery orders; half collection. Two-thirds used simulated cards; one-third cash. The internal `ready` transition was exercised before dispatch/completion; this is not a claim that the removed customer-facing “Packed” step is displayed.

There were no customer think times: these are closed-loop bursts. Fifty printer simulators ran alongside them using the example bridge's 3-second empty poll and 30-second heartbeat. They claimed and acknowledged receipts continuously during the observation window.

| Measurement | 20 customer clients | 50 customer clients |
| --- | ---: | ---: |
| Completed order workflows | 300 / 300 | 300 / 300 |
| Measured HTTP requests, including printer polls | 5,300 | 5,271 |
| HTTP errors | 0 | 0 |
| Order-workflow burst duration | 12.53 s | 13.11 s |
| Full workflow median / p95 / p99 | 785 / 1,230 / 1,385 ms | 2,046 / 2,894 / 3,111 ms |
| HTTP median / p95 / p99 | 54 / 198 / 293 ms | 138 / 397 / 514 ms |
| Short-burst completed workflows/minute | 1,437 | 1,373 |
| Observation window, including normal worker cadence | 69.18 s | 70.19 s |
| Confirmation request start → simulated print acknowledgement p95 | 3.14 s | 3.47 s |

The burst rate is arithmetic from these short local runs, **not a sustainable orders-per-minute promise**. The second case reused the warmed database and included the first case's orders and remaining background jobs; these are stepped-load observations, not independent statistically controlled trials.

Per-endpoint response times below are **median / p95 / p99 in milliseconds**. Each user endpoint had 300 samples per case, except dispatch (150 delivery orders). Both HTTP checkout submissions were measured; labels distinguish launch position, not necessarily which request won creation. Every endpoint had zero errors. Full counts, maxima and printer-poll metrics are in the raw results.

| Endpoint/action | 20 clients | 50 clients |
| --- | ---: | ---: |
| Browse page, maximum 50 restaurants | 62.70 / 175.47 / 240.95 | 139.28 / 394.88 / 521.81 |
| Restaurant menu | 67.23 / 157.66 / 217.17 | 145.57 / 368.15 / 441.97 |
| Automatic basket quote | 62.59 / 172.76 / 237.55 | 153.86 / 374.96 / 513.51 |
| Create order | 58.35 / 178.62 / 250.54 | 236.69 / 505.72 / 568.77 |
| Simultaneous checkout replay | 83.97 / 225.55 / 297.69 | 150.80 / 410.00 / 525.59 |
| Owner confirmation + ETA | 75.33 / 179.65 / 250.85 | 193.91 / 403.72 / 472.73 |
| Owner preparing | 73.83 / 171.62 / 262.32 | 192.04 / 397.15 / 447.83 |
| Owner ready | 70.46 / 171.23 / 278.91 | 192.68 / 425.34 / 511.03 |
| Owner out for delivery | 70.72 / 201.41 / 323.76 | 180.60 / 385.84 / 488.80 |
| Owner completion | 64.41 / 185.66 / 249.62 | 193.12 / 396.87 / 459.91 |
| Customer order detail | 51.69 / 149.59 / 204.00 | 179.98 / 395.61 / 479.18 |
| Owner finance summary | 53.81 / 147.18 / 198.23 | 193.18 / 375.51 / 519.79 |
| Printer claim | 18.36 / 220.51 / 300.33 | 18.65 / 347.98 / 490.54 |
| Printer acknowledgement | 114.54 / 287.63 / 342.67 | 230.41 / 390.27 / 506.94 |
| Printer heartbeat | 20.39 / 162.69 / 176.25 | 18.36 / 126.07 / 128.81 |

## Correctness and queue finding

All 1,200 checkout submissions produced exactly 600 new orders. All orders reached completion with the expected transition counts and saved ETA. There were zero missing settlement records, incorrect financial-environment snapshots, incorrect commission snapshots, duplicate operation/job keys, unbalanced journal groups or foreign-key violations. Every confirmed order produced exactly one original receipt job; all 600 were acknowledged once, with no claim retry.

Commission was checked per order at 7% of food **including delivery**, rounded to whole pence: £10 collection → £0.70; £12.50 delivered → £0.88. Across 400 simulated-card orders, recorded commission was £316.00; across 200 cash orders it was £158.00. The corresponding ledger rows matched those totals. Discounts, vouchers and commission-free periods were not part of this load fixture and need their separate functional tests.

The normal marketplace worker interval was preserved at **60 seconds**, with its default **25-job limit per process**. No manual fast drain was run. After the first 300-order burst, 50 of 200 eligible simulated settlement jobs had been processed, leaving 150 due. After both bursts, **100 of 400** had been processed, leaving **300 due**. There were no failed/retried worker jobs, but the due queue **had not drained** within the observation windows. The main `passed` field means workflow and integrity checks passed; `queueDrainedWithinObservation` is explicitly false.

This two-process test supplied at most 50 simulation jobs per minute at the configured cadence. The current single-process deployment's corresponding default simulation budget is only 25 per minute, before competing job types. This is a real capacity gate: faster HTTP checkout does not establish timely settlement processing. Actual Stripe transfer processing was disabled and **these figures do not certify live payout performance**; that worker also has bounded budgets and provider calls that need separate approved measurements.

Durable in-app notification creation produced 600 new-order, 2,700 status and 600 rating notifications. The 2,700 transactional email records remained pending in local mode because email transport was deliberately excluded. This validates record creation, not phone pop-ups, sound, email arrival or delivery latency.

Before a larger rollout, agree a maximum acceptable queue age, monitor backlog/oldest-due age, and size or separate the claimed workers with bounded recovery tests. Any worker scheduling/financial changes require review and their own verification; this exercise changed no production financial or database-schema code.

## Reproduction and remaining limits

From the repository root, run `node scripts/load-order-capacity.js`. It creates a new ignored synthetic database and results directory; it never reuses the normal DB. `--smoke` limits the scenario to ten orders/two clients and accelerates workers to 500 ms; it must not be used for production-cadence queue conclusions. Both require a supported Node build with `node:sqlite`.

The application clock is fixed to avoid expiry/weekly rollover, while latency uses monotonic wall time. Future weekly payout simulations stay scheduled. Only the local-safe operations/marketplace workers were run; other provider, retention and notification maintenance in `main.js` was excluded. Sessions were synthetic, with invalid password hashes and elevated isolated auth limits; login hashing and abuse resistance were not measured.

This does not validate mobile/rural network latency, native UI smoothness, 10,000 concurrent businesses, all 10,000 restaurants receiving orders, a long steady-state soak, live provider limits, outages/recovery, horizontal scaling, exports across years of financial history, physical printing or backup restoration. At 100 MB per restaurant the image allowance totals **1 TB before backups/overhead**; this test contains zero image bytes. Object-storage, representative media traffic, regional load and disaster-recovery validation remain separate gates.
