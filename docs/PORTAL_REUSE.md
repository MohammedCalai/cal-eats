# Cal-Eats portal adaptation record

## Provenance and boundary

`apps/portal` is a newly written, sanitized React portal informed by the frontend structure of private original Calai commit `ab138fd17c9ac4fc6e0b34ef5044754be643056c`. The immutable reference was inspected only. It was not installed, run, imported, or contacted.

The reusable source evidence is limited to layout and interaction patterns:

- dark responsive dashboard shell and mobile drawer: `reference/calai-platform-ab138fd/frontend/src/layout/DashboardLayout.jsx`;
- role-specific sidebar information architecture: `reference/calai-platform-ab138fd/frontend/src/components/layout/Sidebar.jsx`;
- compact authenticated header: `reference/calai-platform-ab138fd/frontend/src/components/layout/Header.jsx`;
- operational table/dialog patterns: `reference/calai-platform-ab138fd/frontend/src/pages/owner/OrderList.jsx`, `ItemManagement.jsx`, and `PrinterManagement.jsx`;
- admin stat cards and tabular operations presentation: `reference/calai-platform-ab138fd/frontend/src/pages/admin/Dashboard.jsx`, `TenantManagement.jsx`, and `ViewTenant.jsx`.

No original component source was copied verbatim. The portal is rewritten for the independent Cal-Eats API, accessibility requirements, server-derived tenant authorization, integer-pence money and simulation disclosures.

## Deliberately excluded source behavior

The adaptation has no agents, AI training, calls, test voice, Vapi, Twilio, subscriptions, EmailJS, remote connectivity probes, remote fonts, original URLs, original printer bridge download, browser-readable access-token cookies, or local-storage identity. It does not use Axios interceptors or trust a client role for authorization.

Authentication uses the existing same-origin HTTP session cookie via `fetch(..., {credentials:"include"})`. `/api/auth/me` supplies the role; restaurant membership and owner/staff permission come from server responses. Staff navigation omits owner-only finance, customer analytics, refund and settings surfaces, while the API remains the authority.

## Independent portal architecture

- Development URL: `http://127.0.0.1:4311`.
- Loopback Vite proxy: `/api` and `/assets` target the existing API at port 4310. Only an exact local portal Origin is rewritten to the API's exact local Origin. Hosted use must serve the portal and API through one reviewed same origin.
- The supplied original emblem is referenced unchanged at `/assets/calai-original.png`; CSS crops its original whitespace and adds the Cal-Eats suffix. No bitmap was redrawn.
- The customer application in `apps/web` remains unchanged and independently usable.
- API successes are read from both existing direct shapes and new `{data:...}` envelopes. New cursor lists use `{items,nextCursor}`.

## Feature mapping

Owner/staff portal surfaces cover dashboard; order progression and preparation estimates; menu creation, modifiers, photos, ordering and previewed append-only CSV import; eligible customer selection and offer analytics; scoped printer creation/pairing/editing/manual reprints; finance, payout, development-policy, test-provider and simulated-mandate reporting/actions; restaurant refund replies; restaurant profile/opening hours/readiness/account/team settings. Staff receive operational order/menu/printer access only as allowed by server permissions.

Admin surfaces cover marketplace overview; restaurant approval, audited suspension, readiness, menu inspection and sanitized device/job diagnostics; order detail; aggregate finance, per-restaurant summaries, exceptions, contracts, cash statements, explicit local worker cycles and CSV reports; refund-case decisions; support status; account-deletion review; a read-only user directory; sanitized operational settings; integrations, jobs and audit history. Finance loading and failures are shown as `Loading…` or `Unavailable` and never silently converted to `£0`. All money and provider/device states are labelled as local simulator or test mode unless the API says otherwise. Browser/device job state never claims that paper physically printed, and diagnostics exclude tokens, hashes, receipts and claim credentials.

The user directory is intentionally read-only: there is no generic account-suspension API or schema state, so the portal does not invent one. Marketplace enforcement uses the existing audited restaurant suspension route. Operational settings are also read-only and sanitized; runtime secrets and mutable host configuration remain outside the portal. These boundaries are frozen in `docs/MARKETPLACE_API.md`.

The header polls the existing in-app notification inbox while authenticated. Restaurant new-order audio is off by default, requires a user gesture, reuses one Web Audio context and deduplicates notification IDs after an initial no-sound baseline. This is not browser push or background delivery.

The portal manifest supports installation on a capable tablet browser when served over HTTPS (loopback is accepted for development). Its service worker caches only a static offline explanation. Navigations are network-first, and API, media, supplied brand assets and authenticated application content are never cached. Installed-device verification remains pending.

The new marketplace routes are taken from `docs/MARKETPLACE_API.md`. Existing restaurant, menu, order, offers, account, staff and operations routes remain governed by `docs/API.md`, `PRODUCT_OPERATIONS_API.md`, `OFFERS_API.md`, and `FINAL_POLISH_API.md`.

## Dependency decision

The package pins only React, React DOM, React Router, Vite and the Vite React plugin. Fetch, CSS, SVG/text controls and platform APIs cover the rest. This avoids importing the original portal's provider and authentication dependencies.

## Remaining activation boundary

This is a local portal, not a deployed service. Real providers, physical printers, hosted origins and production security claims require separate authorization and evidence. The original deployment files, credentials, device settings and runtime connections remain excluded.

## Current serving and governance update

The built portal is served same-origin at `http://127.0.0.1:4310/business/`. Development uses `http://127.0.0.1:4311/business/`; only that exact loopback Origin is rewritten by the proxy. Hosted use still requires a reviewed same-origin reverse proxy.

The admin portal now includes audited account enable/disable, restaurant owner/staff membership controls and configurable refund-response deadlines. Governance v16 revokes browser/native sessions, prevents self/last-admin lockout and final-owner removal, and emits durable in-app reminders/escalations without deciding cases. Provider-event v17 states remain test/simulated and must not be presented as live money movement.
