# Local operation and future deployment

This milestone runs only on loopback HTTP. `NODE_ENV=production` and non-loopback hosts are rejected deliberately. Nothing is deployed. Do not remove these guards to publish this demo.

## Local configuration
`CALAI_HOST=127.0.0.1`, `CALAI_PORT=4310`, `CALAI_ORIGIN=http://127.0.0.1:4310`, `CALAI_DB_PATH=data/calai-eats.sqlite`. Defaults work without environment variables. Set variables through the invoking environment; no secret file is required. Keep SQLite files, WAL files and future credentials out of Git. Do not put real customer information into the seeded local demo. Shut down cleanly before copying a database for a simple local backup.

## Provider boundaries
Payment provider is a deterministic mock with no card data and no external requests. Cash states are manual bookkeeping confirmations. Delivery eligibility is configured postcode coverage, not a courier or route service; a restaurant advances the delivery status manually. Receipt output is printable HTML. No printer daemon, SMS, email, map or dispatch service is active.

## Before a separately authorized sandbox integration
Confirm the missing product specification, currency/market, delivery coverage and fees, commission base/timing, refund policy and taxes. Implement provider adapters, webhook verification, event replay protection, compensation/refund tests and reconciliation with sandbox credentials that belong only to Calai Eats. Never infer Stripe sandbox verification from a successful mock payment.

## Before a separately authorized production release
Use managed secret storage, HTTPS/Secure cookies, verified public Origin/Host policy, CSRF tests, persistent distributed throttling, account verification/recovery, audit and retention policy, automated backups with a restore test, operational monitoring, validated multi-process database architecture, migration rollback/recovery plan and comprehensive payment/tenant security review. Replace known demo accounts; do not copy the demo database. Verify accessibility, mobile requirements and actual receipt obligations for the chosen market.

Provisioning billable services, live payments, DNS, GitHub pushes/Actions, Expo EAS and store submissions remain prohibited under the current authorization. These notes prepare later work; they do not authorize it.
