# Marketing and customer offers — 30 October 2026

Customer order details now have a separate Back/Order details header with a 20px gap. The former card-wide opening highlight is removed, and the Orders navigation icon is a clipboard. Customer Offers uses compact rows with personalised grants first, exact London end times, and separate upcoming, reserved and past groups. Only authoritative directly selected audiences receive the personalised label; general and segmented campaigns remain restaurant offers. Public customer responses omit campaign budgets. Stale expired offers stop being actionable, while the server remains authoritative at checkout.

The business Offers workspace is labelled Marketing. Both the portal and native Admin source provide Create campaign/Campaigns views and eight restaurant-funded tools:

- Buy one, get one free, on matching selected item quantities; extras remain paid.
- Percentage off selected items or the food order.
- A fixed amount off the food order.
- A free item with a paid purchase.
- A qualifying purchase item with a separate free item.
- A delivery-fee waiver, without changing the owner's configured delivery fees.
- Happy hour as one explicit percentage-discount time window.

Creation guides the owner through details/items, audience, dates/budgets and review. Specific customer selections and promotion-consent checks are preserved. Weekly and lifetime caps are optional, with a redemption limit. Weekly caps reset Monday at 00:00 Europe/London and account for reserved/redeemed discount value, gift retail value and waived delivery charges. Campaign activity uses actual recipients, opens, redemptions and committed value. No paid placement, recurring happy-hour schedule or automated discount optimisation is claimed.

Migration 32 adds campaign metadata and weekly reservation buckets. It also repairs previously uncounted reserved/redeemed free-item commitments using the saved gift value; it does not alter historical order finances. New mechanics retain canonical base offer types for storage compatibility, but checkout requires the new server logic. Do not roll back to a pre-mechanics server after new campaign types have been published without first addressing those campaigns.

Native campaign dates use SDK-pinned native date/time pickers, with readable device-time selection and explicit UK-time review. Both native apps require new builds and physical-device verification. The pending Apple membership remains the previously observed TestFlight blocker.

Verification completed:

- New marketing engine checks passed for all eight mechanics, owner/tenant boundaries, pricing/commission, weekly caps/races/release/reset, migration repair and retry stability. The existing six loyalty and three offer checks passed; the customer metadata/privacy check also passed after its final change.
- Seven web offer/promotion helper checks passed, including classification, expiry boundaries, BST/GMT, escaping and correct benefit labels. Both native TypeScript checks passed. Portal production build passed; React/React DOM resolution is deduplicated to avoid a mixed-workspace startup failure caught in browser review.
- Browser review covered the corrected order controls, customer personalised rows/end dates, and a full local campaign creation through recipient search, schedule, £20 weekly/£50 total caps, preview and confirmation.
- The isolated fixture's selected customer received the BOGO grant. A two-bowl quote reconciled £25.50 gross food, £12.75 discount and £12.75 total. No provider charge or live campaign was created; local email/background workers were disabled.

Original-workspace README/audit edits and the original Calai system were not changed.
