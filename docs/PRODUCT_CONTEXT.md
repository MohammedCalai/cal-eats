# Retrieved product context (source may be truncated)

**Current user correction, 27 October 2026:** deliver exactly two products: one Cal-Eats customer app, and one Cal-Eats business platform for restaurant tablets. Cal-Eats administrator controls are a restricted role inside that same business platform, using its shared sign-in. The older three-interface wording below is historical context, not a request for a third product or separate administrator app. Menu items, prices, photos and availability are managed on the business tablet.

Source: earlier chat "Delivery App Startup Plan", retrieved 2026-10-24 when the user asked to preserve the Calai theme and complete the local build. This is background design context; current user constraints override external-service suggestions. No external action is authorized by this document.

**Paste this into GPT-6 Sol.** It tells it to build the actual foundation—not just produce another plan—and prepare the external services without touching your existing Calai products.

Expo supports local development without an EAS cloud build, and Railway supports deploying a local project through its CLI without GitHub. So the exhausted allowances do not need to stop the backend, dashboards or app-code development. Native iOS compilation still needs the appropriate Apple development environment or a later cloud build. :chatgpt-content-reference{index="0"}

Food-order payments should use **Apple Pay/card payments, not Apple’s in-app purchase system**. That distinction is included below. :chatgpt-content-reference{index="1"}

