# Android bundle and native-client API validation — 8 November 2026

**Android-target Hermes compilation and 200 native-client order workflows passed. No Android phone/emulator ran during these checks.** Screen overlap, frame rate, startup, memory and delivered phone notifications still require the [device acceptance/performance session](./ANDROID_DEVICE_VALIDATION_PLAN.md). These results do not establish that Android UI or push delivery works on a physical device.

Evidence: [Hermes export results](./ANDROID_HERMES_EXPORT_RESULTS_2026-11-08.json), [native-client load results](./NATIVE_CLIENT_LOAD_RESULTS_2026-11-08.json), and [load source state at startup](./NATIVE_CLIENT_LOAD_SOURCE_STATE_2026-11-08.json). The earlier [600-order browser-cookie load](./ORDER_CAPACITY_VALIDATION_2026-11-08.md) remains unchanged and separate.

## Source provenance and compilation

Both runs began with parent commit `a6305010203ef8fe7c6dfbb33c31528337e1e71f` plus the frozen Android layout/back-navigation/notification changes in the working tree. Those changes and the extended harness were then committed as **`2e4e5e662ab8c8b6c36165c0d62ee9ab3259e2d1`**. The recorded mobile source hashes all match that commit's working files. No API source changed between the parent and this commit. The report's parent commit is therefore a provenance reference, not a false claim of a clean checkout at run start.

Executed native-load harness SHA-256: `5031baf21e2b687afbe171fab80aca48235dfa9776404f726505e76b8b1e6878`. Actual mobile `src/api.ts` SHA-256: `a1c8748354119dfe0fac109f362729ef59d82906be4354ca76d79206c91e3463`. Raw HTTP samples, the exact executed harness and the isolated database remain in ignored `artifacts/order-capacity-2026-11-08T15-59-50.938Z/`.

The installed Expo CLI performed an **Android-only production export with Hermes**, using two bundler workers, dotenv/telemetry disabled, offline mode and a whitelisted environment. No SDK/native build, credentials command, provider request or installation occurred. The public API URL was bundled as configuration, not called by the export.

- Compiler/export completed successfully in **20.83 seconds** on Windows/Node 24.19.0.
- Android Hermes bytecode version **98**; bundle **2,087,795 bytes**; SHA-256 `fbe31e86903576849b59b96bea1c7a15d3a8c4550e2a40082a9b78af49d88b3e`.
- **39 exported files**, **5,503,782 bytes** total, with asset map and metadata present.
- Source bytes remained unchanged during compilation. The compiled bundle contains the quiet-notification channel ID/name, unsaved-back confirmation, hardware-back and native safe-area-provider string markers. Presence confirms packaging, not visual or notification behavior.

Full export output/log/hash evidence is retained privately under `artifacts/android-validation-2026-11-08T16-00-09.421Z/`. The compile duration is a host build-tool measurement, not Android startup or app throughput. The Windows compiler is not an Android Hermes runtime. Separately, the final shared mobile logic suite recorded **57/57 passing tests**, including the new Android back-navigation and notification-presentation checks; these are Node logic tests, not rendered device tests.

## Native customer transport load

The new opt-in mode is `node scripts/load-order-capacity.js --native-customers`; the browser default is preserved. It created a fresh synthetic loopback database containing **10,000 restaurants, 200,000 menu items, 50,000 historical browse orders and 20,000 ratings**, with 50 active synthetic owners/printer simulators. Historical browse fixtures were excluded from new-order financial integrity counts. Image bytes were not allocated/downloaded.

Fifty verified synthetic customers obtained **real native-session tokens through the actual login HTTP endpoint** and had their identities verified through `/api/native/auth/me`. An ephemeral random fixture password was used only during setup, never printed or written to the report. There were **50 native customer sessions and zero customer browser sessions**.

Customer requests invoked the **actual `apps/mobile/src/api.ts` function** in Node, once per loopback API origin. The client supplied JSON request headers and retained its 15-second timeout. Transport instrumentation checked bearer authorisation, absence of a Cookie header, JSON Accept, mutation Origin, `credentials: 'omit'` and `redirect: 'error'`. The mobile client made **1,300 calls**: 100 unmeasured login/identity setup calls plus 1,200 measured customer calls. These are genuine mobile-client/server protocol checks; they do not run Android's networking stack, renderer or operating system.

