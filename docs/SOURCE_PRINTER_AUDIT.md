# Cal-Eats source printer audit

## Scope and evidence

This is a read-only inspection of the filtered Calai source snapshot at `reference/calai-platform-ab138fd`, recorded by `docs/SOURCE_PROVENANCE.json` as source commit `ab138fd17c9ac4fc6e0b34ef5044754be643056c` from `https://github.com/calai-operation/calai-platform`. The snapshot is not a Git clone, so its source identity comes from that provenance record. No source code was executed, no source or reference files were changed, no Calai endpoint or printer was contacted, and no device configuration was touched.

Principal evidence:

- `backend/print-bridge.js` and `backend/intune/print-bridge.js`
- `backend/intune/{install.ps1,uninstall.ps1,config.json,INTUNE_DEPLOYMENT_GUIDE.md}`
- `backend/src/app/modules/businessowner/printer/{printer.service.js,printer.controller.js,printer.route.js,device-printer.route.js}`
- `backend/src/app/router/index.js`
- `backend/src/app/utils/receipt.js`
- `backend/prisma/schema.prisma` and the printer migrations
- `frontend/src/hooks/usePrinterManagement.jsx` and `frontend/src/pages/owner/PrinterManagement.jsx`
- Current Cal-Eats browser-only printing in `apps/api/src/{operations.js,journey.js,db/migrations.js}` and `apps/web/app.js`

Physical printing is **unverified**. Source inspection cannot establish printer compatibility, paper output, cutting, Windows driver behaviour, or exactly-once physical printing.

## Observed Calai flow

1. A business owner registers a printer using a display name, MAC/serial value and local IP address. The serial is unique only within that business.
2. The portal downloads a ZIP from `GET /api/business-owner/printer/download-bridge`. That route has no authentication middleware. The current frontend supplies MAC and IP but no token, so the generated bridge normally falls back to MAC-based identification.
3. Every five seconds the bridge sends an unauthenticated `POST /api/printer/poll` containing a MAC and/or a configured `token`. The server treats a printer UUID **or a business UUID** as a token; otherwise it performs a global MAC/serial lookup.
4. The server marks the printer online, finds its oldest `pending` job, then updates it to `printing`. Selection and update are separate operations, not an atomic claim.
5. The bridge retrieves receipt text through unauthenticated `GET /api/printer/poll?token=<print-job UUID>`, sends it either to the Windows default printer or to a raw TCP socket, then calls unauthenticated `DELETE /api/printer/poll?token=<print-job UUID>&code=200`.
6. A successful delete marks the job `completed`; other codes mark it `failed`. Failed jobs are never selected again. Jobs left in `printing` are also never selected again.

Automatic order printing is coupled to the phone/webhook order path through `webhook/helpers/order-sync.js`. The receipt generator also falls back to `order.call.customerNumber` and contains call-specific “unconfirmed order” language. Manual queueing is owner-authenticated and verifies the printer and order belong to the owner's business, but automatic queueing accepts a business ID and order ID without checking that the order belongs to that business.

## Reuse, adapt, replace

| Element | Decision | Reason / Cal-Eats adaptation |
| --- | --- | --- |
| 40-column receipt formatting helpers | Adapt | Wrapping, columns and Europe/London date formatting are useful. Replace branding/support details and remove call dependencies. Add marketplace order number, fulfilment, modifiers, allergy/order notes, food/delivery totals, payment method/status and an explicit reprint marker. |
| Server-created immutable receipt payload | Reuse concept | Generating the receipt at queue time protects it from later menu changes. Use a versioned payload/snapshot and integrity hash rather than an unversioned nullable text column. |
| Per-printer FIFO queue | Adapt | Preserve ordering, but use an atomic lease/attempt protocol with expiry, backoff and bounded retries. |
| Network ESC/POS transport | Adapt behind an interface | Raw port 9100 may suit some printers, but the current socket write callback proves only OS acceptance of bytes. Make model/code-page/cut behaviour configurable and separately verified. |
| Windows USB default-printer path | Replace | `Get-Content | Out-Printer` is a Windows text/driver handoff, not demonstrated raw ESC/POS, and it can target the wrong default printer. Select an explicit installed queue or supported USB transport and validate it on the target model. |
| MAC/serial or business-ID “token” pairing | Replace | MAC values and database IDs are identifiers, not secrets. Use short-lived, single-use pairing plus a random revocable device credential bound to product, restaurant and device. |
| Open poll/content/ack endpoints | Replace | Every device operation must authenticate; the server must verify that the credential owns the device, printer, attempt and job. A job UUID alone must never authorize receipt access or acknowledgement. |
| `Printer` / `PrintJob` schema | Replace with migrations informed by it | The model lacks device credentials, product identity, leases, attempts, acknowledgements, failure class, retry schedule, reprint lineage and uncertainty. Cascading printer deletion also destroys job history. |
| Poll-derived online/offline UI | Adapt | Retain last-seen presentation, but store a distinct authenticated heartbeat and capabilities. “Online” must mean recent bridge contact only, never paper/printer/print success. |
| Portal printer CRUD/status layout | Adapt | Familiar management UI is reusable after it is backed by explicit restaurant memberships and device pairing/rotation/revocation. Do not expose credentials in query strings or ZIPs. |
| Auto-queue from phone webhook | Remove | Cal-Eats checkout/order events must independently enqueue printing at the documented marketplace state, with no call, transcript or telephony object. |
| Calai bridge ZIP/installer/uninstaller | Replace | It embeds Calai defaults and identities and can overwrite or stop the existing Calai bridge. Build a separately named, separately configured Cal-Eats package only after the protocol is fixed. |

