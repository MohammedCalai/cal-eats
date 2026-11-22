# Cal-Eats business workspace frontend

This is implemented source in the existing `apps/portal` application. It is not evidence of a live release, a physical Surface/printer check, or push delivery to a phone. The consumer app identity and original Calai repository are unchanged by these portal changes.

## Accounts and presentation

- Existing Cal-Eats sign-in remains the default standalone flow. An explicit Calai business-owner verification flow uses `/api/business/auth/calai/login`; it has a separate credential destination, clears passwords on completion/failure/mode change, and does not fall back between products.
- `/api/business/context` and `/api/business/accounts` supply the current authorised location association. Product native account references remain distinct. Selecting a location uses the server-side account-selection endpoint and resets the restaurant view; local IDs are not authority.
- Navigation groups Workspace, Calai, then Cal-Eats. Calai pages appear only when the backend reports permission, a verified native account, readiness, and an effective ready state. Cal-Eats history remains accessible under its native permission when service is disabled.
- Accounts & connections shows both product cards, including an absent native account, without creating a dummy merchant. Owners can verify/connect when administrator permission allows; there are no owner activation, pause, resume, unlink or disconnect controls.
- Linking uses a prepare/confirm flow, a server-issued single-use proof, explicit restaurant/branch confirmation and, when supplied, confirmation of the existing workspace association. Native Cal-Eats account selection comes only from verified owner account choices. A native-login change reloads the authorised session.
- The dashboard displays separate product counters. A source failure is unavailable, never a zero. Period and order-status definitions are shown separately from payment and payout totals.
- Statements are separate product sections with product-specific financial permission. Native Calai settings/statements open their existing supported workflows. The portal never posts a Calai settings form, synthesises a statement, or nets the products' balances.
- Native call history opens the verified existing `https://calai.info/owner/call-summary` page. Calai's call-summary reads can update native records, so the integration does not poll or proxy that workflow.

## Administrative views

- `/business/admin/business-accounts` lists the integration's authorised product/account associations with bounded search/filter/page controls, including Calai-only businesses.
- Its **Sync Calai account references** button explicitly calls `POST /api/admin/business/accounts/sync-calai`. It is never called automatically on mount. The server requires separately authorised source-platform authority; a source error does not write native Calai records.
- Both product cards appear in the existing restaurant overview. Their administrator controls distinguish **Allow Calai connection in the combined workspace** and **Enable Cal-Eats**. A confirmation explains the different impact before saving the administrator-only permission.
- `/business/admin/surface-monitoring` starts with the offline-business filter and offers other states and pagination. Administrator timing controls load the actual server settings and save only on deliberate submission. There is no business monitoring-disable control.

## Operational tablet and monitoring

