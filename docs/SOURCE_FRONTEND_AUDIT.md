# Original Calai frontend source audit

## Scope and provenance

This is a read-only frontend audit of `reference/calai-platform-ab138fd` at private source commit `ab138fd17c9ac4fc6e0b34ef5044754be643056c`. The reference was inspected as text only. It was not installed, built, run, imported into the local app, or used to contact any original or third-party service. No secret values are reproduced here.

The missing dashboard screenshot is not needed to establish the source layout: the router, shared layout, sidebar, pages, components and hooks define it directly. Backend behavior, provider accounts and printer hardware were not tested.

## Locked frontend stack

`frontend/package.json` declares a Vite/React single-page application. Exact installed versions below come from `frontend/package-lock.json`, not the semver ranges in `package.json`.

| Package | Lockfile version | Role in source |
| --- | ---: | --- |
| React / React DOM | 19.2.6 | application UI |
| React Router DOM | 7.15.0 | public, auth, owner and admin routes |
| Vite | 7.3.2 | build and development server |
| Tailwind CSS / Vite plugin | 4.2.4 | styling |
| TanStack Query | 5.100.9 | remote data and polling |
| TanStack Table | 8.21.3 | data tables |
| Axios | 1.16.0 | HTTP client |
| Socket.IO client | 4.8.3 | incoming-order events |
| Vapi Web SDK | 2.5.2 | browser test-call experience |
| js-cookie | 3.0.7 | browser-readable bearer token and role storage |
| React Hook Form | 7.75.0 | forms |
| React Hot Toast | 2.6.0 | feedback |
| Recharts | 3.8.1 | dashboards |
| jsPDF | 4.2.1 | document generation/export |
| Framer Motion | 12.38.0 | animation |

Evidence: `frontend/package.json`; `frontend/package-lock.json` entries under `packages.node_modules/*`.

## Actual portal layout and navigation

The authenticated portal is a full-height dark dashboard shell. `frontend/src/layout/DashboardLayout.jsx` renders `Sidebar`, `Header`, `Breadcrumb`, a main content outlet, `OfflineBanner`, and `LiveOrderPopup`. Its main surfaces use near-black/navy backgrounds, white text and a blue active accent. `frontend/src/components/layout/Sidebar.jsx` implements a fixed/collapsible desktop sidebar and a mobile drawer, using the browser cookie role to select one of two navigation sets.

Owner navigation is Dashboard, Agents, Test Call Window, Call Summary, Order list, Item Management, Printer Management and Settings. Admin navigation is Dashboard, AI Training, Tenant Management, Telephony, Subscriptions & Billing and Settings. This is operational portal information architecture; it is not the customer storefront layout in the current local prototype.

Evidence:

- `frontend/src/layout/DashboardLayout.jsx`
- `frontend/src/components/layout/Sidebar.jsx`
- `frontend/src/components/layout/Header.jsx`
- `frontend/src/components/OfflineBanner.jsx`
- `frontend/src/components/LiveOrderPopup.jsx`

## Route inventory

`frontend/src/router/router.jsx` defines these route groups:

- Auth: `/auth/login`, `/auth/signup`, `/auth/signup/confirm`, `/auth/forgot/password`, `/auth/verify/otp`, `/auth/new/password`, `/auth/success`.
- Admin: `/admin/dashboard`, `/admin/ai-training`, `/admin/tenant-management`, `/admin/tenant-management/view/:id`, `/admin/subscriptions-billing`, `/admin/settings`, `/admin/telephony-integration`.
- Owner: `/owner/dashboard`, `/owner/agents`, `/owner/call-summary`, `/owner/order-list`, `/owner/item-management`, `/owner/printer`, `/owner/test-voice`.
- Owner settings: profile, connected email, business information/hours, subscription, privacy and help beneath `/owner/settings`.
- Public: `/`, `/termscondition`, `/privacy`, `/thank-you-contact`.

The router mounts the same `DashboardLayout` directly for both role prefixes. No route-guard component is present in this router file; navigation visibility and post-login routing are client-role-driven, while authorization is therefore expected to be enforced by the API.

## Owner portal evidence

### Dashboard

`frontend/src/pages/owner/Dashboard.jsx` presents order value/count, total/live calls, call duration, remaining subscription minutes, performance charts and printer connection warnings. `frontend/src/hooks/useOwnerDashboard.jsx` calls `/business-owner/dashboard/stats`, `/insights`, `/live`, and `/business-owner/printer`; printer state polls every five seconds.

### Orders

`frontend/src/pages/owner/OrderList.jsx` provides search, status-labelled rows, an order-detail modal, receipt download and print actions. `frontend/src/hooks/useOrderList.jsx` assumes:

