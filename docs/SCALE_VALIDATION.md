# Local marketplace concurrency baseline

25 October 2026. Raw measured results: [LOAD_RESULTS_2026-10-25.json](./LOAD_RESULTS_2026-10-25.json). Reproduce with `npm run load:local`. The harness creates an isolated synthetic database under ignored `artifacts/`; it does not use the demonstration database or original Calai.

## Environment and workload

Windows x64, Node 24.19.0, Intel i5-1335U (12 logical processors), 16 GiB RAM. Two separate API processes and two worker loops shared one local SQLite WAL database. This supports a measured **single-host, multi-process** development configuration. It does not establish multi-node support; never share SQLite over a network filesystem.

Dataset: 10,001 accounts (9,900 customers, 100 restaurant owners, one admin), 100 restaurants, 2,000 menu items, 20 paired simulated devices. There were no historical orders before the run. Downloads, registered accounts and concurrent activity are different measures: only 20 customer workflows were concurrent, with 20 device clients during queue draining.

The mixed scenario browsed restaurants and menus, concurrently repeated every checkout using the same idempotency key, advanced 120 orders through collection/delivery workflows, read financial summaries, sent printer heartbeats and claimed/acknowledged jobs. One third of orders used cash; the rest used simulated card payments. Workers polled every 500 ms in the harness; the normal application timer is 60 seconds. Password verification, physical printing, remote networking and real payment services were excluded.

## Observed result

- 120 of 120 order workflows completed; 1,521 HTTP requests; **zero HTTP errors**.
- Duration 13.832 seconds; observed short-burst order rate approximately 520/minute. This is not a sustainable production capacity promise.
- Exactly 120 orders despite 240 checkout submissions; zero duplicate operation keys, unbalanced journal groups or foreign-key errors.
- All 120 printer jobs were acknowledged by the synthetic client. No physical paper output occurred.

| Request | Median | 95th percentile |
| --- | ---: | ---: |
| Restaurant browsing | 179 ms | 350 ms |
| Menu | 132 ms | 342 ms |
| Checkout | 176 ms | 343 ms |
| Duplicate checkout replay | 215 ms | 419 ms |
| Order acceptance | 157 ms | 405 ms |
| Finance summary | 110 ms | 361 ms |
| Printer claim | 137 ms | 295 ms |
| Printer acknowledgement | 154 ms | 285 ms |

Print completion delay was 7.05 seconds median and 10.77 seconds at the 95th percentile, including deliberate harness queueing: devices drained jobs after the order burst. This does not measure real printer latency or normal continuous-poll latency.

The raw `financialExceptions: 40` counter included forty ordinary `cash_sale_recorded / held` rows. Inspection found these represented cash held directly by restaurants, not failed money movement. The actionable admin exception view excludes this ordinary cash state after review. The raw result is retained unchanged for transparency.

An earlier genuine concurrent run exposed duplicate-checkout 500 responses across processes. The fix moved the idempotency recheck and all database-backed checkout validation into one write transaction. The passing run above followed that fix. Earlier setup-only runs also exposed missing fixture flags/agreement acceptance and are not load measurements.

## Limits and deployment sizing assumptions

This short exercise did not find a saturation limit and does not establish 10,000 simultaneous users, long-duration stability, large order-history/report performance, mobile network behaviour, password-login throughput, provider throughput or production disaster recovery. The synthetic authentication limit was raised only in the isolated benchmark processes.

For an initial independently hosted preview, use one persistent local-disk instance, one or two API processes, explicit worker ownership, HTTPS, separate secrets and encrypted backups. A 2–4 vCPU / 4–8 GiB candidate is a **starting point for a new representative load test**, not a measured sizing recommendation. Keep sensitive evidence in private storage with retention, and monitor latency/errors, lease age, backlog and money exceptions. No infrastructure was purchased or deployed.

Multi-node rollout requires a shared transactional database such as PostgreSQL, a reviewed migration of the synchronous repository layer, pooled connections, distributed worker coordination and shared private object storage. Add durable provider/event processing, realistic historical datasets, login bursts, continuous device traffic and a sustained test before claiming horizontal production scale. PGlite or two SQLite processes would not prove that architecture.
