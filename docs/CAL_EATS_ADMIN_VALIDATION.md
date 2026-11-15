# Cal Eats Admin validation — 15 November 2026

All order/payment/device fixtures below use isolated synthetic local data. No
real payment, transfer, physical printer write, cloud push or Windows enrolment
was performed. Counts describe test cases, not restaurants or devices tested.

| Check | Result |
| --- | --- |
| Complete core regression: API, customer web, portal, printing components and operator scripts | **681 passed, 0 failed, 0 skipped**, with two concurrent test files; 316 seconds. Log: `artifacts/cal-eats-admin-20261115/full-core-verified.log` |
| Customer native regression | **69 passed**; customer native source and application identity have no diff |
| Cal Eats Admin native regression | **15 passed**, including view-only route policy, payout provenance, campaign edit constraints and UK date/search filters |
| Customer/Admin TypeScript checks | Both passed |
| Admin store configuration preflight | **8 passed**; these are configuration checks, not store approval |
| Portal production build | Passed; existing large-bundle warning remains |
| Release packaging and source syntax checks | Passed; dependency maps are compared without treating JSON property order as a dependency change |
| Independent two-browser security integration | **8 passed** using the real API, real loopback companion and portal client with synthetic signing keys |
| Printer queue integration | **5 passed**, including signed companion/API requests, pre-submission retry, audited uncertain-result recovery and populated migration |
| Device health and operator warning access | **8 passed**, covering cached/aged observation rejection, distinct screen/service/printer faults, sample receipt failure, initial grace, recovery and narrow signed operator diagnostic access |
| Business push | **5 passed**: encrypted/session-bound registration, quiet/deduplicated delivery, uncertain/failing delivery, revoked access and old-generation invalidation |
| Search/date API and existing London DST handling | **3 passed**: real native bearer, pagination/count, tenant boundaries, literal wildcard/injection input, date filters and contact minimisation |
| Hosting/static routing | Actual listening HTTP GET/HEAD checks passed. Business CSP permits only the fixed local companion; customer CSP remains unchanged |
| Windows helper validation | PowerShell syntax and C# declaration compilation passed without invoking CNG/printer APIs or creating a key |
| Native compilation | Android packages built for ARM64 and x86-64; iOS Hermes export passed. Final package/source evidence is retained under the task artifacts directory |
| Local API smoke | Native login, order list/search, dashboard, truthful unknown printer health and logout returned HTTP 200 against the disposable QA server |
| Ordinary-browser UAT | Earlier dashboard, Devices, confirmed-order details and Printers checks confirmed a separate browser stayed view-only even while the fixture's tablet was online. No operational controls appeared; owner printer configuration remained available |

The complete core run includes existing payment/commission, customer lifecycle,
legal/privacy, support, notifications, catalogue, loyalty, report-email and backup
regressions. The 7% after restaurant discounts including charged delivery,
rounding, saved order snapshots and provider-reported payout distinctions remain
covered. Delayed provider capture, duplicate acceptance and mid-capture terminal
revocation/re-enrolment recovery retain no-duplicate capture/event/receipt checks.

Legacy successful merchant-operation fixtures were explicitly enrolled and signed.
Ordinary cookie/native denial cases remain unsigned; no production bypass or
global auto-signing test helper was introduced. The reset/quarantine concurrency
test accepts either safe rejection point, while still proving only the new strong
password authenticates. Its former exact error-code timing assumption was flaky
under concurrent password hashing.

The independent browser-session tests reproduce delayed signing, late auth
failure, stale disconnect and old handoff races. They also cover absent proof,
no-cookie/customer access, current permission/logout/device revocation and a lost
or malformed successful handoff response. An old browser cannot borrow another
operator's grant or automatically reclaim it after a user switch. An ambiguous
response requires explicit reconnection.

Fresh migration and populated schema 63-to-65 migration preserve user password
hashes, order/payment records, printer credentials, historical receipt payloads
and states. The synthetic 400p order / 28p commission / 372p allocation remains
unchanged. Foreign-key/integrity checks and repeat migration passed.

Development failures were corrected before the passing run: old direct companion
test callers needed their own browser proof, two legitimate older payment/hosting
fixtures needed current behaviour, and the Android build needed a shallow source
snapshot to avoid Windows/Ninja path-length limits. These were isolated local
checks, not hosted incidents.

The final attempted browser-to-companion smoke was stopped before refresh by
computer-control policy because it could not confidently identify the current
browser URL. It did not prove actual browser CSP/local-network permission or
mixed-content behaviour. The unpaired bootstrap-only test listener was stopped
and port 17863 verified free. No GUI retry or physical pairing was attempted.

Physical acceptance criteria remain separate: SYSTEM CNG key/ACL and local-browser
pairing on the actual Windows tablet; hardware/driver unplug, paper/cover and
receipt uncertainty/reconnect checks; real signed-phone installation and
background/locked-screen push after the business APNs/FCM setup. Simulations do
not establish these outcomes. No live backend cutover or public publishing has
been performed.
