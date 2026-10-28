# Fictional marketplace demonstration data

The new local database is `artifacts/business-phone-demo.sqlite`. It is separate from the normal local database, earlier preview copies, hosted data and original Calai. The source dataset lives in `scripts/lib/demo-catalog.js`; every restaurant has a visible **· Demo** suffix and a description explaining that it is fictional. All extra customer email addresses use the reserved `example.invalid` domain. No real customer or restaurant data is copied.

Run the local seeder with:

```powershell
node scripts/seed-marketplace-demo.js
```

The default target must be a new database or a database already owned by its `*.demo.json` manifest. A custom `--db` must stay under this project's `artifacts` directory. The script rejects hosted settings, Stripe-provider settings and live payments. It never loads `.env` or `.env.stripe-test`. Existing normal databases and unknown database files are refused.

The first completed seed on 28 October 2026 created:

- Twenty additional restaurants, one each for Indian, Italian, Turkish, Chinese, Thai, Japanese, Korean, Greek, Lebanese, Mexican, American, British, Caribbean, Nigerian, Ethiopian, Vietnamese, Malaysian, Spanish, Persian and Vegan cuisines.
- Eighty menu dishes (four per cuisine), including prices, descriptions, categories, illustrative allergen lists and dietary tags. This is fictional catalog content, not verified food-safety information for a real restaurant.
- Collection and restaurant-owned delivery for LU1/LU2, with a £1.99 fictional delivery fee and £5 food minimum on the new restaurants.
- Eighty additional fictional customers with new/returning/regular/lapsed ordering histories at the existing local Calai Kitchen and the new cuisine restaurants. Some allow in-app offers and some do not; VIP/follow-up labels are restaurant-specific.
- 284 simulated orders, including an active delivery, preparing and placed order. Orders, captures, 7% commission and balanced financial postings go through the application API rather than fabricated ledger inserts.
- Twenty personalised campaigns for the existing local customer, mixing free items, 15% discounts and £3 discounts. Eligible opted-in customers at each new restaurant also receive the campaign. The customer must meet its food minimum and normal offer rules.
- Nine encrypted customer-service conversations with read/unread examples and different response states; two current order-specific message threads; four restaurant-first refund cases including a voucher awaiting response, an escalation and a customer-confirmed replacement; and four routed help requests with waiting/resolved states.

The completed file used schema 24. SQLite integrity was OK, foreign-key violations were zero, and all 2,260 journal postings balanced by operation group. No real-provider card order was present. The managed manifest records entity IDs and completion steps. Existing marked records are not reset on rerun: menu/profile edits, customer labels and operator case decisions remain in place. Server-owned order and campaign idempotency keys protect financial retries. A rare interruption before a non-idempotent create response is recorded requires manual review rather than guessing ownership or overwriting an existing entity.

Local sign-ins:

| Purpose | Email | Password |
| --- | --- | --- |
| Customer with all twenty offers | customer@calai.local | LocalCustomer!4310 |
| Restaurant owner of Calai Kitchen and all twenty demo cuisines | restaurant@calai.local | LocalRestaurant!4310 |
| Platform administrator | admin@calai.local | LocalAdmin!4310 |
| Extra fictional customer 1–80 | demo.customer001@example.invalid through demo.customer080@example.invalid | DemoCustomer!4310 |

These are public local fixtures and are prohibited by the hosted-profile safety rules where reserved. The server should use local mode, `local_simulator` and the new DB explicitly; the parent run currently uses port 4314. The script itself does not start a server. Long-running application workers may advance the clearly simulated operational jobs or expire old pending orders; rerunning the seed does not reset operator or worker state. The database's message encryption key sits separately beside it and must not be committed or merged into migration exports.

## Hosted preview fictional data

The approved additive preview seed was completed on 28 October 2026: twenty Demo restaurants, eighty dishes, four fictional customers, twenty personalised offers and twenty-four completed simulated orders. Code deployment remains on hold for Railway capacity. No original Calai record was changed.

```powershell
node scripts/seed-marketplace-demo.js --hosted-plan
# Lead/operator execution only, after reviewing the plan and runtime:
node scripts/seed-marketplace-demo.js --hosted-apply --confirm-hosted-demo-only
```

The plan performs no network call. Apply mode is restricted to `https://eats.calai.info`, permits only `/api/` routes and rejects redirects. It first checks the public hosted-preview/simulated-payments guard. After administrator sign-in, it requires authenticated operational settings to explicitly prove `paymentProviderMode=local_simulator` before any catalogue or order mutation. This authenticated proof supports the older public runtime that omits provider mode; a missing or conflicting authoritative provider mode is refused. Approved business/administrator credentials are read from the ignored local access file without printing them. Four fictional customer accounts received independently generated strong passwords saved in ignored `artifacts/hosted-marketplace-demo.private.json`. None are emailed, printed or committed by this script.

Hosted apply creates the same twenty Demo restaurants and eighty dishes, approves only those newly created demo restaurants using normal setup/approval routes, creates twenty personalised free-item campaigns through the older available offer API, and places completed mock-card history using normal customer/restaurant workflows. It does not purchase infrastructure, push code or deploy. If the existing preview kitchen is pending, its approval/profile/menu remain unchanged; test-customer history goes to the first newly approved Demo restaurant instead. Choose that restaurant in the business selector to inspect its four fictional customers. If the existing kitchen was already approved and usable, only additive test-customer history is placed there. The new rich CRM/refund/help workflow fixtures remain local until their code is deployed.

Apply is resumable through its private manifest and stable server idempotency keys. Completed setup steps are not replayed to overwrite user menu/profile edits. A name collision with an unmanaged restaurant is refused. Passwords and session cookies remain private, and cookies are revoked through logout after a successful run. If an API version or account constraint prevents completion, retain the manifest and resolve that exact blocker; do not reset accounts or bypass the provider guard.
