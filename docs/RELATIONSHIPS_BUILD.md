# Customer relationships extension — 27 October 2026

## Implementation map

This extends the existing marketplace. It does not replace authentication, menu management, the commission ledger, printer bridge or provider boundaries.

| Area | Implementation |
| --- | --- |
| Temporary order messages | `order-messaging.js`, migration 19, AES-256-GCM content storage, participant read cursors, six owner-editable quick responses, bounded sending and metadata-only incident reports |
| Live tablet updates | Authenticated SSE with durable notification cursors, one shared database scan, per-user connection limits, session/membership rechecks and reconnect handling; browser fallback polls only while disconnected |
| Customers & Loyalty | `loyalty.js`, migration 20, restaurant-only completed-order analytics, configurable rolling-window segments, equal-elapsed-month trends and transparent growth suggestions |
| Promotions | Restaurant-funded gifts, percentage and fixed discounts; segment snapshots, time windows, eligible items/categories, budget and redemption caps, exclusive offers and transactional reservations |
| Restaurant-first disputes | `dispute-resolution.js`, migration 21, typed proposals, customer acceptance, evidenced fulfilment, customer confirmation, explicit escalation and existing durable refund execution |
| Interfaces | Customer browser and native source, React restaurant/admin portal, message incident review and admin promotion/voucher activity |

All work in this extension is local. Do not push this branch, trigger a hosted build, deploy, configure paid infrastructure or use a live payment operation without separate user authorisation. Original Calai is read-only and was not contacted or changed.

## Privacy and retention

- Ordinary messages are limited to 300 characters and cannot mutate paid order items, prices or payment terms. There are no ordinary-chat attachments.
- Customers can read only their order conversations. Current restaurant members can read only their restaurant's conversations. Administrators must provide a reason; content access is audited without copying the transcript into the audit.
- Active-order access ends after the terminal status plus the configured support window: two hours by default, capped at 24 hours. The normal interface removes closed content.
- Message ciphertext expires exactly 30 days after creation. Reads enforce expiry, and startup/background maintenance deletes expired rows. Notification payloads and incident records do not automatically copy chat content.
- Local keys are stored in a private `.cal-eats-message-key` file beside the database, excluded from Git, Docker context and managed backups. Hosted messaging requires an explicitly provisioned 32-byte key. Missing hosted keys fail closed for messaging.
- Managed backups exclude all temporary message rows, read cursors and rate buckets, using secure deletion and compaction of the backup copy. Order and formal dispute records are preserved. Restoring a managed backup therefore does not restore temporary conversations. Third-party snapshots need an independently enforced retention policy; this local change does not configure a cloud backup provider. Any older unmanaged snapshot must be purged of expired chats before serving it.
- Checkout notes, formal disputes, evidence and incident reports are separate categories. No automatic legal hold or indefinite chat preservation has been added. Exceptional legal preservation needs a separately reviewed, explicitly recorded process.

## Financial and communication rules

All new promotions are restaurant-funded. Platform funding and combining offers are rejected. Prices are calculated on the server in integer pence; `/api/orders/quote` has no reservation or payment side effects. Checkout revalidates eligibility and reserves budget atomically. Orders and receipts retain gross food, discount allocations and net charged food.

The existing 7% rate and each accepted order policy's `food` or `food_plus_delivery` basis remain in force. Restaurant discounts reduce the food actually charged; delivery enters the base only where the existing accepted policy says so. Free gift lines remain zero. Refund caps use the original net paid amounts, and commission reversals retain existing rounding and idempotency rules.

Submitting a complaint does not refund money. A restaurant proposal is distinct from customer acceptance and fulfilment. Non-refund remedies need restaurant evidence plus customer confirmation, or an audited admin override. Refund approval is distinct from provider execution confirmation. Cash repayments use their separate evidenced confirmation process. Repeat-request flags are review aids; the monthly goodwill restriction does not reject genuine refund claims.

Promotional in-app and push consent are separate, default off, auditable and withdrawable. Operational notifications continue independently. Push preference storage does not constitute a connected push service. Formal remedies are not a marketing-consent workaround. The implementation uses explicit opt-in rather than assuming a PECR soft opt-in. See [ICO electronic mail marketing guidance](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-direct-marketing-using-electronic-mail/how-do-we-comply-with-the-pecr-electronic-mail-marketing-rules/). Consumer remedies remain subject to the circumstances; the application must not restrict statutory rights. See [GOV.UK refund guidance](https://www.gov.uk/accepting-returns-and-giving-refunds).

## Verification and practical limits

The isolated walkthrough uses a copy of fictional local data on port 4312, never the hosted database. A £12 food basket with a 10% restaurant promotion quoted and ordered at £10.80; its legacy food-only 7% policy produced 76p commission. Both participants exchanged messages. A new message appeared in the restaurant's open conversation without a manual refresh, and viewing it cleared the unread count. Staff sent a one-tap quick response.

The restaurant proposed a replacement, the customer accepted, and the case remained open. The restaurant recorded fulfilment evidence, which moved the case to customer confirmation. Only the customer's subsequent confirmation resolved it. The administrator's case view showed a replacement remedy with no refund execution required. The restaurant also created a bounded £5-off-£20 campaign through the dashboard. The customer selected it and the browser checkout displayed £24 gross food, £5 restaurant discount and £19 collection total consistently. This last quote did not submit another order or move money.

The integrated explicit test run passed 127 of 128 tests. The remaining SSE test had a heartbeat/timeout mismatch; its corrected real-loopback test passes. The final changed-area regression run passed all 21 tests across messaging, loyalty, disputes, governance, offers and backup exclusion, including the real SSE test. Coverage includes money-state locking, resolved/reopened cases, phase deadlines, marketing withdrawal, tenant isolation, encryption, expiry and price reconciliation. The final portal build passed; native type checking passed; release packaging checked 73 JavaScript files and 21 required release files. The full suite was not rerun after the final focused corrections.

Phone-width screenshots from the local walkthrough are saved under the ignored `artifacts/screenshots/` folder: `56-order-messages-phone.jpg`, `57-customer-remedy-phone.jpg`, `58-restaurant-loyalty-phone.jpg`, `59-restaurant-messages-phone.jpg`, `61-promotion-checkout-phone.jpg` and `62-admin-resolution-phone.jpg`. They contain fictional local fixture data.

The current deployment/payment mode remains a simulator. This extension does not establish live provider refunds/payouts, native push delivery, signed iPhone execution, physical tablet sound or physical printer output. The initial 10,000-account target is preserved through tenant indexes and bounded processing; this phase is not evidence of 10,000 simultaneous connected devices or a production load result.
