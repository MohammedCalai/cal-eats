# Final local UI polish

The browser app now exposes the frozen final-polish API without adding providers or native-app claims.

- Customer accounts default restaurant offers to off, list and revoke sessions, and manage up to ten saved delivery addresses. Checkout copies a selected saved address into the order form; addresses are never stored in the browser draft.
- Basket drafts contain only a restaurant ID, bounded menu IDs, quantities, modifier IDs, fulfillment and timestamp. They expire after 24 hours, are scoped to the guest or signed-in account, and require an explicit Restore action after the current menu has been fetched and validated. Checkout, sign-out and account changes clear the matching draft.
- Restaurant owners see setup readiness, upload normalized JPEG photos, reorder menu items, and preview a bounded CSV before explicitly appending it. Import retries keep one idempotency key. The template header is `name,description,price,category,allergens,dietaryTags`; use `|` between multiple allergens or dietary tags.
- New-order sound is off by default, begins only after a restaurant user gesture, and runs only while the restaurant workspace is open. It does not claim push or background notifications.
- Uploaded photos are resized in the browser, re-encoded as JPEG to remove file metadata, and limited to 1 MiB before the server validates them again. The original Calai artwork is never modified.

The service worker does not cache API or media responses. All account, address, order, receipt and uploaded-photo requests remain network-only.
