# Customer polish and operational exports — 29 October 2026

## Customer experience

- Added the saved basket and quantity controls, with a clear keep-or-replace choice when changing restaurants. Receipt details use saved order prices, offers and refunds rather than current menu prices.
- Improved item-photo presentation, location selection and restaurant discovery. Popular restaurants use real completed-order counts from the last 30 days and remain subject to location eligibility. Free delivery requires the restaurant's configured delivery fee to be zero.
- Notifications can be marked read and the unread count updates. The Cal-Eats banner uses a 30-second animation cycle; reduced-motion preferences disable the motion.
- Customer past-order access now has a strict 90-day server gate, including direct order/receipt and linked case access. Active orders remain available, and internal owner/admin history is retained; this change does not delete historical records.
- New order-help cases also create a linked platform support conversation and queue a notification to `support@calai.info`. Restaurant remedy handling remains available. Existing cases are not backfilled. Email/provider handling was exercised with test adapters; delivery to the real support inbox is not yet verified.

## Dashboard exports

- Business owners can export operational statistics and orders for Today, Yesterday, This week or Last week. London calendar boundaries are used and weeks start Monday. Live metrics are labelled as current across all dates. The tablet dashboard and its CSVs do not display sales or earnings; existing finance tools remain separate.
- Platform administrators can export statistics, orders and restaurant summaries with the applied London From/To dates. Finance cards and exports use the same real reporting data. Current restaurant totals and live operational counts are labelled separately from period activity. Financial CSV columns identify minor currency units and provider modes.
- Exports enforce owner membership or platform-admin access. They omit customer messages, names, contact details, delivery addresses and credentials. CSVs include quoting, spreadsheet-formula protection, UTF-8 BOM, size bounds, attachment headers and minimal audit records. Genuine numeric values, including negative margins, stay numeric.
- Cal-Eats Admin can save/share actual `.csv` attachments using SDK-compatible `expo-file-system` and `expo-sharing`. Files are written as bounded UTF-8 CSVs in private cache, with sanitised unique filenames and CSV MIME/UTI metadata. Tokens remain in request headers. Temporary files are cleaned after sharing; Android has a private-cache grace period for recipient access plus stale-file cleanup. Sharing on physical devices remains to be verified in a new native build.

## Verification

- Passed: 7 customer web-helper checks, 4 focused backend checks and 8 support-focused checks, including tenant/privacy boundaries and date handling.
- Both native TypeScript checks and the portal production build passed. Release packaging checked 126 JavaScript files and 24 required files.
- Browser walkthrough verified saved-basket restoration, quantity changes, switching restaurants while keeping the existing basket, the receipt modal, and a notification read count changing from 57 to 56.
- Local HTTP checks downloaded all five dashboard CSV variants with status 200 and attachment headers. A focused regression also matched date-filtered CSV financial totals to the actual admin finance API and preserved negative numeric margins.

## Deployment limits

Apple membership remains Pending, blocking signing and TestFlight. No new native binary was created in this phase; source changes require a new build before phone testing. Configuration, helper tests and browser checks do not establish physical-device behaviour or public-store approval. Live payments, background push and previously documented release gates remain separate work.
