# Business phone and tablet UI — 28 October 2026

The browser business platform and installable Cal-Eats Admin web app use the same restaurant membership, API and data as the dedicated native business app source. Platform administrators remain a restricted role within the business platform. The visual language follows the signed-in Calai reference and its pinned source: a `#0E0E10` charcoal canvas, lighter cards, quiet borders, clear white headings and royal-blue actions, with the approved Cal-Eats logo.

## Working screens

- Menu: searchable dishes, category and availability filters, add/edit dialogs, naturally editable pound prices and allergen/tag text, a dish photo within add/edit, quick availability switches, and optional modifier groups. CSV import has a bounded preview and a separate confirmation. Secondary photo/reorder controls sit below each dish.
- Inbox: a server-paged union of order messages and persistent own-customer conversations. Order messages keep their existing support window; opening them uses the order-message API. Customer threads have reply statuses, older-message paging, read cursors and idempotent sends.
- Customers: server search, segment and workflow filters, 25-row pages, exact directory summary, profile histories bounded by the backend, private team notes, VIP/follow-up status and direct message/offer actions. The entire customer database is never rendered into the page or recipient picker.
- Offers: customer-group targeting or a searchable paged recipient picker; percentage, money-off or free-item offers; dates, budget and eligibility controls; a customer notification preview before the explicit creation action. Only consenting, eligible customers receive the backend's recipient-specific notification.
- Refund cases: readable phone cards with reference, status, amount and a clear review action. Customer-profile and notification links can open a case directly. Existing remedy and refund execution controls remain behind their role checks.
- Support: routed customer requests and the restaurant's own platform support, reply threads, read state, open/resolved controls and older-message paging. A request has a visible reference and an in-app destination.

The phone bottom bar prioritises Menu, Inbox, Customers, Offers and Cases. The full navigation, restaurant selector, Support and account actions remain in the drawer. Staff navigation omits owner-only customer, offer, case and finance tools. Dialogs trap keyboard focus and restore focus on close; data tables become labelled cards on small screens.

## Verification and limits

Six focused model/navigation checks and the production portal build passed. The root task performs the seeded browser walkthrough and screenshots. A successful web build is not a signed native iPhone/Android run, app-store delivery, OS push-notification verification or a hosted deployment.

Menu photo upload is a separate server operation after the item text is saved. If that upload fails, the interface says that the item was saved and offers a photo retry; it does not encourage creating a duplicate item. Authenticated data remains excluded from the offline service-worker shell. Persistent customer message bodies follow the backend's 30-day retention policy.

## Customer browser integration

The customer app now mounts the paged Messages inbox and persistent conversation threads. Customer conversation, order message and support notifications open their respective records. Opening a later dialog or switching accounts invalidates an earlier asynchronous mount, preventing stale controllers from replacing or closing the newer view.

Account help offers a select of the customer's 40 most recent orders or an app/account question. Routing is shown before sending. The form preserves drafts on failure, reuses its per-payload retry key and opens the resulting referenced help request on success. Existing requests have a visible View request & reply action.

Discovery loads the full restaurant result for the selected fulfilment/postcode, then filters search and cuisine on the client. A 220 ms search debounce updates the result section while leaving the search input and its caret untouched. All cuisine chips remain available. Available personal offers have badges; configured cover images replace the former fixed image, with fallback artwork labelled illustrative. The public service-worker asset set is version 11 and includes the new public contact/theme modules. API and authenticated content stay outside that cache.

Customer integration JavaScript syntax checks passed; the final business production build passed after the colour and notification updates. Visual and end-to-end verification are recorded by the root task rather than claimed by these source checks.

## Global new-order confirmation

An owner or authorised restaurant staff member now has one persistent queue across all business routes and all of their current restaurant memberships. The authenticated pending API is the membership authority; the currently selected restaurant does not hide other own-business orders. It restores payable, placed orders from the authoritative pending-confirmation endpoint, refreshes on live events/focus and reconciles every 15 seconds. The backend's total is retained when more than 100 orders are pending; the oldest 100 are shown and subsequent orders enter the visible queue as these are handled. User changes invalidate prior requests and stop the old sound. Each queue entry names its restaurant; reviewing one switches the business context to that restaurant. ETA defaults come from that order’s server DTO or its matching restaurant, never an unrelated selected restaurant.

