# Cal-Eats phone, CRM and order-notification phase — 28 October 2026

## Delivered locally

The customer app, separate Cal-Eats Admin iPhone/Android source, and restaurant tablet/browser platform share one Cal-Eats backend and membership model. Platform-administrator access remains a restricted business-platform role. No original Calai integration or migration was executed.

- Matched the signed-in Calai charcoal/blue layout and kept the approved Cal-Eats logo without the tagline. Customer browser and native customer colours were brought into the same theme.
- Added restaurant phone menu/item/photo/availability/choice tools, paged customers with restaurant-specific statuses, individual service conversations, reviewed targeted offers, notifications, refund cases and routed help correspondence.
- Built bounded CRM search/filter/pagination. A 10,001-customer fixture returned only 25 customers per page, approximately 13.3 KB, with deterministic paging and tenant-isolation checks. This is not a claim of 10,000 simultaneous users.
- Repaired help routing: request receipts identify the responsible restaurant or platform team, and customers can see/reply in the same durable thread. New order/customer messages have recipient-scoped unread state; durable ingestion sequence prevents late-arrival and purged-row read errors.
- Copied Calai's exact new-order and unconfirmed-order WAVs into this independent project. Global blue/amber alerts monitor all authorised restaurants across business routes. Sound requires a browser/device gesture, can be muted/snoozed, and acknowledgement alone never confirms an order.
- Added explicit Confirm with arrival/collection ETA, preparation, ready, out-for-delivery and delivered/collected progression. Order details stay open during progress updates. Customer notifications and order views show confirmed ETA and delivery progress.
- Added durable three-minute owner escalations from verified merchant visibility, with leases, deduplication and cancellation checks. The configured recipient is the owner-approved administrator address in private settings. A separate worker runs every five seconds, so three minutes is the eligibility threshold, not a guaranteed inbox deadline.
- Added branded customer transactional email queues for confirmed/ETA/status/refund updates, business messages and support replies. Message emails link to authenticated conversations without copying private chat text. Customer and owner email-delivery metadata are visible in platform administrator Orders, including local-only, failed and uncertain outcomes.
- Created the requested Microsoft 365 shared mailbox **caleats-support@calai.info** and separate send-only app registration/consent. The owner's new-mailbox membership/Send As and sent-item copying were saved. Silent token access and a provider-accepted test email succeeded; sending verification is recorded separately in [service mail](SERVICE_MAIL_CONNECTION.md). Automatic workers remain in local-mail mode until the hosted version is updated with the approved private connection.
- Prepared a source-qualified, checksummed migration export and mapping handoff for the owner's development team. Credentials, sessions, provider secrets, operational queues and expired private conversations are excluded. No automatic merge by matching email/name is permitted.

## Demo and preview

The isolated rich local fixture under `artifacts/business-phone-demo.sqlite` contains twenty additional cuisine restaurants, eighty dishes and eighty fictional customers, with order history, offers, messages, help and refund cases. Actual phone walkthroughs added one £4.25 menu side and its photo, a selected-recipient offer, a service message, three simulated orders and a routed support conversation. The local owner owns all twenty Demo restaurants plus Calai Kitchen.

The existing **https://eats.calai.info** preview separately received twenty clearly labelled Demo cuisine restaurants, eighty dishes, four fictional customers, twenty personalised offers and twenty-four completed simulated orders. The seed proved `local_simulator` through authenticated operational settings before mutation. The pending existing preview kitchen was not approved or edited; test history is at **Saffron Lane · Demo**. Private synthetic customer credentials remain in the ignored hosted-demo manifest. This added data without deploying the new source.

The approved Git remote is **MohammedCalai/cal-eats**. The original Calai repository and infrastructure remain read-only. New source is held locally because Railway capacity was reported exhausted; no push, deploy, cloud mobile build or live payment operation was performed in this phase. Stripe owner/director verification was explicitly deferred by the user.

## Evidence

Focused backend checks covered membership/session isolation, routed encrypted help, idempotent replies, CRM ingestion/read ordering, SSE backpressure, confirmation/ETA, the 179/180-second boundary, provider capture regressions, owner/customer email deduplication and cancellation, uncertain delivery and encrypted Microsoft sign-in. Migration exports checked foreign keys, integer money and balanced journal groups. A broad full-suite repeat was avoided.

Portal production builds passed, most recently 56 modules. Native business TypeScript checks, focused flow helpers and offline bundles passed: iOS 628 modules / Android 626, including the approved logo and both exact WAVs. Customer TypeScript checks and offline bundles passed: iOS 605 / Android 603, including message/help integration and Android configuration. These are JavaScript bundle exports, not signed device binaries or app-store releases.

Actual responsive-browser interactions verified menu decimal/allergen editing and photo upload, customer directory/status, selected-recipient offer review/creation, business service messaging, refund/help views, an explicit 45-minute delivery confirmation, customer confirmation notification, preparation/ready/out-for-delivery notifications, an email link resumed after login, dish search retaining its input/cuisine filters, and a customer help request routed to Saffron Lane with its reply appearing on the phone screen. A real-clock local order escalated at 180.255 seconds; its administrator email was saved locally once. The global warning remained active when the owner switched to another owned restaurant. Local customer email records for these events saved successfully without external delivery; foreign-key violations remained zero.

Screenshots are ignored under `artifacts/screenshots`, including 68–76 for business phone tools, 81 for the new mailbox, 83 for the order popup, 87 for the customer ETA and 88 for the routed help reply. They show actual responsive browser/PWA views, not a native-device simulator.

## Remaining external verification

The Microsoft sender check was provider-accepted; inbox confirmation remains with the owner. Automatic hosted email still requires deploying and configuring the new version. `SERVICE_MAIL_CONNECTION.md` records the exact gated state. The hosted preview still needs the approved new source/migrations, persistent mail credentials and operational smoke check once Railway capacity is available.

Signed iPhone/Android builds, physical phone/tablet/audio checks, background push credentials and real-device notification delivery remain unverified. Live Stripe payments/payouts require the separately deferred identity, Connect, webhook and end-to-end checks. Docker could not be built because Docker is unavailable. Physical printing and the future Calai/developer-led migration require their own approved validation.

Sound provenance: the exact WAVs were read from `https://www.calai.info/notification.wav` (1,672,944 bytes; SHA-256 `e3f780ecdbfe7b463908909549095039de5b1c8a0efee5898f85bb0352a6bdfc`) and `https://www.calai.info/unconfirmed-notification.wav` (105,884 bytes; SHA-256 `bee986417db63c110c484b983803c006286c63a8cd48e452f01af35f3b4f9d5f`). The saved read-only popup source informed the layout; connected GitHub accounts could not fetch the private original repository during this phase.

Final phone layout review verified the all-restaurant overdue popup at a 390px viewport: document width390px, panel width377.6px and no inner horizontal overflow. Screenshot96 records the corrected view. Screenshots90/93/94 show customer browse, platform late-order warnings and masked customer-email tracking.