Each workflow browsed a maximum-50 restaurant page, read a menu, quoted automatically, submitted two simultaneous identical checkouts, received owner confirmation with an ETA, progressed delivery/collection to completion, fetched the customer's order and read owner financial totals. Owners continued using browser sessions; paired printer simulators retained their device tokens. No real payments, banks, mail or push transport were used.

| Observation | 20 workflow clients | 50 workflow clients |
| --- | ---: | ---: |
| Completed orders | 100 / 100 | 100 / 100 |
| Measured HTTP requests, including printer polling | 2,600 | 2,600 |
| HTTP errors | 0 | 0 |
| Workflow burst duration | 4.29 s | 4.15 s |
| Workflow median / p95 / p99 | 791 / 1,275 / 1,342 ms | 1,851 / 2,216 / 2,254 ms |
| Whole HTTP median / p95 / p99 | 28 / 191 / 249 ms | 57 / 353 / 400 ms |
| Observation window including normal worker timing | 67.80 s | 67.94 s |

Per-endpoint **median / p95 / p99, in milliseconds**, with zero errors throughout:

| Action | 20 clients | 50 clients |
| --- | ---: | ---: |
| Browse maximum-50 page | 48.54 / 158.77 / 203.26 | 91.95 / 149.12 / 214.60 |
| Restaurant menu | 80.93 / 181.51 / 248.53 | 93.50 / 169.85 / 221.42 |
| Automatic quote | 44.45 / 205.28 / 242.01 | 129.55 / 318.69 / 470.88 |
| Create order | 71.93 / 180.39 / 240.05 | 163.60 / 330.29 / 346.89 |
| Simultaneous replay | 62.92 / 157.91 / 206.10 | 141.61 / 358.20 / 373.62 |
| Owner confirmation + ETA | 78.32 / 169.51 / 234.72 | 172.73 / 385.38 / 402.54 |
| Owner preparing | 66.64 / 166.23 / 187.47 | 204.77 / 386.14 / 399.10 |
| Owner ready | 60.64 / 156.82 / 211.61 | 225.59 / 396.68 / 410.84 |
| Owner dispatch | 70.97 / 191.96 / 252.49 | 194.48 / 393.65 / 396.49 |
| Owner completion | 64.94 / 192.12 / 233.80 | 178.27 / 378.80 / 402.63 |
| Customer order detail | 58.15 / 166.06 / 256.05 | 140.93 / 331.52 / 387.31 |
| Owner financial summary | 55.00 / 190.93 / 277.25 | 118.85 / 395.61 / 412.92 |

The 400 checkout submissions produced exactly **200 new orders**, with 200 complete status histories and 200 original receipt jobs acknowledged exactly once. Commission snapshots, saved financial environment, settlement records, journal balance, unique operation keys, foreign keys and native-session invariants all passed. Commission remained 7% of food including delivery, rounded per order; discounts/vouchers/free-commission periods were outside this fixture.

## Queue gate and limits

Normal **60-second workers with 25 jobs per process** were retained, alongside 3-second idle printer polling and 30-second heartbeats. No artificial financial queue drain occurred. After the first case, 50 of 66 eligible simulated transfer jobs had been processed, leaving 16 due. At the end, **100 of 132** had been processed, leaving **32 due**, with zero failed/retried jobs. Thus workflow correctness passed while `queueDrainedWithinObservation` remained false. The corresponding default single-process simulation budget is only 25 jobs/minute before competing job types; actual Stripe payout capacity was not measured.

These short closed-loop bursts had no customer think times and reused the warmed database for the second step. The local Android export overlapped part of the first case, and release preparation ran on the same host, so this is not a controlled before/after performance comparison. Do not infer a sustainable production rate or Android runtime improvement from these numbers.

The fixture remained local, used no real identities/providers and raised isolated authentication limits. Password verification ran during sequential setup, not as a password/login capacity benchmark. The application clock was fixed while latency used monotonic wall time. No phone/emulator, native layout/FPS/memory/ANR test, actual notification delivery, real money movement, remote network latency, 10,000 simultaneous businesses or image-library throughput was exercised. The physical-device session and the outstanding queue-capacity work remain necessary.
