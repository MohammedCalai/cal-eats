# Customer transactional email

Cal-Eats creates durable customer email records for restaurant confirmation, ETA changes, preparation/ready/out-for-delivery/completion/cancellation updates, confirmed refund recording, restaurant messages in active order chats or persistent customer conversations, and support-team replies/remedy updates. Offer campaigns are excluded. Marketing opt-out does not suppress an order or support service notification.

The source notification and outbox entry are inserted together in the source transaction. A customer/source-event unique key makes API retries and repeated notification events safe. Existing historical notifications are not backfilled when the code is installed. Each record snapshots the delivery mode, account recipient and safe order details at creation; a mode change or changed/disabled customer address cancels an unsent record rather than silently changing its destination or promoting old local previews to real email.

## Branding and privacy

Messages contain escaped HTML and a plain-text alternative, the approved Cal-Eats logo, dark header, blue action button, order reference, restaurant, items/prices and the agreed arrival/collection ETA where relevant. Sender/footer use the configured Cal-Eats sender mailbox. Simulated orders are clearly marked as preview payments. Order details exclude customer name, phone, delivery address, delivery/allergy notes and payment credentials.

Order chat, customer conversation and support emails notify the customer of a reply with an authenticated app link. Encrypted correspondence bodies remain in the app: they are not decrypted or copied into the outbox, email or operational logs. Recipient ownership, current restaurant membership and relevant message expiry/window are checked again before transport dispatch. Reserved fictional domains are allowed for local files only and blocked from external delivery.

The customer web client handles links after login using `/order/` with `orderId`, `messages=1`, `conversationId` or `supportCaseId`. A refund-case update can additionally include `caseId` with its order. Authorization on the destination API remains authoritative; a URL does not grant access.

## Worker and operator view

`runCustomerTransactionalEmails(db, config)` is scheduled alongside the three-minute owner-alert worker. Each batch is bounded to 25 records (hard maximum 100). Dispatch uses an atomic lease and a final source/ownership check. A worker that loses its lease cannot overwrite the recovered state. Recovery returns a pre-dispatch interrupted claim to pending; a claim interrupted after dispatch begins becomes `unknown`. Failed or unknown records are visible for investigation and never retried automatically. This prevents a blind resend when a provider may already have accepted the email.

`GET /api/admin/customer-emails?page=1&pageSize=25` is platform-administrator only. It returns nested `data.items`, `pagination`, status `summary` and sanitized transport readiness. Items expose source identifiers, masked recipient, status, attempt count and safe error code. Body, payload, credentials and full recipient email are excluded.

Statuses are `pending`, `claimed`, `local_saved`, `sent`, `failed`, `unknown` and `cancelled`. `sent` means the configured provider accepted the submission, not that a customer inbox received it. There is no automatic/manual resend endpoint in this version; ambiguous delivery requires an operator check before deciding any separate action.

## Connection and schema

The customer worker reuses the approved `orderAlertEmail` transport configuration and does not require the separate administrator escalation recipient. Local mode is the default and writes private multipart `.eml` files under the configured local mailbox directory; it sends nothing externally. SMTP or Microsoft Graph must be explicitly configured and authorized before real delivery. A connected Codex Outlook account alone does not grant this application persistent mailbox access. The requested sender is the new Cal-Eats shared mailbox `caleats-support@calai.info`; Graph consent, sender permissions and encrypted token storage are managed by the separate mailbox connection workflow.

Migration 27 adds the customer outbox and delivery-mode singleton, and preserves existing three-minute owner-alert rows while extending their delivery-mode constraint to Graph. Application startup applies migrations before initializing delivery settings or starting workers. Existing original Calai files and credentials are not changed or reused.

The original Calai source was inspected read-only at `reference/calai-platform-ab138fd/backend/src/app/utils/order-email.js` and `sendEmail.js`. Its escaped HTML/plain-text order layout informed this email's presentation. Its order helper targets the restaurant owner's email and does not itself provide this customer outbox; the new recipient isolation and durable worker belong to Cal-Eats.

Focused validation: `node --test apps/api/test/customer-emails.test.js`. Tests use temporary local databases and local mail files or injected transport doubles, with no external sends.