- `GET /business-owner/order`
- `GET /business-owner/order/:id`
- `GET /business-owner/order/download-receipt/:id`
- `GET /business-owner/order/download/:id` for the printer action

`frontend/src/components/LiveOrderPopup.jsx` opens a Socket.IO connection derived from the API base URL, emits `join-business-room`, and accepts three event names: `order:confirmed`, `order:unconfirmed`, and `new-order`.

### Menu/item management

`frontend/src/pages/owner/ItemManagement.jsx` is a searchable/category-filtered item table with upload and delete-confirmation modals. Its hook is agent-coupled: `frontend/src/hooks/useItemManagement.jsx` first loads `/business-owner/agent`, then reads `/business-owner/item-management` with an optional `vapiAgentId` and uploads menu changes to `/business-owner/item-management/update-menu?vapiAgentId=...`. This is not compatible with the local menu DTO without a rewrite.

### Printers

`frontend/src/pages/owner/PrinterManagement.jsx` manages device name, MAC address, IP address, online status and last-seen data through add/edit/delete modals. `frontend/src/hooks/usePrinterManagement.jsx` uses CRUD at `/business-owner/printer`, downloads a platform bridge ZIP from `/business-owner/printer/download-bridge?mac=...&ip=...`, and uses the order endpoints above to print receipts. MAC/IP collection and a downloaded bridge are substantial device and security assumptions, not reusable local-browser behavior.

### Account and business settings

`frontend/src/pages/owner/Settings.jsx` supplies tabs for profile, email connection, business data/hours, subscription, privacy and help. Notable API assumptions are:

- profile read/update and avatar retrieval in `settings/ProfileSettings.jsx`, plus `/auth/change-password`;
- business info and hours in `settings/BusinessInfo.jsx`;
- connected email in `settings/ConnectEmail.jsx`;
- plans, current plan and billing history across `settings/Plan.jsx`, `CurrentPlan.jsx` and `BillingHistory.jsx`.

## Admin portal evidence

`frontend/src/pages/admin/Dashboard.jsx` combines tenant counts, subscriptions, paid invoice revenue, Vapi costs, Twilio usage and tabbed operational views for overview, call log, failed calls, printer health and provider costs. Data comes from `/system-owner/dashboard`, `/dashboard/operations` and `/dashboard/operations/live` in `frontend/src/hooks/useSystemDashboard.jsx`.

`frontend/src/pages/admin/TenantManagement.jsx` and `frontend/src/pages/admin/ViewTenant.jsx` provide tenant CRUD, suspension/status, plan and printer status, then tenant-specific agents, billing, calls and orders. The hooks call `/system-owner/tenants`, `/system-owner/individual-tenant/:id/{agents,billing,calls,orders}` and agent deletion.

`frontend/src/pages/admin/Subscription.jsx` and `frontend/src/hooks/useAdminSubscription.jsx` show plans, billings, revenue and invoice status from `/system-owner/subscription-billing/plans` and `/billings`. `frontend/src/pages/admin/Telephony.jsx` with `frontend/src/hooks/useTelephony.jsx` manages tenant telephony records through `/system-owner/telephony`. `frontend/src/pages/admin/Settings.jsx` reads and updates a system logo.

## Authentication and API assumptions

- Both Axios clients use `VITE_API_BASE_URL` (`frontend/src/hooks/useAxiosPublic.jsx`, `useAxiosSecure.jsx`). Requests also send an ngrok browser-warning bypass header, revealing an inherited tunnel-oriented development assumption.
- Login stores the bearer access token and role in JavaScript-readable cookies for seven days, and user data in local storage (`frontend/src/pages/auth/LogIn.jsx`). `frontend/src/provider/AuthProvider.jsx` restores that local user and clears cookies/local storage on logout. This differs from the local prototype's server-managed HTTP cookie authentication and must not be copied.
- The secure client injects `Authorization: Bearer ...` and the role header, then logs out on 401/403 (`useAxiosSecure.jsx`). Its interceptors are installed from inside a hook without an eject cleanup, so repeated hook mounting can accumulate interceptors.
- Auth routing trusts the API-returned role to navigate to `/admin/dashboard` or `/owner/dashboard`. The frontend sidebar also trusts the role cookie for navigation. Neither substitutes for server-side authorization.
- Password recovery carries email and OTP in React Router navigation state between screens. This is a different contract from the local prototype's fragment-token flow.
- TanStack Query supplies caching and polling; response shapes commonly assume an Axios response containing a nested `data` field. The local API shapes must remain authoritative.

## Calls, agents, subscriptions and external coupling

These are core to the original portal but outside the local food-ordering prototype's current scope:

