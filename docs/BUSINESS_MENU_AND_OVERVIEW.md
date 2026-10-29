# Business menu and overview

Restaurant owners use the same account in the tablet/browser business platform and Cal-Eats Admin phone app. Staff retain their existing limited access; menu changes, uploads and bulk imports are still checked server-side for restaurant-owner membership.

Menus have Overview, Categories and Items views. The editor separates About, Pricing, Customisations and Nutrition. Owners can upload a photo while creating or editing a dish, select its product type, write a description of up to 4,000 characters, and optionally supply energy per portion in kcal/kJ. Existing records preserve unknown energy values as null. Customer item details display supplied energy information with a restaurant-supplied label.

Add several items creates up to 50 dishes through the existing atomic, idempotent import endpoint; CSV upload remains available in the browser. After an uncertain import, retry uses the same key and payload. Photos and detailed choices can then be added to each item.

The meal-deal template adds required starter, rice, vegetable and curry groups with editable included choices and optional extra prices. It excludes other meal deals from its suggestions. Customer checkout continues to validate choice counts, availability, option prices and multi-dish baskets on the server.

The phone dashboard uses prominent sales and order cards, Today/Yesterday/This week/Last week, comparisons with the equivalent dates a week earlier, earnings, average order value and real customer-offer metrics. Existing order-by-order earnings, payouts, bank details, refund cases and weekly statements remain available. Home/Marketing/Orders/Menu/More navigation keeps the daily tools close at hand.

The tablet/browser and phone dashboard also show a Calai-style live-order ring. A blue energy background appears only while at least one order is live. Live includes merchant-visible payable placed orders, accepted, preparing and ready orders, across all dates. Delivery handover (out_for_delivery), collection completion and rejected orders leave the live count. The broader active-order metric still includes deliveries on the road. Counts are scoped to the signed-in restaurant and refresh every five seconds while visible, with browser events providing earlier updates. Reduced-motion preferences stop the decorative animation; refresh failures do not show a false zero or continue a stale live glow.

The tablet/browser Overview is operations-only: live orders, order counts, confirmations, messages, refund cases, popular items and restaurant tools. It requests `view=operations`, which omits financial summaries, sales/discount comparisons and per-order amounts from that response. Owner finance remains in the separate Earnings & payouts section and the Cal-Eats Admin phone dashboard; the tablet Overview does not show sales, earnings, payout balances or commissions.

Tablet styling follows the original Calai reference (`ab138fd`, OwnerLiveActivity, StatCard and DashboardLayout): #141416 content, #18181A cards, #0E0E10 sidebar, #2563EB/#0F42FF accents, Inter/sans-serif, 16px panel corners, 144px live ring, matching padding, borders and decorative waves. The menu opens as a drawer below 1536px; larger displays can collapse it to an 88px icon rail and expand it again. Its preference is saved locally. All Cal-Eats permissions, restaurant switching, alert sounds and notification access remain intact. The original Calai code and deployment are read-only references.

Item pricing remains one price per dish across the restaurant's enabled fulfilment types; delivery fees remain owner-controlled. Weight pricing, tax calculations and advertising products are not presented as active features. This release does not change payment capture or payout policy.

Migration 30 adds only product-type and optional energy columns. Private hosted and local backups were saved before deployment. Focused checks cover atomic batch import replay, meal metadata and required choices, multi-item quotes, owner/customer access, dashboard ranges and financial isolation, native type checks, browser phone editing/upload, and iPhone/Android bundle compilation.
