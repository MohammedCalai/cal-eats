# Cal-Eats service mailbox

The requested sender is **caleats-support@calai.info**, display name **Cal-Eats Support**. It was created as a Microsoft 365 shared mailbox on 28 October 2026. No extra mailbox licence was purchased. The domain's mail is hosted by Microsoft 365; IONOS remains the domain/DNS provider.

The owner explicitly approved adding their existing Microsoft account as a member with Full Access and Send As to this new mailbox. Microsoft confirmed these grants in the mailbox view. Sent-as messages are copied into the shared mailbox's Sent Items. No forwarding or automatic reply was configured and no original Calai mailbox was edited.

## Separate app connection

The owner approved a new single-tenant registration named **Cal-Eats Service Notifications**, Microsoft's registration policies and encrypted private sign-in storage. Its configured API permission is delegated `Mail.Send.Shared`. The unused default `User.Read` API permission was removed. Sign-in also requests the standard basic-profile and ongoing-sign-in scopes; no mail-reading API permission is granted. Consent was applied to the signing-in owner account, not tenant-wide.

Microsoft's shared-send permission can send through mailboxes to which that account already has appropriate Exchange permissions. This broader scope was explicitly explained and approved. The Cal-Eats adapter additionally pins the authenticated account and sender from private settings. The owner can read/manage the new shared mailbox through Outlook; that does not give this app inbox-reading access.

Device-code sign-in was rejected by Microsoft's security defaults (530035). No tenant security or MFA policy was weakened. The connection instead completed normal browser authorization with PKCE, a random nonce/state and a loopback-only return address. Microsoft MSAL manages silent token renewal. A future Microsoft sign-in policy or revocation can require an interactive reconnection.

## Private settings and operation

The ignored `.env.order-alerts` contains the owner-approved recipient and sender, app/tenant identifiers and private cache paths. `artifacts/service-mail/` and the settings file have Windows inheritance disabled and access granted to the current user. The token cache uses AES-256-GCM with a separate 32-byte key and authenticated bindings to app, tenant, mailbox and signing-in account. No token/password belongs in Git, chat, a migration export or operational logs.

`npm run mail:connect` completes the approved interactive sign-in; `npm run mail:check` verifies silent access without sending. These commands do not enable automatic email. The private sign-in instructions are removed after the operation. `npm run mail:send-check` only describes a connection check; the explicit `--send-confirmed-owner` flag sends one check to the configured owner address. Its private dispatch journal prevents blind repeats. A definite provider rejection may be retried explicitly after correction with `--retry-definite-failure`; an accepted or unknown result must never be automatically repeated.

Runtime real delivery requires both `CALAI_ORDER_ALERT_EMAIL_MODE=graph` and `CALAI_MAIL_GRAPH_ENABLED=true`, plus the approved encrypted cache/key. The local rich fixture currently stays in `local` mode, writing private multipart `.eml` files rather than sending test-customer mail. A mode change does not promote already saved local notifications into real email. Customer recipients on reserved fictional domains are blocked from external delivery.

For hosting, provision the encrypted cache on persistent private storage and the encryption key as a separate hosting secret. Do not bake either into the image. The currently paused Railway deployment has not received these files or this code. Verify one accepted check and the administrator delivery views before enabling workers on the hosted service.

## Current delivery verification

Microsoft accepted the controlled connection email from caleats-support@calai.info to the owner-approved administrator address at 2026-10-28T12:36:40.126Z. The private dispatch journal records status sent; its guard prevents another automatic connection-check email. Provider acceptance verifies sending permission but does not by itself prove inbox delivery. Customer/owner workers remain in local mode while the new hosted deployment is on hold. The private Graph connection is enabled and ready for the separately gated hosted configuration.

The new permissions initially required propagation. [Microsoft documents up to 60 minutes for mailbox permission changes](https://learn.microsoft.com/en-us/office365/admin/add-users/give-mailbox-permissions-to-another-user?view=o365-worldwide).

See [Microsoft's shared-sender requirements](https://learn.microsoft.com/en-us/graph/outlook-send-mail-from-other-user), [MSAL browser authorization](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-node/docs/request.md), [the confirmation worker](ORDER_CONFIRMATION_BACKEND.md) and [customer transactional emails](CUSTOMER_TRANSACTIONAL_EMAIL.md).