- Terminal discovery on Windows is only a bootstrap optimisation. A user agent never grants authority. The existing local terminal client must return a verified, scoped terminal context.
- A separately authenticated human owner/admin session remains human for its authorised settings and finance views. Operational requests use the authenticated local broker as controlled by the API transport.
- Cold-start bootstrap first checks the real human session. A failed connection retries only after the native broker has confirmed that this Windows device was previously paired, with 5/10/30/60-second backoff and generation/abort guards. Unknown/unpaired/revoked devices never enter that retry loop. Explicit logout stops automatic sign-in; a new successful explicit sign-in can release that page's bootstrap latch.
- Accept, reject, preparation/fulfilment, ETA, test-print and reprint controls require the actual ready terminal context matching the selected native restaurant/location. Ordinary browser and phone users see view-only orders, including “Awaiting acceptance on restaurant tablet.” Backend enforcement remains mandatory.
- Printer configuration permission stays separate from tablet print permission. An automatic operational terminal need not acquire owner/financial privileges to test or deliberately reprint a receipt.
- `surface-presence-client.js` performs a signed own-location pending-order receive check before every signed active heartbeat. It sends only a positive monotonically increasing sequence and application state; it does not send an editable online flag, customer data, browser-network guesses or printer-service heartbeats.
- Sequence state lives outside React effects, so a Strict Mode remount cannot replay the preceding heartbeat. One request runs at a time. Cancelled/unmounted work cannot publish late active state.
- The server-provided heartbeat interval is respected. A previously verified paired/scoped terminal can reconnect through the real broker after connection loss with 5/10/30/60-second bounded backoff. Unknown, unpaired, revoked or explicitly signed-out contexts cannot use this recovery. Failed operational writes are never replayed.
- Explicit Cal-Eats sign-out waits for the signed `signed_out` presence attempt before disconnecting the local client. If the network prevents that report, it is not represented as confirmed server receipt; ordinary stale-session detection remains authoritative.
- After a deliberate new sign-in, presence can reset its logout latch only after both human authentication and a fresh native terminal identity are verified. Resetting alone sends no heartbeat: the mounted matching-location client still has to receive its own orders through the signed route before it can report active.
- Surface and printer observations are separate. Device incidents have bounded history and read state. Marking read does not resolve a fault, invent physical readiness or make a Surface online.
- The Devices page shows owner-controlled enrolment only when the backend supplies the current native `manageTerminal` capability. It downloads the reviewed standalone Windows installer and a short-lived one-use enrolment JSON, confirms the correct location, explicitly confirms replacement or revocation, and never exposes operational grant tokens. The downloaded enrolment file must be kept private and supplied to the installer by the Windows setup administrator within ten minutes.
- Replacement setup alone leaves the current tablet registered. Completing the replacement enrolment revokes the old device. Explicit revocation removes access immediately; there is no remote order-processing fallback. Actual Windows installation/CNG readiness is not inferred from downloading files.
- Staff capability changes in owner Settings and platform-administrator restaurant Access use independent finance, devices, menu and marketing permissions. They do not change staff into owners or grant tablet order-processing rights. Device principals are omitted from the human staff list.
- Website navigation and tools honour those exact native staff capabilities. Financial managers receive read-only earnings, order breakdowns and masked bank/payout history; bank onboarding/updates, commercial agreements, settings and staff management remain owner-only. Menu editing uses a separate menu capability instead of pretending a staff member is an owner. Marketing access does not grant customer-directory or inbox management.

## Embedding in the permitted native Calai frontend

- `/business/embedded` is a dedicated child entry. When genuinely framed it uses a memory router, starts at Accounts & connections and keeps the HTML URL on the CSP-scoped entry through internal navigation and sign-in. A changed native Cal-Eats session reloads the same embedded entry.
- The child stays mounted across its views; the original Calai parent is responsible for keeping the iframe mounted while native Calai navigation is shown. This retains the actual receiving client and presence scope.
- Messages accept only the exact `https://calai.info` parent and `event.source === window.parent`. Navigation is an enum mapped to fixed internal routes; messages never authenticate an account or contain arbitrary URLs.
- Child state contains only bounded workspace identification, verified native references, per-product permission/readiness, explicit native Cal-Eats capabilities, aggregate product counters and the Surface state. No passwords, tokens, customer/order contents or financial balances are posted to the parent.
- The parent must match the verified Calai native business/user IDs before showing combined navigation. Ordinary Calai operation remains independent if the child, integration or source reads are unavailable.
- The Cal-Eats frontend cannot establish whether a protected Calai host offers an isolated frontend-only deployment route. That release boundary must be checked separately before any Calai asset release.

## Verification and remaining device checks

Focused automated tests exercise independent readiness/permission/native IDs, unavailable versus zero counters, explicit proof/branch confirmation, safe native links, exact-parent embedding, secret/PII omission, cross-location terminal presentation, monotonic presence, request cancellation, safe sign-out and bounded broker reconnection. Production Vite builds verify the existing application integration.

Physical Surface automatic sign-in/recovery, actual printer diagnostics/output, Safari/SameSite iframe behaviour and real phone push display still require their corresponding authorised devices/providers. Automated fixtures do not establish those physical outcomes. No deployment or disruptive real order, payment or call is performed by this frontend work.
