# Final local product improvements

Authorized on 2026-10-24 after reviewing the local preview and menu-management gaps. This extends the browser preview; it does not authorize deployment, live providers, native store builds or automatic loyalty rewards.

## Included

- Customer control of new promotional offers, default off. Order updates remain enabled; existing offer grants are retained.
- Safe active-session details and revocation of individual or other sessions.
- Up to ten saved delivery addresses per customer, available at checkout and in account export.
- A restaurant setup checklist covering contact/address, hours, a usable menu and fulfillment settings, with enforcement on new approvals. Commercial contract acceptance remains a separate unresolved business matter.
- Owner uploads/removal of restaurant and dish photos, bounded JPEG/PNG only, isolated by restaurant. Photos reside in SQLite so the existing private backup includes them.
- Persisted menu ordering with accessible move controls.
- CSV template, local import preview and a deliberate confirmation step. The server validates the full bounded batch atomically, appends items and protects retries with an idempotency key. Existing items are never overwritten by import.
- Basket recovery using only bounded item IDs, quantities and choice IDs, with expiry and current-menu validation. No address, contact, payment, session or reset-token data enters browser draft storage.
- Optional merchant order sounds while the dashboard is open, mute controls, deduplication and connection feedback. No background push claim.

## Delivery rules

Keep the original Calai logo and mobile navigation. Preserve server-owned order prices, tenant boundaries, offer rules, immutable financial snapshots and explicitly simulated payments. Use focused meaningful checks and a small browser walkthrough; do not repeat broad tests without a concrete regression reason. Stop at 5% account usage remaining, retaining a precise handover if work remains.

Backend and schema ownership: foundation implementation agent. Browser ownership: web implementation agent. Lead: contract and security review, integration, evidence, handover and local Git checkpoint.
