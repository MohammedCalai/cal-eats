# Registered ordering terminal authority

Business sign-in grants account access. It does not grant authority to accept,
reject, prepare, fulfil, or print orders. Those requests require the restaurant's
one active registered terminal, a valid business operator session, and a fresh
browser-screen presence proof. Customer receipts, payment webhooks and internal
expiry/payment workers do not acquire or require merchant terminal authority.

## Registration and replacement

An active restaurant owner or administrator creates a ten-minute, single-use
registration with `POST /api/restaurant/restaurants/:restaurantId/terminal/pairing-code`.
Replacing an existing terminal requires `{ "replace": true }`. The terminal is
not replaced until the new device proves possession of its P-256 key. Completing
replacement atomically revokes the previous terminal and delegated sessions.
`POST .../terminal/revoke` revokes immediately. Public status is available to
authorised members at `GET .../terminal`.

The Windows companion creates its non-exportable machine key. Only its public
DER SPKI key is supplied to `POST /api/terminal-devices/pair`, with `terminalId`,
`code`, `deviceName`, and `challengeSignature`. Codes are stored as SHA-256 hashes;
audit records exclude codes, signatures and delegated session credentials.
The backend verifies possession of the supplied key; it does not claim hardware
attestation of that key's storage properties.

The pairing proof is SHA-256 ECDSA over these UTF-8 lines, without a final newline:

```text
CAL-EATS-PAIR-V1
<terminalId>
<server challenge>
<lowercase SHA-256 hex of SPKI DER bytes>
```

The public key is standard base64. Signatures are 64-byte IEEE-P1363 encoded as
unpadded base64url. A lost pairing response may be recovered with the same code,
same active terminal and same key proof. A different key or revoked identity
cannot recover or replace that registration.

## Signed requests

The companion sends `X-Cal-Eats-Terminal-Id`,
`X-Cal-Eats-Terminal-Timestamp` (epoch milliseconds),
`X-Cal-Eats-Terminal-Nonce` (at least 16 random bytes, base64url) and
`X-Cal-Eats-Terminal-Signature` (P1363/base64url). The exact canonical UTF-8 input is:

```text
CAL-EATS-TERMINAL-V1
<terminalId>
<timestamp header>
<nonce header>
<uppercase HTTP method>
<pathname plus exact query string as sent>
<lowercase SHA-256 hex of exact request body bytes>
```

Requests are valid within 60 seconds of server time. Nonces are durable and
single-use. JSON handlers share the cached original body bytes with verification;
they do not reserialize JSON before verifying it. Revocation and tenant membership
are checked again before order state is committed after any payment-provider wait.

## Browser presence and delegated user session

An original, valid HttpOnly browser session requests
`POST .../terminal/session-handoff` with a random `screenId`. The two-minute
`handoffToken` is sent to the local companion. The companion exchanges it through
signed `POST /api/terminal-devices/:terminalId/session` and keeps the returned
`sessionToken` only in memory. It sends that token as
`X-Cal-Eats-Terminal-Session` on its fixed merchant-operation proxy. Tokens are
bound to the original user/session, terminal, restaurant and screen; they expire
after at most eight hours or the original session expiry. Original logout,
account disablement, membership removal or terminal revocation invalidates them.
Each successful exchange also consumes every older pending handoff and screen
challenge for that terminal. A delayed previous browser cannot exchange an old
handoff and revoke the new operator's session.

The local companion returns a separate random, memory-only browser proof after
that browser's own successful handoff. Its operational proxy, screen heartbeat
and disconnect require that proof; origin/CSRF bootstrap alone is insufficient.
The proof does not replace the protected Windows key or server user/session
checks. Requests capture their exact user grant and generation before signing;
an asynchronous old request cannot be sent under a newer operator's grant.
An uncertain handoff response stops automatic reconnection until the operator
explicitly checks the connection again.

The original browser separately requests a 40-second, one-use
`.../terminal/screen-challenge`. The companion forwards it in signed
`.../:terminalId/screen-heartbeat` with the screen ID and delegated session.
Native and delegated sessions cannot issue either browser proof. Headless
`.../:terminalId/heartbeat` and signed device-health reports establish companion
contact only; they cannot establish an open ordering screen. Replacing a delegated
sign-in clears previous screen readiness and requires fresh proof.

Contact and screen freshness use `businessDevices.staleAfterSeconds` (60 seconds
by default). The separate device-health worker manages closure confirmation and
recovery. A manual restaurant pause is independent of connectivity recovery.

## Printing and manager access

Device pairing and printer queue claims/acknowledgements additionally require the
active terminal signature and a correctly scoped printer credential. Existing
unbound credentials may bind once to the active terminal; a credential already
bound to another terminal is rejected. Management of printer configuration and
setup packages remains owner-controlled. Actual test receipts, manual printing,
retry checks and reprints require the signed operator and fresh screen.

Staff capabilities are explicit membership flags. Only the real owner may change
them through `/staff/:userId/capabilities`, with a transactional audit record.
Exact server route rules permit the corresponding menu, marketing, customer,
settings or read-only finance operations. Banking changes, agreements, credentials
and owner report-email requests stay owner-only. Native business capabilities
always report `canProcessOrders: false` and `canPrint: false`; account capability
flags do not turn a phone or ordinary browser into an ordering terminal.

Run the focused checks with:

```text
node --test apps/api/test/ordering-terminals.test.js
```

The checks use isolated local databases and synthetic signing keys. They do not
install a service, contact a printer, send external messages or charge a payment.
