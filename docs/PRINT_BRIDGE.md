# Cal-Eats print bridge

The Cal-Eats bridge is an independent Node.js device client under `apps/print-bridge`. Its default and verified transport is a **local file-sink simulator**. Nothing in this package has been installed on Windows or connected to a printer. Raw TCP ESC/POS exists only as an explicit, separately gated transport and remains physically unverified.

## Provenance and isolation

The FIFO job idea, 40-column receipt formatting approach and ESC/POS byte framing were adapted from the read-only Calai source snapshot at commit `ab138fd17c9ac4fc6e0b34ef5044754be643056c`, principally `backend/print-bridge.js`, `backend/src/app/modules/businessowner/printer/printer.service.js`, `backend/src/app/utils/receipt.js` and the `Printer`/`PrintJob` schema. This implementation is newly written for Cal-Eats.

No original route, hostname, token, MAC, IP, installer identity, process rule or device configuration was copied. The recovered `backend/intune/config.json` was inspected structurally only: its printer token is a placeholder, MAC is empty, and there are no apparently real device credentials. Configured-looking API/local-IP defaults were not copied.

The bridge rejects the original Calai host family. The simulator also rejects non-loopback APIs. Its process, files, logs and optional Windows task use Cal-Eats-only identities.

## Automatic printing after business confirmation

The owner's confirmed trigger is successful business confirmation (`placed` to `accepted`), through either the tablet/browser business platform or the native Cal-Eats Admin app. The order transaction creates one original receipt job per enabled, non-revoked restaurant printer after its payment decision succeeds. Checkout, rejected/failed confirmation, later preparation/delivery updates, receipt views and repeated confirmation requests do not enqueue another original. Original jobs have a unique order/printer operation key. Offline devices leave receipts queued for their bridge to claim.

The business Printers page now shows auto-print state, pairing, recent bridge contact, queue counts and device-reported outcomes. Connection means an authenticated heartbeat within 60 seconds, not paper readiness. An unpaired or offline printer is visible rather than silently appearing ready. Explicit manual reprints require an enabled printer and a confirmed-or-later order and are labelled separately.

On 28 October 2026, two focused regressions passed for browser/native confirmations, failed capture, duplicate confirmation, later states, disabled/revoked/other-restaurant exclusion, manual-reprint restrictions, heartbeat expiry, queue outcomes and secret-free owner summaries. No physical printer was contacted.

## Existing Intune reference

The requested chat, **Explain computer access**, records the original **Calai Tablets - Print Bridge Source File** policy, with per-tablet IP/MAC configuration. Its managed script copies the supplied original `print-bridge.js` into `C:\ProgramData\CalaiPrintBridge`, verifies its hash and clears the old shared configuration; it does not itself start or prove a working printer. A live read-only Intune inspection on 28 October confirmed the policy is assigned to two groups and reports two successful device executions, zero errors. These are script-execution results, not proof of paper output or of a Cal-Eats connection.

Original Calai's program, kiosk rules, assignments, printer IP/MAC values and startup task were not changed. The current GitHub connection/browser cannot access `calai-operation/calai-platform` (404), so the code comparison uses the pinned source snapshot above plus the actual previously deployed source-file script. Before a Cal-Eats hardware rollout, verify the specific tablet's allowed runner, per-device configuration and printer transport. Do not overwrite the working original Calai setup or reuse its token against Cal-Eats.

## Frozen API

The bridge implements `docs/MARKETPLACE_API.md`:

- `POST /api/devices/pair` with `{code,name}`; the opaque token is stored once and never printed.
- Bearer-authenticated `POST /api/devices/heartbeat` and `POST /api/devices/jobs/claim`, both with `{}`.
- `POST /api/devices/jobs/:id/ack` with `{claimToken,outcome,detail?}`.

Claimed receipts use the frozen `cal-eats-receipt-v1` structure. Currency must be `GBP`; every amount must be safe integer pence. Control characters are stripped from receipt fields. The bridge rejects malformed jobs rather than sending untrusted bytes to a transport.

The API must return the same unexpired claim to the same device after a lost claim response. Acknowledgements must be replay-safe for the same claim token/outcome and reject a conflicting replay.

## Local simulator setup

Requirements: Node.js 22 or newer. No package installation is required.