```text
PROJECT: CALAI EATS
MISSION: BUILD THE FOUNDATION NOW; PREPARE FOR APP STORE LAUNCH LATER

Act as my lead full-stack engineer and technical delivery lead.

Start implementing Calai Eats in the development environment available
to you. Create real project files, database migrations, working screens,
API endpoints, tests and setup documentation.

Do not stop at an architecture proposal, a feature list or mock-up.
Prioritise a working end-to-end foundation over lots of unfinished screens.

==================================================
1. CURRENT CONSTRAINTS
==================================================

My GitHub and Expo allowances are currently exhausted.

Until I explicitly say otherwise:
- Do not push to GitHub or run GitHub Actions/Codespaces.
- Do not trigger Expo EAS cloud builds, submissions or updates.
- Do not upgrade subscriptions or purchase additional credits.
- Do not assume these limits prevent local coding and testing.

Use a local project directory and local Git where available.
Prepare the project so it can be uploaded and deployed later.

First inspect the available workspace, runtime, tools and authorised
connections. Do not claim access to a service without checking.

Existing Calai accounts may be reusable, but Calai Eats must have
separate projects, credentials and data.

Continue independent work when an external service is unavailable.
Record the exact blocker and next action instead of repeatedly asking
me to reconnect everything.

Do not claim a native iPhone build, integration, deployment or test
succeeded unless you actually ran it and verified the result.

==================================================
2. PRODUCT AND BUSINESS RULES
==================================================

Product name: Calai Eats.
Business: Calai Ltd.
Initial market: Luton, United Kingdom.
Currency: GBP.
Language: British English.
Restaurant timezone: Europe/London.

Calai Eats is a multi-restaurant food-ordering marketplace.

There are three interfaces:
1. Customer iPhone app.
2. Restaurant web portal.
3. Calai Eats platform-admin web portal.

They share ONE dedicated Calai Eats backend.

Keep this project separate from:
- Calai phone ordering.
- Calai Vapi.
- Calai Direct.
- Bondhu and its sibling apps.
- All existing production databases and services.

DELIVERY:
Restaurants always use their own drivers.
Calai will never recruit or provide a delivery fleet.

Do not build a courier marketplace, driver recruitment system,
driver payroll or fleet-dispatch service.

Restaurants configure their delivery areas, delivery charges,
minimum order values and estimated delivery times.
Also support customer collection.

COMMISSION:
- Fixed 7% restaurant commission.
- A 24-month restaurant contract.
- The 7% rate is locked throughout those 24 months.
- No setup fee.
- No monthly subscription.
- No additional platform administration fee.
- No additional fixed per-order fee.

Do not introduce other charges to make the model profitable.
Do not charge restaurants payment-processing fees on top of the
7% without a new, explicit business decision from me.

For the MVP, keep the customer platform-service fee at zero.
Restaurant delivery charges must be displayed separately and clearly.
Do not advertise delivery as free unless the restaurant sets it to zero.

Do not fund £5-off or similar promotions automatically.
Platform-funded promotions must remain disabled.
Any future merchant-funded promotion requires merchant agreement
and explicit accounting for who funds the discount.

COMMERCIAL DETAILS STILL REQUIRING APPROVAL:
- Whether the 7% includes applicable VAT.
- The exact commission base, including treatment of delivery charges
  and discounts.
- Contract commencement, early termination and renewal terms.
- Payout schedule.
- Responsibility for exceptional refunds, disputes and losses.

Do not silently invent these policies or add VAT on top by default.
Create a pending-decisions register and a live-payment activation gate.

Use clearly labelled demo assumptions for development so coding
can continue. Do not treat demo assumptions as approved terms.

==================================================
3. TECHNICAL FOUNDATION
==================================================

Use this default stack unless inspecting the environment reveals
a concrete reason to change it:

- TypeScript throughout.
- React Native + Expo for the customer app.
- Next.js for the restaurant and admin web portals.
- NestJS for the backend API.
- PostgreSQL with Prisma for the database.
- pnpm workspaces for the monorepo.
- Docker Compose for local dependencies where supported.
- Stripe Connect for marketplace payments.
- Railway-compatible deployment configuration.

Use a modular monolith, not unnecessary microservices.

Choose maintained, mutually compatible stable versions.
Check official documentation, pin dependencies and commit a lockfile.
Do not invent SDK features or install conflicting package versions.

Suggested structure:

calai-eats/
  apps/
    mobile/
    restaurant/
    admin/
    api/
  packages/
    database/
    contracts/
    design-tokens/
    config/
  infra/
  docs/
  scripts/

Share API schemas, validation, types and design tokens.
Do not force web-only components into the native app.

Implement background work through a durable job/outbox mechanism.
Do not add Redis or other paid infrastructure unless justified.
Jobs must survive restarts and support retries.

Include:
- Environment-variable validation.
- .env.example with placeholders only.
- Health and readiness endpoints.
- Structured logs with sensitive fields redacted.
- Database migration and seed scripts.
- API documentation.
- Local lint, type-check and test commands.
- Staging and production configuration templates.
- A migration and rollback strategy.

==================================================
4. BRAND AND INTERFACE
==================================================

Preserve the existing Calai identity:

- Original blue Calai speech/phone-style emblem with three dots.
- Deep navy background where appropriate.
- White Calai lettering.
- Blue Eats lettering.
- “Calai Eats” on one horizontal line.
- Only a slight italic slant on “Eats”.
- Normal, immediately readable letter E.

Do not use green, redesign the emblem, add speed streaks,
or invent a different logo.

Use the supplied logo asset when available.
If it is missing from your workspace, use a clearly labelled
temporary wordmark and record the missing asset. Do not guess it.

The customer app should feel like a clear, trustworthy food-ordering
service, not a generic AI dashboard.

Use appetising menu imagery, readable prices, clear buttons,
accessible contrast and uncluttered checkout.

Light content surfaces are acceptable; the entire app need not be dark.
Restaurant and admin portals should prioritise practical usability.

Include loading, empty, error, offline and unavailable states.
Design for small iPhones, larger text settings and keyboard navigation
where relevant.

==================================================
5. BUILD THE FIRST WORKING JOURNEY
==================================================

Make this the first major milestone:

1. A fictional restaurant submits its details.
2. Platform admin approves it for the local demo.
3. The restaurant adds a menu and availability.
4. A customer enters a postcode and sees eligible restaurants.
5. The customer adds menu items and modifiers.
6. The backend calculates and validates the order.
7. The customer places a clearly marked test or cash order.
8. The restaurant receives it and accepts or rejects it.
9. The restaurant updates preparation and fulfilment status.
10. The customer sees the status changes.
11. Admin sees the order, commission calculation and audit history.
12. The restaurant opens a printable receipt.

Use real persisted backend data for this journey.

Mock external providers when necessary, but clearly distinguish:
- Implemented local functionality.
- Mock-provider demonstrations.
- Verified provider-sandbox integrations.
- Untested or blocked integrations.

Do not present a simulated payment as a successful Stripe integration.

==================================================
6. CUSTOMER APP
==================================================

Implement the foundation for:

- Welcome and postcode-first restaurant discovery.
- Optional location permission with manual entry always available.
- Restaurant listing and basic cuisine/search filters.
- Restaurant details, opening hours, delivery fee and minimum order.
- Menu categories, items, variants and required/optional modifiers.
- Merchant-supplied dietary and allergen information.
- Basket with one restaurant per order.
- Delivery or collection.
- Customer contact details and delivery instructions.
- Full price breakdown before payment.
- Apple Pay and card integration scaffolding.
- Cash ordering only where enabled by the restaurant.
- Order confirmation and status timeline.
- Order history and reorder with fresh price/availability checks.
- Account settings, support and account-deletion request flow.

Use a secure, established authentication approach.
Start with email-based authentication; avoid adding social-login
complexity unnecessarily.

Do not show fake driver locations or live tracking.
Order progress comes from restaurant status updates.
Present delivery times as estimates, not guaranteed tracking.

Do not require a paid address/maps API to run the local demo.
Use a provider interface and labelled fixture data until configured.

==================================================
7. RESTAURANT PORTAL
==================================================

Implement:

- Registration and application status.
- Restaurant profile and business contact details.
- Branch/location structure.
- Owner and staff accounts with restricted permissions.
- Menu, category, modifier and availability management.
- Opening hours, holiday closures and overnight opening support.
- Delivery areas, fees, minimums and collection settings.
- Busy mode and temporarily pausing new orders.
- New-order notifications and an accept/reject workflow.
- Preparation-time estimates and fulfilment updates.
- Order history and receipt access.
- Commission statements and payment/payout status.
- Cash-order commission balance.
- Contract version, acceptance record and locked commission rate.

A restaurant must not become publicly orderable simply because
it registered. Require admin approval and the relevant readiness checks.

For online payments, include Stripe onboarding/capability checks.
Do not collect raw bank details or identity documents in Calai Eats
when Stripe-hosted onboarding can handle them.

Use real-time updates with a polling recovery path.
Do not assume browser notifications or sound always work.
Provide a notification test and clear connection/availability status.

Unaccepted orders must expire safely after a configurable period.
Avoid leaving customers indefinitely waiting for a closed,
disconnected or unresponsive restaurant.

==================================================
8. PLATFORM ADMIN
==================================================

Build a separate secure admin portal with:

- Restaurant applications, approvals and suspensions.
- Restaurant, branch and staff visibility.
- Order search and detailed order timelines.
- Payment, refund, dispute and payout status.
- Commission reporting and cash receivables.
- Contract and policy-version records.
- Audit logs.
- Support case records.
- Integration health and failed background jobs.
- Platform settings and feature flags.
- Exportable operational and financial reports.

Enforce permissions in the backend, not just by hiding buttons.

A global pricing-setting change must not alter a restaurant’s
already-agreed 24-month rate.

Store the agreed rate and relevant policy version on the contract.
Snapshot the applicable commercial terms on each order.

Require strong admin authentication and MFA before production.
Use a secure bootstrap process, not a permanent hard-coded
admin email/password in the repository.

==================================================
9. PAYMENTS, COMMISSION AND ACCOUNTING
==================================================

Build in test/sandbox mode only.

Use Stripe Connect and Stripe’s supported payment UI components.
Never store raw card information.

Food purchases use Apple Pay/cards, not Apple in-app purchases.

Before finalising the integration:
- Compare the relevant Connect charge approaches.
- Document the chosen flow and who bears processing fees.
- Document seller/merchant-of-record responsibilities.
- Document refunds, disputes, negative balances and payout behaviour.
- Verify current UK pricing and supported capabilities.

Do not assume that choosing “Stripe Connect” alone resolves
every commercial or regulatory question.

Design the normal-order flow so Calai’s provider costs are accounted
for within its commission rather than silently deducted from the
restaurant in addition to the agreed 7%.

Keep these concepts separate:
- Customer payment.
- Calai commission.
- Restaurant payable.
- Stripe balance transfer.
- Bank payout.
- Refund.
- Cash receivable.

PAYMENT TIMING:
Prefer authorisation at checkout and capture on restaurant acceptance
where supported by the selected payment methods and integration.
Handle expiry, rejection, capture failure and concurrent events.

Do not treat an authorisation as captured money.
Do not tell a restaurant to prepare a card-paid order until payment
has reached the required confirmed state.

If a different payment-timing approach is chosen, document it and
implement its compensating refund/cancellation behaviour.

RELIABILITY:
- Calculate prices and fees server-side.
- Use integer pence, not floating-point money.
- Represent 7% as 700 basis points.
- Specify and test a consistent rounding rule.
- Use idempotency keys for payment and order creation.
- Verify webhook signatures.
- Deduplicate webhook events.
- Handle out-of-order events and retries.
- Never trust the mobile client’s “payment successful” message.
- Reconcile provider transactions against internal records.

REFUNDS:
Support full and partial refunds.
Handle the associated transfer reversals and commission adjustments.
Do not assume refunding the customer automatically corrects all
restaurant and platform balances.
Prevent duplicate refunds and over-refunding.

CASH:
The restaurant receives the customer’s cash.
Calai must not record this as money received by the platform.

Record the commission receivable under an explicit policy, with
statements and a settlement workflow.
Prevent rejected/cancelled orders from creating incorrect balances.

Prepare a collection-provider interface if useful, but do not
automatically debit restaurants or create Direct Debit mandates.
Collection terms and authorisation require approval.

ECONOMICS:
Create an internal configurable margin calculator covering:
- Commission revenue.
- Card-processing costs.
- Applicable Connect account and payout costs.
- Discounts and funding source.
- Refund/dispute costs.
- VAT treatment when approved.
- Other directly attributable costs.

Do not label 7% gross commission as net profit.
Mark estimates as estimates and reconcile actual provider costs later.

==================================================
10. DATABASE AND ORDER INTEGRITY
==================================================

Model the necessary entities for:

Users; restaurants; branches; memberships; applications;
menus; categories; items; modifiers; opening hours; delivery zones;
addresses; baskets; orders; order items; order events;
payments; refunds; transfers; payouts; financial ledger entries;
cash receivables; contracts; notification jobs; print jobs;
webhook events; support records; audit logs.

Avoid speculative tables for features outside the MVP.

Separate order fulfilment status from payment status.

Preserve historical snapshots of item names, prices, modifiers,
delivery charges, discounts and commission terms.
A menu edit must not rewrite an old order.

Revalidate opening status, availability, delivery eligibility,
minimum order and basket pricing at checkout.

Use database constraints and transactions to prevent duplicate
orders, invalid state transitions and inconsistent balances.

Store timestamps consistently and handle Europe/London daylight
saving changes correctly.

==================================================
11. PRINTING AND NOTIFICATIONS
==================================================

Provide an 80mm receipt layout including:

Order reference; time; payment method and status; items;
modifiers; notes; relevant allergy information; totals;
collection/delivery details; customer information needed for fulfilment.

Implement browser printing for the first working foundation.
Prepare a printer-adapter interface and print-job records.

Do not claim automatic physical printing without testing compatible
hardware and the required bridge or cloud-print integration.
Do not modify the live Calai printer bridge.

Track print attempts and failures.
Mark reprints clearly.
Account for retries without promising impossible exactly-once
physical printing.

Prepare customer push notifications using an appropriate Expo/APNs
integration. Keep this mockable until credentials and native testing
are available.

Do not make Firebase a mandatory iOS dependency without a clear need.

Use a replaceable transactional-email adapter and a local mail sink.
Do not send real customer emails or SMS during development.

==================================================
12. SECURITY, PRIVACY AND FOOD INFORMATION
==================================================

Implement tenant isolation: restaurant staff can access only the
restaurants/branches they are authorised to manage.

Do not trust a restaurant ID supplied by a client as proof of access.
Test cross-restaurant access attempts explicitly.

Include:
- Secure session/token handling.
- Authentication throttling.
- Appropriate CSRF/CORS protection.
- Input and upload validation.
- Restricted file access.
- Secret redaction.
- Auditable privileged operations.
- Backups and a restore-test plan.
- Data export and deletion-request workflows.
- Documented retention categories.

Do not place secrets in source code, public mobile configuration,
screenshots, logs, downloadable archives or documentation.

Create draft privacy, customer and merchant policy documents,
clearly marked as requiring business/legal review.
Do not invent company registration details or claim compliance
merely because documents exist.

Provide merchant-maintained allergen information before ordering
and support communicating it with the delivered food/receipt.
Do not invent allergen data or treat a generic disclaimer as sufficient.
Allergy notes must be prominent to the restaurant.

Track food-business verification and food-hygiene information,
including its source and check date.
Do not present unverified ratings as official or current.

Use fictional demo restaurants and clearly marked sample information.
Do not scrape competitors’ menus, customer data or copyrighted assets.

Keep alcohol and other age-restricted pro