- Vapi browser SDK: instantiated by `frontend/src/pages/owner/TestCallWindow.jsx` with a public environment key.
- Agent configuration and call reporting: `owner/AgentList.jsx`, `owner/CallSummary.jsx`, `hooks/useCallSummary.jsx`, and multiple tenant detail components.
- Provider analytics: Vapi and Twilio cost/usage components throughout the admin dashboard, including `ProviderCostsTabContent.jsx`, `ProviderCallTable.jsx`, and `TenantCallUsageSection.jsx`.
- Subscription allowances and billing: owner plan/current-plan/history pages and admin subscription billing.
- Socket.IO incoming-order channel: `components/LiveOrderPopup.jsx`.
- EmailJS public form integration: `components/EnterpriseContactModal.jsx` and `pages/landindPage/Contact.jsx` use environment-provided EmailJS identifiers.
- External connectivity probes: `hooks/useNetworkStatus.jsx` calls Google connectivity and favicon endpoints as well as the API. These are unsuitable for an offline/local-first claim.
- Hosted font requests: `frontend/index.html` loads Inter from Google Fonts.

## Inherited production and hosting references

No values from environment files or credentials are reproduced. The frontend contains these explicit service/hosting assumptions:

- `frontend/Dockerfile` supplies a build-time API default pointing at the original hosted API domain.
- `frontend/src/pages/landindPage/PrivacyPolicy.jsx` links to the original public website domain.
- `frontend/vercel.json` is an SPA rewrite configuration for Vercel-style hosting.
- `VITE_API_BASE_URL`, Vapi and EmailJS variables are required by code paths noted above.
- Socket.IO derives its origin from the API URL rather than the current same origin.
- The source references ngrok behavior in HTTP headers, Google-hosted connectivity checks/fonts, Vapi, Twilio, EmailJS and printer bridge downloads.

Those references must not be inherited into the local prototype by copying environment files, Docker defaults, public policies, or service-specific hooks.

## Minimal reusable portal integration

Do not replace the current local customer application or copy this source wholesale. After the lead freezes a target directory and API contract, the smallest sound integration is a role-specific portal shell that visually follows the reference while consuming only the existing local API.

### Reuse or reproduce selectively

- Portal information architecture: responsive sidebar/drawer, compact header, breadcrumb and content outlet.
- Visual vocabulary: dark operational shell, blue active marker, stat cards, status pills, tables, empty states and detail dialogs.
- Owner page structure: operational overview, searchable orders/detail, menu table/editor, printer/integration status, and grouped account/business settings.
- Admin page structure: overview tabs, restaurant/tenant directory and detail views, operational status, billing/ledger presentation where corresponding local endpoints exist.
- Generic presentation ideas from table, modal, offline banner and chart components, reimplemented accessibly within the chosen local frontend architecture.

### Rewrite against the local contract

- All authentication, authorization and API clients: retain same-origin HTTP cookies, current role checks, stale-request guards and local error handling.
- Owner menu management: use restaurant/menu/category/modifier/photo/import DTOs, not Vapi agent IDs or menu uploads tied to agents.
- Order events: retain current polling/in-app notification semantics unless a local Socket.IO contract is explicitly approved.
- Printer UI: expose only local print-job/status capabilities actually implemented by the API; do not request MAC/IP or offer a bridge download without a separate reviewed device contract.
- Admin tenant screens: map to restaurants, applications, readiness, orders, ledger, refunds, statements, settlements, jobs and integrations already supported locally.
- Account settings: map to current profile, sessions, verification, preferences, addresses, support, export and deletion APIs.

### Remove from the proposed first portal copy

- Agents, AI training, test calls, call summary and call-log screens.
- Vapi SDK, Vapi assistant IDs/cost reports and Twilio usage/telephony configuration.
- Subscription minute allowances, original plan checkout and inherited invoice assumptions unless a new local billing contract is approved.
- EmailJS forms, Google connectivity probes, remote fonts, ngrok headers and original production URLs.
- Original access-token cookies/local-storage identity model.
- Printer bridge download, direct MAC/IP configuration and any claim of automatic hardware printing.
- Original landing-page legal/commercial copy; local draft policies remain separate and require business/legal review.

## Decision gate before implementation

Implementation should wait for two explicit items from the lead:

1. A target directory and architecture decision: extend the current dependency-free `apps/web` UI or create a separately approved portal package. No React dependency should be added merely because the reference used React.
2. A route/DTO matrix for each copied owner/admin panel, including which existing local endpoints replace the original `/business-owner/*` and `/system-owner/*` assumptions.

Until then, the current local customer experience, original supplied emblem, working role flows, storage identifiers and API contracts should remain unchanged.