1. Copy `apps/print-bridge/config.example.json` to a writable local configuration path.
2. Keep `transport.kind` as `file-sink` and the API origin on loopback.
3. In the owner portal, create an enabled printer and request a short-lived pairing code.
4. Set `CAL_EATS_PAIRING_CODE` only for the pairing process, then run:

   ```powershell
   $env:CAL_EATS_PAIRING_CODE = "the-short-lived-code"
   node apps/print-bridge/src/index.js pair --config apps/print-bridge/config.json
   Remove-Item Env:CAL_EATS_PAIRING_CODE
   ```

5. Validate or process one local job:

   ```powershell
   node apps/print-bridge/src/index.js validate --config apps/print-bridge/config.json
   node apps/print-bridge/src/index.js once --config apps/print-bridge/config.json
   ```

6. For continuous local polling, use the `start` command. Do not point it at an original Calai host.

Each simulated attempt produces deterministic `.txt`, `.escpos` and `.json` artifacts. The JSON marks the result as simulated and records only job/attempt metadata and a receipt hash. The journal persists the receipt and claim token because they are required for crash recovery; its directory therefore requires restricted access and a retention policy.

## Reliability semantics

The bridge writes a claim to its journal before dispatch. A restart in `claimed` safely resumes dispatch. A restart in `dispatching` checks the deterministic file sink: a complete matching artifact is acknowledged once; no artifact is safe to retry.

Physical transport is different. Once physical dispatch begins, a restart or ambiguous network error becomes `uncertain`; the bridge does not automatically send duplicate paper. The owner must create an explicitly labelled manual reprint. Even a clean raw TCP write is acknowledged as `uncertain`, because socket acceptance does not prove paper, cutter or legibility.

Acknowledgements remain `ack_pending` until the API confirms them. If the response is lost, the exact same claim token/outcome is replayed. Non-retryable server rejection is retained as `ack_rejected` for investigation. Network retries and the outer service loop use bounded exponential backoff; HTTP requests have hard timeouts.

## Physical transport safety gate

TCP ESC/POS requires all of the following:

- `transport.kind` is `tcp-escpos`;
- `transport.enabled` is `true` with an explicit host/port; and
- the process receives `--allow-physical-transport`.

Do not use that flag until a specific development printer and tablet are separately authorised. There is no USB/default-printer fallback, LAN discovery, runtime download or automatic physical test.

## Windows deliverables — not executed

`apps/print-bridge/windows` contains install, status and uninstall scripts. They use only:

- scheduled task `CalEatsPrintBridge`;
- `C:\ProgramData\CalEats\PrintBridge`;
- an already installed, explicitly located Node runtime; and
- restricted SYSTEM/Administrators ACLs.

The installer does not download software, start the task, pair a device, inspect the LAN, or stop generic Node/print processes. The uninstaller removes only the exact Cal-Eats task and directory. These scripts have not been run and must not be used on a live Calai tablet during development.

## Focused verification

Run only the bridge tests with:

```powershell
node --test apps/print-bridge/test/*.test.js
```

They cover loopback Bearer requests, integer-pence/control-character receipt handling, offline claim behaviour, restart before dispatch, idempotent file-sink output, lost acknowledgement replay and restart after possible physical output becoming `uncertain`. These are simulator/protocol checks, not evidence of physical printing.

### End-to-end file-sink evidence

On 25 October 2026, one isolated end-to-end run used a new temporary SQLite database and a loopback-only API process. A seeded fictional restaurant created an enabled printer and short-lived pairing code; the real bridge CLI paired, a customer placed a mock-card collection order, the restaurant accepted it, and the bridge claimed the generated print job.

The file sink committed exactly three attempt-1 artifacts (`.txt`, `.escpos`, and `.json`). The API then recorded the job as `printed` with `attempt: 1`, while the bridge journal recorded `acked`. The temporary database, credential, journal, logs, and output directory were removed after verification. The normal demo database was not opened by this run.

This proves the local API/bridge/file-sink protocol and acknowledgement path only. The `.escpos` file contains bytes for inspection; it was not sent to hardware. It does not demonstrate a Windows scheduled-task installation, tablet operation, printer networking, paper output, cutter behaviour, character rendering, or recovery after a real device loses power. TCP ESC/POS remains gated and physically unverified.
