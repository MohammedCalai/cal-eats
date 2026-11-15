# Cal Eats Admin

Native iPhone/Android management companion for the existing Cal-Eats business platform. It uses the independent `info.calai.caleatsadmin` application identifiers and approved Yankee1707 project `6282b87e-36ae-43bb-80b7-12d69108a411`. Customer app identity, accounts and projects are unchanged.

## Current experience

- Overview, Orders, Payouts, Manage and More navigation, with a navy/blue interface and restaurant switching.
- Overview reads actual dashboard sales/order figures, opening availability, reported device health and upcoming provider payout records. Missing evidence stays unavailable rather than appearing healthy or paid.
- Orders are view-only, with server-backed history search, status filters, UK date presets, custom inclusive date ranges and pagination. Search applies across all matching pages. Unconfirmed cards and details state “Awaiting acceptance on restaurant tablet.” Staff can inspect authorised orders; financial breakdowns require finance capability. Confirmation, rejection, preparation, ETA changes, handover and printing belong to the paired restaurant tablet. The native request policy also rejects those operational routes.
- Manage reuses the existing menu/photos/modifier, bulk-menu, hours/availability, marketing, customer-directory and conversation APIs. Marketing includes real campaign details, edits of the existing supported fields and explicit campaign ending. Active start times, ended campaigns, committed budgets and stale edits respect server constraints; benefit/audience changes require a new campaign. Capabilities come from the server's restaurant membership DTO; absent capability flags fail closed.
- Payouts reads authoritative order commission, discounts, masked bank details, payout schedules/history and provider-reported statuses. A transfer/allocation is not represented as a bank deposit. Owner-only secure bank management and report emails retain their separate permission checks.
- More contains Devices, Notifications, Support and Account. Active device incidents remain active after marking their notification read. No incident dismiss button changes physical device health.
- CSV reports are requested as email attachments through the existing durable report-email endpoint. No CSV file is downloaded or shared from this app. Uncertain delivery never automatically sends a new copy.
- Individual secure sign-in, best-effort server sign-out/push unregistration, serialized private-session storage and in-memory conversation-cache clearing are retained.

## Notifications and devices

The app uses `GET /api/restaurant/restaurants/:id/operations-health` and `PATCH /api/restaurant/incidents/:id/read`. Native business push uses `/api/native/business/push/settings` and `/api/native/business/push/devices`; it is separate from customer push. App links open view-only orders, restaurant conversations or device incidents after membership checks. Device reports are observed state, not a claim of successful physical printing.

Phone permissions, signing and the independent business project's push configuration are required before background delivery can work. The app displays an honest unavailable state when the service/project is not enabled; this source change does not configure credentials or certify delivery. Notifications use a normal one-shot system alert; the phone does not run the tablet's looping order ringtone.

Android builds accept an explicit private `CAL_EATS_ADMIN_GOOGLE_SERVICES_FILE` path. The build configuration reads and validates the file for `info.calai.caleatsadmin`; use a Firebase Android app dedicated to this business application. Supply it through private local files or an EAS file variable, never commit it. The corresponding FCM v1 credential must be connected to the independent business Expo project, and that project must be allowlisted/enabled by the Cal-Eats business push settings. Without the file the app reports Android push as unavailable. iOS likewise requires the business bundle's own APNs entitlement, signing profile and APNs credential associated with the business Expo project. Customer credentials/projects are not reused. Returning from phone Settings or receiving a native token change refreshes registration without re-prompting for permission.

## Validation and delivery

Use the workspace `typecheck`, focused Node tests and `store:check` commands. Fresh native builds, device UAT, image-picker/keyboard checks, linked push delivery, signing and store review remain separate steps. Existing test-installed builds do not receive these source changes automatically. No public production profile or publication approval is introduced here.