The current Cal-Eats `print_jobs` table records browser receipt handoff only (`requested`, `browser_opened`, `failed`). Preserve that honest behaviour until the device service exists. Do not reinterpret `browser_opened` as physical success. A device-print subsystem should either use separate tables or an explicit `channel` plus a migration; it must not silently change existing records.

## Confirmed reliability and isolation gaps

### Pairing and authentication

- Device routes have no authentication middleware. Anyone who obtains a print-job UUID can read its receipt or change its status.
- The alleged token accepts a printer ID or business ID and is sent in request bodies/query strings. There is no secret issuance, hashing, expiry, rotation, revocation, replay protection or pairing approval.
- MAC/serial lookup is global while the database permits the same serial in different businesses. `findFirst` can therefore bind a poll to an arbitrary tenant's printer.
- The public bridge-download route accepts configuration query parameters. The portal happens to use an authenticated HTTP client, but the server route itself is open.
- The configured credential and endpoints are plaintext JSON. No Windows credential-store use or file-access hardening is shown.

### Retrieval, acknowledgement and retries

- Pending-job selection and the transition to `printing` are not atomic. Concurrent polls can receive the same job.
- There is no lease owner, lease expiry, attempt identifier, next-attempt time or dead-letter state. A crash after claim leaves the job permanently `printing`.
- A network failure before acknowledgement also leaves `printing` permanently. A failed acknowledgement after physical output has the same database state but a very different operational meaning.
- USB errors are logged but execution continues to a success acknowledgement. The backend can therefore record `completed` after the bridge explicitly observed a USB failure.
- The bridge's HTTP helper resolves all HTTP status codes. A failed content fetch can be serialized and printed as an error body, and a failed acknowledgement can be logged as completed because only network exceptions are treated as failure.
- Backend failure acknowledgement increments `retryCount` but marks the job `failed`; polling selects only `pending`, so the counter drives no retry.
- No idempotency key prevents repeated auto/manual queue calls. The authenticated order “download” GET also queues jobs, so repeat reads can cause duplicate output.
- Manual reprints have no reason, actor, parent job, copy number or prominent receipt label.

### Status and physical uncertainty

- Polling doubles as heartbeat. Even printer-reported 4xx/5xx status values leave the database status `online`.
- Offline state is mainly inferred at read time after 60 seconds; there is no durable device-health state machine.
- “Network print succeeded” means Node completed socket writes, not that the printer accepted the page, had paper, cut it, or produced legible output. USB process completion is similarly not physical proof.
- A disconnect after bytes reach the printer but before acknowledgement is inherently ambiguous. Retrying may duplicate a receipt; suppressing a retry may lose one. Cal-Eats must surface `uncertain` and require a labelled, audited reprint decision rather than promise exactly once.
- CP437, 40 columns and one cut command are assumed. Unicode menu names, the pound sign, column width, cutter support and printer-specific code pages remain unverified.

### Windows startup, recovery and coexistence

- The installer uses `C:\ProgramData\CalaiPrintBridge` and scheduled task `CalaiPrintBridge`. It stops that task and broadly terminates processes whose command line contains `print-bridge.js`; the uninstaller does the same. An adapted package could stop or delete the live Calai bridge.
- Installation overwrites configuration and source in place. There is no product/version migration, rollback, signed package verification, runtime checksum, atomic update or configuration preservation policy.
- The scheduled task retries at most five times. File existence is the Intune detection rule, so a broken or stopped installation can still appear installed.
- Logs append indefinitely without rotation or retention controls. Job UUIDs are logged, and receipts contain personal/order data even though the current bridge does not log receipt bodies.
- The manual launcher downloads a runtime at execution time and has no service recovery. The two committed bridge copies already drift: their only observed code difference is the default Calai API host.

## Required independent Cal-Eats boundaries

Use a new product-specific service and protocol; do not edit, install over, stop or uninstall Calai components.

