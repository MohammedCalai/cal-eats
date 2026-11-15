# Windows ordering terminal and printing

This describes the new enrollment/signing implementation, not a completed
hardware rollout. No installer, new CNG key, printer submission or tablet setup
was executed while implementing this revision. Real SYSTEM startup, browser
loopback access, enrolled-tablet status changes, driver faults and paper output
still need an authorized Windows device check.

## Identity and authority

The ordering terminal is one protected Windows process. It hosts the loopback
companion and the existing Cal-Eats print worker. In shared mode it runs inside
the reviewed original Calai process and uses its existing network dispatch FIFO;
the original Calai poll, voice-order workflow, server, credentials, configuration
and startup identity are unchanged. There must not be a second Cal-Eats poller
for the same printer or a second process competing for port 17863.

The protected Windows runner must already be SYSTEM. The installer does not
elevate or replace an existing Calai runner. A user-owned/native Downloads copy
is rejected for secure shared installation before it is changed. If the runner
cannot use the machine key, Cal-Eats fails closed and the independent original
Calai poll remains running. An administrator must install the reviewed managed
copy in a protected location before enabling Cal-Eats there.

The PowerShell helper creates a machine P-256 CNG key named
`CalEats.Terminal.<server-issued UUID>`. Microsoft's Software Key Storage Provider
is the supported default. A managed administrator may explicitly select
`terminal.keyProvider="tpm"` for Microsoft's Platform Crypto Provider only after
verifying its compatible policy/ACL behavior on that device. There is no silent
provider fallback or replacement after a key exists. ExportPolicy is None,
usage is signing only, and its
persisted protected DACL allows SYSTEM/local Administrators only. Every use
checks the key/provider/export policy and reads the persisted protected DACL back
to verify exactly SYSTEM and local Administrators. Unsupported policy/readback
fails closed. Only the public SPKI and a 64-byte
IEEE-P1363 SHA256 signature leave the helper. No PEM/PFX/private key, terminal
bearer credential or delegation token is stored in the browser/localStorage.
The server verifies possession and owner-approved pairing; a public key alone
does not remotely attest TPM use or Windows nonexportability.

Public identity metadata is saved atomically in `var/terminal-identity.json`.
The existing printer-only token and crash journal stay in the installation's
protected `var` directory. USER delegation exists only in process memory and
is discarded on restart/disconnect/authorization failure. A local administrator
or compromised SYSTEM process is outside the protection provided by CORS/CNG.

## Installation and enrollment

1. On the authorized Windows ordering tablet, download its current printer
   setup from Cal-Eats. Extract the complete reviewed ZIP and run its root
   `start.bat`, allowing its administrator prompt; it invokes
   `windows/install.ps1`. Managed tooling may deploy that installer as SYSTEM.
   Do not use the old original-Calai ZIP installer: it has broad process-stop
   behavior and only knows the original Calai API.
2. Standalone installation uses
   `%ProgramData%\CalEats\Printers\<printer UUID>` with a protected ACL and
   task `CalEatsPrinter-<printer UUID>`, triggered at startup/logon as SYSTEM.
   The trusted runtime signature/version is checked. Only that Cal-Eats task
   is updated. Shared installation instead preserves the original trusted
   runner and installs Cal-Eats alongside its reviewed source; it adds no task.
3. Both paths copy `terminal-key.ps1` and `printer-adapter.ps1` with all JS
   modules. Installed production config enables the companion on port17863,
   exact origin `https://eats.calai.info`, its printer UUID and a15-second
   configurable health interval. Existing journals/credentials are preserved.
4. Sign in to Cal-Eats on that Windows browser. An authorized owner/admin
   issues the10-minute one-use terminal code/challenge. The business screen
   sends those to the local enrollment interface. The companion creates the
   CNG key, signs the challenge and submits its public SPKI. Retrying a lost
   response reuses the same persisted key; it never silently replaces it.