The popup follows Calai's dark, rounded panel and blue/indigo notification header. The backend's merchant-visible three-minute deadline changes an overdue popup to amber/orange. It uses the exact read-only Calai WAV assets supplied by the root task: `/business/notification.wav` for a new queue and `/business/unconfirmed-notification.wav` when a pending order is overdue. The user must Enable & test sound before the browser is armed. Browser playback refusal leaves a visible resume instruction. The exact file source is verified separately from physical speaker output.

The WAV loops while the restaurant has pending orders. Minimising the popup or marking a bell notification read does not confirm an order or stop the queue. Mute and a one-minute snooze are explicit sound controls. A verified server confirmation/rejection removes that item immediately; further reconciliation catches decisions made on another device. Failed or ambiguous capture keeps the order pending. Lighter message sounds are a separate preference and never substitute for the new-order WAV.

Confirm requires an explicit ETA, labelled expected delivery arrival or ready-for-collection. The status and ETA are sent atomically to the backend before any confirmation is claimed. The Orders screen opens this same confirmation panel. Later preparation, readiness, delivery and completion actions keep the detail panel open and refresh its authoritative order state, with labels such as Start preparing, Mark ready, Out for delivery and Mark delivered/collected. Delivery advances from ready to out-for-delivery, then completed; collection can complete at ready. Overdue warnings are displayed; the UI does not place calls, send external messages or make automatic order decisions.

Four focused tests passed for restaurant isolation/unverified checkout exclusion, exact WAV selection using the merchant deadline, valid ETA payloads and delivery/collection transitions. The portal production build passed. Root performs the pending-order/browser/media walkthrough; no physical audio output or operating-system background notification result is implied by the source checks.

## Native business TestFlight preparation

The business dashboard now offers Today, Yesterday, This week and Last week using Europe/London calendar dates and Monday-start weeks. Period sales, refunds, commission, net earnings, cash/card totals, top items and paged order earnings are distinct from the current all-time balance. Operational actions show unconfirmed/overdue orders, active orders, unread messages and open refund cases. Cash paid directly to a restaurant and transfers to a Stripe balance are never presented as bank payouts. Staff receive operational counts and order rows without financial fields.

The same dashboard is available natively in Cal-Eats Admin, opening on sign-in and from the header Home control. Order alerts still open the Orders screen. Owners can review their fixed weekly statement recipient/schedule and pause or enable it in both the business portal and native dashboard; real email readiness remains explicit. Native TypeScript and the portal production build passed; signed TestFlight/device verification remains blocked as described below.

The portal and Admin app remember restaurant selection per authenticated user and validate the saved ID against freshly fetched memberships before restoring it. A missing or inaccessible selection falls back to an approved restaurant, then the first available membership, rather than silently returning a multi-restaurant owner to an empty pending preview kitchen. Stored preferences never grant access.

The owner requested two TestFlight apps: customer Cal-Eats and business Cal-Eats Admin. The Admin source in `apps/admin-mobile` is now linked to its own `@yankee1707/cal-eats-admin` Expo project, `6282b87e-36ae-43bb-80b7-12d69108a411`, preserving bundle identifier `info.calai.caleatsadmin`. It uses the approved square emblem, matching charcoal/blue colours, remote build numbering, and a store-test profile targeting real iOS devices at the separate Cal-Eats preview API. Its configuration guard rejects another Expo project and public production builds. Private data and credentials are excluded from build archives.

Admin TypeScript, seven static packaging checks and Expo config resolution passed. These do not establish native compilation or physical-device behaviour. Apple currently disables membership benefits during the account's individual-to-organization migration, and signing-resource access is rejected. No Admin iOS build or TestFlight upload has started; separate signing/provisioning and an App Store Connect app record are still required after Apple restores access. Foreground order audio remains distinct from background push, which is not configured.