- **Backend namespace:** a Cal-Eats-only device API such as `/api/device-print/v1`; no compatibility fallback to Calai routes, IDs or credentials.
- **Data:** `print_devices`, `printer_endpoints`, `print_jobs`, `print_attempts` and audit/reprint linkage scoped by `restaurant_id`; database constraints or transactional checks must ensure the order, job, device and printer all share the same restaurant.
- **Provisioning:** an authenticated owner/admin creates a short-lived one-time pairing code. Redemption issues a high-entropy secret bound to `product=cal-eats`, restaurant and device. Store only a verifier server-side and protect the client credential with Windows DPAPI/Credential Manager. Support rotation and immediate revocation.
- **Protocol:** authenticated heartbeat; atomic job lease; authenticated payload retrieval; attempt-scoped acknowledgement with a stable idempotency key. Expired leases can retry only under policy. Persist attempts and distinguish `queued`, `leased`, `dispatching`, `transport_accepted`, `failed`, `uncertain`, `cancelled` and `reprint_requested`; none should be named physically printed without hardware evidence.
- **Bridge storage:** persist a downloaded/leased job and its attempt before transport so a restart can reconcile it. Restrict ACLs, encrypt sensitive local state where practical, and delete receipt payloads after a documented retention period.
- **Transport boundary:** `simulator`, `network-escpos` and an explicitly selected Windows/USB implementation behind one interface. Never fall back to the system default printer.
- **Windows identity:** distinct directory, executable/service name, task or Windows-service identity, event/log source, updater and uninstall target—for example `C:\ProgramData\CalEats\PrintBridge` and `CalEatsPrintBridge`. Stop processes by exact registered service/PID, never by generic script-name matching.
- **Configuration:** no live default URL. Require an explicit Cal-Eats API origin and environment marker, reject original Calai hosts, keep credentials out of downloadable query strings, and use separate logs and startup entries.
- **Operations:** show bridge connectivity, transport health and last attempt separately. Label manual reprints on paper and in audit history. Rate-limit polling and use jitter/backoff so many offline devices do not synchronize.

## Recommended simulator before implementation or hardware work

Build the first adapter as a local-only process with synthetic restaurants/orders and a file sink. It must never call the Windows print spooler, open port 9100, discover LAN devices or use a Calai URL. In simulator mode, reject non-loopback backend origins and disable all physical transports.

For each attempt, write a deterministic receipt artifact, simulated ESC/POS byte artifact and small metadata record containing job/attempt IDs, payload hash and simulated outcome. Persist simulator state across restart. Provide controllable fault points:

1. offline before poll;
2. disconnect after lease but before payload persistence;
3. crash after local persistence but before dispatch;
4. transport failure before any bytes are accepted;
5. ambiguous disconnect after simulated bytes are accepted but before acknowledgement;
6. lost/duplicated/delayed acknowledgement;
7. concurrent polls for one device;
8. service restart with an outstanding lease;
9. credential revocation/rotation; and
10. a second restaurant attempting to claim, fetch or acknowledge the first restaurant's job.

Acceptance evidence should show atomic single-device claims, no cross-tenant receipt disclosure, bounded retry/backoff, recovery after restart, deduplicated acknowledgements, persistent `uncertain` outcomes, audited labelled reprints, honest heartbeat/offline status, and receipt snapshots containing Cal-Eats order/fulfilment/items/modifiers/notes/totals/payment state. Simulator success proves only protocol and formatting behaviour, not Windows spooler, network printer or paper output.

## Unresolved source, operational and hardware questions

1. Is this snapshot the complete and currently deployed bridge source, or is there another bridge repository/package? Which of the two different default API-host variants is actually deployed?
2. Are deployed printers using the custom Node poll protocol, native Star CloudPRNT, raw TCP 9100, a Windows driver, USB, or a mixture?
3. What exact printer makes/models, firmware, paper width, printable columns/DPI, interfaces, code pages, cutter commands and status-query capabilities are supported?
4. Is each restaurant expected to have one printer or routed kitchen/front-desk printers? Are multiple copies, categories or fallback printers required?
5. At what order state should automatic printing occur: paid/placed, restaurant-accepted, or another state? Who may request a reprint and what reason/approval is required?
6. Will Calai and Cal-Eats run on the same Windows tablet? If so, what CPU architecture, Windows edition, service-account restrictions, proxy/TLS inspection, firewall/AV controls and Intune ownership apply?
7. How are current devices paired in practice, and are any undocumented deployment tools, startup tasks, credentials or remote-management policies involved?
8. Can the target hardware report buffer/paper/cutter completion, or only connection/write acceptance? This determines the strongest truthful status Cal-Eats can expose.
9. What retention is required for receipt payloads, attempt metadata and device logs containing customer names, phone numbers, addresses and allergy/order notes?
10. Which development tablet/printer is authorised for later coexistence and physical testing? Until separately authorised and tested, all hardware behaviour remains unverified.

## Implementation gate

Do not copy the installer or activate a transport yet. The next implementation should begin only after the shared order/tenant contract fixes the restaurant, order and reprint identifiers and confirms the automatic-print trigger. Safe work can then proceed locally in this order: schema/protocol contract, local simulator and tenant/retry tests, Cal-Eats bridge package with physical transports disabled by default, then separately authorised hardware/coexistence validation.