5. The browser obtains a2-minute one-use handoff from its HttpOnly authenticated
   session. The companion exchanges it in a signed request for an in-memory
   delegated USER session, bounded to that terminal/screen/original session
   (maximum8hours). Original sign-out, revocation and permission changes remain
   authoritative on the server.
6. Each screen pulse requires a fresh40-second one-use challenge fetched by
   the original browser session. The companion forwards it signed and with
   the delegation. The server requires fresh contact AND this screen evidence.
   A running headless printer/companion never proves the ordering page is open.
7. Only after enrollment does the existing one-use printer setup finish and
   the worker claim Cal-Eats jobs. Confirm the visible terminal/printer status
   and perform an explicitly authorized labelled sample receipt before rollout.

The package's physical-print flag is installed for the explicitly configured
printer. It is not an authorization to discover printers, submit real orders or
run a hardware test during development. There is no default-printer fallback.
For a named Windows spooler use `transport.kind="windows-spooler"`,
`enabled=true`, an explicit `printerName` and `timeoutMs`; the unchanged original
Calai USB/default-printer routine is not used to infer receipt completion.
Do not run independent Calai/Cal-Eats workers on the same USB printer.

## Browser/local protocol

Only `http://127.0.0.1:17863` is bound. Host must match that exact loopback host
and port; Origin is checked against exact configured origins on every request,
including bootstrap and CORS/private-network preflight. Wildcards, null/missing
Origin, alternative hosts and arbitrary-site requests are rejected before any
key or backend operation. The caller must use JSON and the in-memory
`X-Cal-Eats-CSRF` returned by `GET /v1/bootstrap` for every POST. Browser local
network permission may also need to be allowed for Cal-Eats.

- `POST /v1/pair`: `{terminalId,code,challenge,deviceName}`.
- `POST /v1/session`: `{terminalId,handoffToken}`; never returns sessionToken.
- `POST /v1/screen-heartbeat`: `{screenId,challenge}`.
- `POST /v1/request`: `{method,path,body?,idempotencyKey?}` for the fixed business
  order/printer route allowlist; server role/tenant checks still apply.
- `POST /v1/disconnect`: drops in-memory delegation.

Bootstrap CSRF is origin protection, not USER authorization. A successful
`/v1/session` returns a random `userProof` only to the browser presenting its
own authenticated one-use handoff. That browser keeps the proof in memory
and sends `X-Cal-Eats-User-Proof` on `/v1/request`, `/v1/screen-heartbeat` and
`/v1/disconnect`, including diagnostic reads. Bootstrap never exposes it;
neither the browser nor the service persists it. A new successful USER handoff
rotates the proof. A different browser/profile, stale tab or previous operator
cannot borrow or disconnect the replacement USER session using global CSRF.

The service captures the matching private USER grant before signing and
rechecks its generation before dispatch. Delayed requests and authentication
errors affect only their captured grant, never a newer operator. A definite
invalid one-use handoff can be refreshed once using the requesting browser's
valid cookie. An ambiguous/lost exchange requires a fresh handoff; a rejected
browser proof pauses automatic reconnection until **Check connection** so an
old page cannot repeatedly replace the active operator. Logout/page cleanup
sends only its own captured proof. Original-session revocation remains
authoritative on the server even if local cleanup cannot reach the service.

There is no signing endpoint, caller-supplied remote origin, arbitrary header
forwarding or browser-accessible headless service endpoint. Redirects are
rejected. Request size, response size, timeouts, connections and rate are
bounded. Browser output never includes provider credentials, CNG material or
the delegated session token.

Pairing proof is UTF8 newline-joined:
`CAL-EATS-PAIR-V1`, terminalId, server challenge, SHA256hex(SPKI DER).
Request proof is UTF8 newline-joined: `CAL-EATS-TERMINAL-V1`, terminalId,
epoch-millisecond timestamp, fresh random nonce, uppercase method, exact
pathname+query, SHA256hex(raw body bytes). Nonces/freshness/revocation are checked
by the server. Every retry gets a fresh signature; operation idempotency is
separate and stable. Headless printer requests additionally carry only their
existing printer-scoped bearer; merchant commands carry the delegated USER.

## Printer evidence and duplicate prevention

Windows diagnostics use Win32 OpenPrinter/GetPrinter level2 for the explicit
printer name. Reported out-of-paper/cover-open/paused/error/offline flags map
to explicit faults. Zero flags mean **no reported printer fault**, not paper
readiness. Drivers may not report faults: physicalReadinessKnown stays false.
Raw TCP probes send zero bytes and establish only connectivity; they never
infer paper/cutter/driver status. Unsupported physical state remains unknown.

Before any physical write, the worker calls the signed, printer-authenticated
`POST /api/devices/jobs/:id/submitting` with the claim token. Failure prevents
the write. It durably marks local dispatch before writing. The named Windows
RAW-spooler adapter captures the StartDocPrinter job ID and returns `submitted`
or `uncertain`. TCP acceptance is `submitted` with paper explicitly unverified.
No adapter claims physical `printed` from socket acceptance, job completion or
removal from a spooler. The file sink's `printed` is explicitly simulation only.

Outcome and spooler ID are persisted before acknowledgement. A lost response
replays the identical acknowledgement/claim token, never the printer bytes.
A restart after dispatch began without a durable result becomes uncertain.
For a new server `dispatched` attempt with no submission marker, expiry proves
that no physical submission was authorized. The server may safely retry at most
three attempts, with5/10-second backoff and invalidation of earlier claim tokens.
The journal accepts a later attempt only when the earlier local attempt never
began dispatch and has a terminal acknowledgement state. Legacy `claimed` rows
cannot prove this and become uncertain, even if an old lease is still present.
Queued completed/rejected originals are cancelled with history retained;
intentional pending tickets and future schedules do not expire merely by age.
Lease expiry after submission never authorizes another physical send. Uncertain jobs require
an operator's labelled manual reprint; there is no automatic reprint after
submission/acknowledgement uncertainty.

The signed-in registered tablet can inspect bounded receipt history and make an
explicit physical check. `receipt_found` records the operator's report as
submitted; `not_printed` closes the attempt as cancelled. Both retain an audit
with prior status/result/spooler ID and resolve that attempt's incident without
claiming hardware recovery. Neither sends a receipt. A subsequent labelled
reprint is a separate, idempotent request; another queued/dispatched copy blocks
it. No order, payment or payout state is changed by a receipt check.

## Replacement and diagnostics

First revoke/replace the old terminal using an authorized owner/admin account.
Server revocation invalidates its key, delegated sessions and screen readiness.
On a new tablet install the protected service and enroll with a fresh code.
Because printer credentials bind to a terminal, generate a fresh printer setup
for replacement; do not copy the old credential, key or journal to another PC.
For deliberate re-enrollment on the same PC, an administrator stops only its
specific Cal-Eats task, archives its public identity file, retains the journal
for investigation, restarts that task and enters the new owner-approved code.
Old CNG keys are not automatically deleted and cannot pass server revocation.
Never delete an uncertain print journal to force another receipt.

`windows/status.ps1 -PrinterId <UUID>` reports scoped task/file presence only.
It does not prove enrollment, live ordering-page presence or paper output.
Use the authenticated dashboard's last-contact/source/fault and job evidence,
then check the actual receipt. No broad Node-process kills or original Calai
task/credential changes are part of this procedure.

Microsoft references:
[CNG export policy](https://learn.microsoft.com/dotnet/api/system.security.cryptography.cngexportpolicies),
[NCryptSetProperty security descriptors](https://learn.microsoft.com/windows/win32/api/ncrypt/nf-ncrypt-ncryptsetproperty),
[key storage properties](https://learn.microsoft.com/windows/win32/seccng/key-storage-property-identifiers),
[PRINTER_INFO_2](https://learn.microsoft.com/windows/win32/printdocs/printer-info-2),
[JOB_INFO_1 completion caveat](https://learn.microsoft.com/windows/win32/printdocs/job-info-1),
[Win32_Printer driver status limitations](https://learn.microsoft.com/windows/win32/cimwin32prov/win32-printer).
